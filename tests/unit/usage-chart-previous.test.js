// YAN-1235: previous-period overlay on /api/usage/chart (compare=previous).
// The previous equal-length window is shifted forward by the window length
// and folded into the CURRENT bucket skeleton, so bucket i's `previous`
// always covers the same relative slice. Runs in a DST zone so the
// calendar-day math is not vacuous on UTC CI.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import { upsertRollupRowUnscoped } from "@/lib/db/repos/usageRollupRepo.js";
import { saveRequestUsageUnscoped } from "@/lib/db/repos/usageRepo.js";
import { getChartData } from "@/lib/db/repos/usageStatsRepo.js";
import { customChartBuckets } from "@/lib/usage/customRange.js";
import {
  previousDayRange,
  previousDaySeries,
  previousHourSeries,
  previousHourWindow,
} from "@/lib/usage/previousBuckets.js";
import { periodStart, shiftDateKey } from "@/shared/utils/period.js";

const HOUR = 3600000;
let prevTz;
beforeAll(() => {
  prevTz = process.env.TZ;
  process.env.TZ = "America/New_York";
});
afterAll(() => {
  if (prevTz === undefined) delete process.env.TZ;
  else process.env.TZ = prevTz;
});

const row = (dateKey, requests) => ({
  dateKey,
  requests,
  tokensIn: requests * 10,
  tokensCached: 0,
  tokensOut: requests,
  cost: requests,
});
const point = (t) => ({ t, input: 10, cached: 2, output: 3, cost: 0.5 });

describe("day-window alignment", () => {
  it("previous window is the same day count ending the day before `from`", () => {
    expect(previousDayRange({ from: "2026-09-24", to: "2026-09-30" })).toEqual({
      from: "2026-09-17",
      to: "2026-09-23",
      shiftDays: 7,
    });
    // Crosses the Nov 1 fall-back: still whole calendar days.
    expect(previousDayRange({ from: "2026-11-01", to: "2026-11-07" })).toEqual({
      from: "2026-10-25",
      to: "2026-10-31",
      shiftDays: 7,
    });
  });

  it("day grain: previous day i lands on current bucket i", () => {
    const range = { from: "2026-11-01", to: "2026-11-07" };
    const prev = previousDaySeries([row("2026-10-25", 1), row("2026-10-31", 4)], range);
    expect(prev).toHaveLength(7);
    expect(prev.map((p) => p.requests)).toEqual([1, 0, 0, 0, 0, 0, 4]);
    expect(prev[6]).toEqual({ input: 40, cached: 0, output: 4, tokens: 44, cost: 4, requests: 4 });
  });

  it("week grain (>92 days): previous buckets share the current skeleton", () => {
    const range = { from: "2026-01-01", to: "2026-06-30" }; // 181 days
    const { from, to } = previousDayRange(range);
    expect([from, to]).toEqual(["2025-07-04", "2025-12-31"]);
    const current = customChartBuckets([], range);
    expect(current[0].grain).toBe("week");
    const prev = previousDaySeries([row(from, 1), row(to, 2), row("2025-07-10", 8)], range);
    expect(prev).toHaveLength(current.length);
    // First previous day -> first bucket; last previous day -> last bucket.
    expect(prev[0].requests).toBe(1);
    expect(prev.at(-1).requests).toBe(2);
    // 2025-07-10 + 181 days = 2026-01-07 (Wed) -> week of Mon 2026-01-05 = bucket 1.
    expect(current[1].start).toBe("2026-01-05");
    expect(prev[1].requests).toBe(8);
    expect(prev.reduce((s, p) => s + p.requests, 0)).toBe(11);
  });
});

describe("hour-window alignment", () => {
  it("24h: preceding rolling 24h, shifted onto the current hour slots", () => {
    const now = new Date(2026, 8, 30, 10, 30).getTime();
    const win = previousHourWindow("24h", now);
    expect(win).toEqual({ start: now - 48 * HOUR, end: now - 24 * HOUR, comparable: 24 });
    const slots = previousHourSeries(
      [
        point(win.start + 30 * 60000), // slot 0
        point(win.end - 1), // slot 23
        point(win.end), // current window: excluded
        point(win.start - 1), // before: excluded
      ],
      win,
    );
    expect(slots[0]).toEqual({
      input: 10,
      cached: 2,
      output: 3,
      tokens: 13,
      cost: 0.5,
      requests: 1,
    });
    expect(slots[23].requests).toBe(1);
    expect(slots.reduce((s, p) => s + p.requests, 0)).toBe(2);
  });

  it("today: yesterday clipped to the elapsed slice; later hours are null", () => {
    const now = new Date(2026, 8, 30, 10, 30).getTime();
    const win = previousHourWindow("today", now);
    expect(win.start).toBe(new Date(2026, 8, 29).getTime());
    expect(win.end).toBe(new Date(2026, 8, 29, 10, 30).getTime());
    expect(win.comparable).toBe(11); // hours 0..10 (10 is partially elapsed)
    const slots = previousHourSeries(
      [
        point(new Date(2026, 8, 29, 10, 15).getTime()), // slot 10
        point(new Date(2026, 8, 29, 10, 45).getTime()), // after the slice
        point(new Date(2026, 8, 29, 22).getTime()),
      ],
      win,
    );
    expect(slots[10].requests).toBe(1);
    expect(slots[0].requests).toBe(0);
    expect(slots.slice(11)).toEqual(Array(13).fill(null));
  });

  it("today after a DST day: yesterday starts at its local midnight, not now-24h", () => {
    // Nov 1 2026 (fall back) is 25 hours long.
    const now = new Date(2026, 10, 2, 5).getTime();
    const win = previousHourWindow("today", now);
    expect(win.start).toBe(new Date(2026, 10, 1).getTime());
    expect(win.start).toBe(periodStart("today", now) - 25 * HOUR);
    expect(win.end - win.start).toBe(5 * HOUR);
    expect(win.comparable).toBe(5);
    const slots = previousHourSeries([point(new Date(2026, 10, 1, 0, 30).getTime())], win);
    expect(slots[0].requests).toBe(1);
  });

  it("today on a 25-hour fall-back day never overlaps the current window", () => {
    // Nov 1 2026 23:30 local is 24.5h after midnight; a 24h yesterday must stop at today's midnight.
    const now = new Date(2026, 10, 1, 23, 30).getTime();
    const midnight = periodStart("today", now);
    const win = previousHourWindow("today", now);
    expect(win.start).toBe(new Date(2026, 9, 31).getTime());
    expect(win.end).toBe(midnight);
    expect(win.comparable).toBe(24);
    const slots = previousHourSeries(
      [point(midnight - 1), point(midnight + 15 * 60000)], // last instant of yesterday; today
      win,
    );
    expect(slots.reduce((s, p) => s + p.requests, 0)).toBe(1);
    expect(slots[23].requests).toBe(1);
  });

  it("today after a 23-hour spring-forward yesterday: slot 23 has no previous", () => {
    // Mar 8 2026 (spring forward) is 23 hours long; Mar 9 23:30 is 23.5h after midnight.
    const now = new Date(2026, 2, 9, 23, 30).getTime();
    const win = previousHourWindow("today", now);
    expect(win.start).toBe(new Date(2026, 2, 8).getTime());
    expect(win.end).toBe(periodStart("today", now));
    expect(win.end - win.start).toBe(23 * HOUR);
    expect(win.comparable).toBe(23);
    const slots = previousHourSeries([point(win.end - 1)], win);
    expect(slots[22].requests).toBe(1);
    expect(slots[23]).toBeNull();
  });
});

describe("chart route compare=previous", () => {
  const today = "2026-09-30";
  const url = (query) => `http://localhost/api/usage/chart?${query}`;
  let db;
  const get = async (query) => {
    const { GET } = await import("../../src/app/api/usage/chart/route.js");
    return GET(new Request(url(query)));
  };

  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 30, 10, 30));
  });
  afterAll(() => vi.useRealTimers());

  beforeEach(async () => {
    db = await getAdapter();
    db.exec("DELETE FROM usageHistory; DELETE FROM usageRollup");
    for (const [n, requests] of [
      [0, 1], // current last day
      [7, 2], // previous last day -> current last bucket
      [13, 4], // previous first day -> current first bucket
      [14, 64], // outside both windows
    ]) {
      upsertRollupRowUnscoped(
        db,
        {
          dateKey: shiftDateKey(today, -n),
          provider: "openai",
          model: "gpt-x",
          endpoint: "/v1/chat/completions",
        },
        { requests, tokensIn: requests * 10, tokensOut: requests, cost: requests },
      );
    }
  });

  it("rejects an unknown compare value", async () => {
    const res = await get("period=7d&compare=next");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid compare" });
  });

  it("without compare the buckets carry no previous field", async () => {
    const buckets = await (await get("period=7d")).json();
    expect(buckets.some((b) => "previous" in b)).toBe(false);
  });

  it("7d: previous days align index for index", async () => {
    const buckets = await (await get("period=7d&compare=previous")).json();
    expect(buckets).toHaveLength(7);
    expect(buckets.map((b) => b.previous.requests)).toEqual([4, 0, 0, 0, 0, 0, 2]);
    expect(buckets[6].previous).toEqual({
      input: 20,
      cached: 0,
      output: 2,
      tokens: 22,
      cost: 2,
      requests: 2,
    });
    expect(buckets[6].requests).toBe(1);
  });

  it("custom: previous = equal span before `from`", async () => {
    const from = shiftDateKey(today, -6);
    const buckets = await (
      await get(`period=custom&from=${from}&to=${today}&compare=previous`)
    ).json();
    expect(buckets.map((b) => b.previous.requests)).toEqual([4, 0, 0, 0, 0, 0, 2]);
  });

  it("all: no previous window, no previous field", async () => {
    const buckets = await (await get("period=all&compare=previous")).json();
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets.some((b) => "previous" in b)).toBe(false);
  });

  it("custom >92 days: previous has one entry per (week) bucket", async () => {
    const from = shiftDateKey(today, -199);
    const buckets = await (
      await get(`period=custom&from=${from}&to=${today}&compare=previous`)
    ).json();
    expect(buckets[0].grain).toBe("week");
    expect(buckets.every((b) => b.previous && typeof b.previous.requests === "number")).toBe(true);
    expect(buckets.map((b) => b.previous)).toHaveLength(buckets.length);
    // Current 200 days hold every seeded row; the previous 200 days hold none.
    expect(buckets.reduce((s, b) => s + b.requests, 0)).toBe(1 + 2 + 4 + 64);
    expect(buckets.reduce((s, b) => s + b.previous.requests, 0)).toBe(0);
  });

  it("today and 24h fold history into the current hour buckets", async () => {
    const save = (date) =>
      saveRequestUsageUnscoped({
        provider: "openai",
        model: "gpt-x",
        tokens: { prompt_tokens: 100, completion_tokens: 50 },
        endpoint: "/v1/chat/completions",
        status: "ok",
        timestamp: date.toISOString(),
      });
    await save(new Date(2026, 8, 29, 9, 15)); // yesterday, inside the elapsed slice
    await save(new Date(2026, 8, 29, 11, 0)); // yesterday, after the slice
    await save(new Date(2026, 8, 30, 8, 0)); // today

    const todayBuckets = await (await get("period=today&compare=previous")).json();
    expect(todayBuckets[8].requests).toBe(1);
    expect(todayBuckets[9].previous).toMatchObject({ requests: 1, tokens: 150 });
    expect(todayBuckets[10].previous).toMatchObject({ requests: 0 });
    expect(todayBuckets[11].previous).toBeNull();

    // 24h: current window starts 2026-09-29 10:30 (holds the 11:00 and today rows);
    // previous is [2026-09-28 10:30, 2026-09-29 10:30) and holds only 09:15,
    // 22h45m after the previous start -> slot 22.
    const rolling = await (await get("period=24h&compare=previous")).json();
    expect(rolling.reduce((s, b) => s + b.previous.requests, 0)).toBe(1);
    expect(rolling[22].previous.requests).toBe(1);
  });

  it("today on a 25-hour fall-back day keeps the 25th hour in slot 23", async () => {
    vi.setSystemTime(new Date(2026, 10, 1, 23, 45));
    try {
      await saveRequestUsageUnscoped({
        provider: "openai",
        model: "gpt-x",
        tokens: { prompt_tokens: 100, completion_tokens: 50 },
        endpoint: "/v1/chat/completions",
        status: "ok",
        timestamp: new Date(2026, 10, 1, 23, 15).toISOString(), // 24h15m after midnight
      });
      const buckets = await getChartData(null, "today", null, { compare: "previous" });
      expect(buckets).toHaveLength(24);
      expect(buckets[23].requests).toBe(1);
      expect(buckets.reduce((s, b) => s + b.requests, 0)).toBe(1);
      // The whole of 24-hour yesterday (Oct 31) is comparable.
      expect(buckets.every((b) => b.previous !== null)).toBe(true);
    } finally {
      vi.setSystemTime(new Date(2026, 8, 30, 10, 30));
    }
  });

  it("a failed previous read returns the current buckets without `previous`", async () => {
    const original = db.all.bind(db);
    // Only the previous-window rollup read is bounded on both ends (`dateKey <= ?`).
    const spy = vi.spyOn(db, "all").mockImplementation((sql, params) => {
      if (sql.includes("dateKey <= ?")) throw new Error("boom");
      return original(sql, params);
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const buckets = await getChartData(null, "7d", null, { compare: "previous" });
      expect(buckets).toHaveLength(7);
      expect(buckets.at(-1).requests).toBe(1);
      expect(buckets.some((b) => "previous" in b)).toBe(false);
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      errors.mockRestore();
    }
  });

  it("previous counts only rows inside the usage scope (7d rollup, 24h history)", async () => {
    const at = new Date().toISOString();
    for (const w of ["ws-a", "ws-b"]) {
      db.run(
        "INSERT OR IGNORE INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES (?, ?, 'shared', ?, ?)",
        [w, w, at, at],
      );
    }
    db.exec("DELETE FROM usageHistory; DELETE FROM usageRollup");
    for (const [workspaceId, requests] of [
      ["ws-a", 3],
      ["ws-b", 100],
    ]) {
      upsertRollupRowUnscoped(
        db,
        {
          dateKey: shiftDateKey(today, -8),
          workspaceId,
          provider: "openai",
          model: "gpt-x",
          endpoint: "/v1/chat/completions",
        },
        { requests, tokensIn: requests * 10, tokensOut: requests, cost: requests },
      );
      for (let i = 0; i < (workspaceId === "ws-a" ? 1 : 5); i++) {
        await saveRequestUsageUnscoped({
          workspaceId,
          provider: "openai",
          model: "gpt-x",
          tokens: { prompt_tokens: 10, completion_tokens: 5 },
          endpoint: "/v1/chat/completions",
          status: "ok",
          timestamp: new Date(2026, 8, 28, 12).toISOString(), // previous 24h window
        });
      }
    }
    const ctx = { workspaceId: "ws-a" };
    const week = await getChartData(ctx, "7d", null, { compare: "previous" });
    // 8 days ago (09-22) = previous day index 5, shifted +7 -> current bucket 5 (09-29).
    expect(week.map((b) => b.previous.requests)).toEqual([0, 0, 0, 0, 0, 3, 0]);
    const rolling = await getChartData(ctx, "24h", null, { compare: "previous" });
    expect(rolling.reduce((s, b) => s + b.previous.requests, 0)).toBe(1);
    // Control: unscoped sees both workspaces.
    const all = await getChartData(null, "24h", null, { compare: "previous" });
    expect(all.reduce((s, b) => s + b.previous.requests, 0)).toBe(6);
  });
});
