// YAN-426: custom date range for usage stats/chart. `custom` stays out of
// PERIOD_VALUES; ranges are inclusive local day keys read from usageRollup only.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import { upsertRollupRowUnscoped } from "@/lib/db/repos/usageRollupRepo.js";
import { getRollupRangeTotals } from "@/lib/db/repos/usageRollupTotals.js";
import { getChartData, getUsageStats } from "@/lib/db/repos/usageStatsRepo.js";
import {
  CUSTOM_PERIOD,
  MAX_CUSTOM_RANGE_DAYS,
  PERIOD_VALUES,
  QUIET_COPY,
  isCustomPeriod,
  isPeriod,
  localTodayKey,
  parseDateRange,
  periodStart,
  shiftDateKey,
} from "@/shared/utils/period.js";

const TODAY = "2026-09-30";

describe("parseDateRange", () => {
  let prevTz;
  // DST zone so span/day counting is not vacuous on UTC CI.
  beforeAll(() => {
    prevTz = process.env.TZ;
    process.env.TZ = "America/New_York";
  });
  afterAll(() => {
    if (prevTz === undefined) delete process.env.TZ;
    else process.env.TZ = prevTz;
  });

  it("keeps custom out of the named periods", () => {
    expect(CUSTOM_PERIOD).toBe("custom");
    expect(isCustomPeriod("custom")).toBe(true);
    expect(isCustomPeriod("7d")).toBe(false);
    expect(isPeriod("custom")).toBe(false);
    expect(PERIOD_VALUES).not.toContain("custom");
    expect(() => periodStart("custom")).toThrow(/Unknown period/);
    expect(QUIET_COPY.custom.title).toBe("No requests in this date range");
  });

  it("accepts a single day and returns the inclusive day count", () => {
    expect(parseDateRange("2026-09-10", "2026-09-10", TODAY)).toEqual({
      ok: true,
      from: "2026-09-10",
      to: "2026-09-10",
      days: 1,
    });
    expect(parseDateRange("2026-09-01", "2026-09-30", TODAY)).toMatchObject({ ok: true, days: 30 });
  });

  it.each([
    [undefined, "2026-09-10", "range_missing", "Choose a start and end date"],
    ["2026-09-10", "", "range_missing", "Choose a start and end date"],
    ["2026-9-1", "2026-09-10", "range_format", "Dates must be valid YYYY-MM-DD days"],
    ["2026-02-30", "2026-03-01", "range_format", "Dates must be valid YYYY-MM-DD days"],
    ["2026-09-10", "2026-09-09", "range_order", "Start date must be on or before end date"],
    ["2026-09-10", "2026-10-01", "range_future", "End date can't be in the future"],
  ])("rejects %s..%s as %s", (from, to, reason, message) => {
    expect(parseDateRange(from, to, TODAY)).toEqual({ ok: false, reason, message });
  });

  it("allows exactly 366 days and rejects 367", () => {
    expect(MAX_CUSTOM_RANGE_DAYS).toBe(366);
    // 2025-09-30 .. 2026-09-30 is 366 inclusive days (spans a leap-free year).
    expect(parseDateRange("2025-09-30", "2026-09-30", TODAY)).toMatchObject({
      ok: true,
      days: 366,
    });
    expect(parseDateRange("2025-09-29", "2026-09-30", TODAY)).toEqual({
      ok: false,
      reason: "range_span",
      message: "Range can't be longer than 366 days",
    });
  });

  it("handles leap day and DST-crossing spans by calendar days", () => {
    expect(parseDateRange("2024-02-29", "2024-02-29", TODAY)).toMatchObject({ ok: true, days: 1 });
    expect(parseDateRange("2024-02-28", "2024-03-01", TODAY)).toMatchObject({ ok: true, days: 3 });
    // Spans both US DST transitions (Mar 8 and Nov 1, 2026).
    expect(parseDateRange("2026-03-01", "2026-11-10", "2026-12-01")).toMatchObject({
      ok: true,
      days: 255,
    });
    expect(shiftDateKey("2026-03-07", 2)).toBe("2026-03-09");
    expect(shiftDateKey("2026-11-02", -2)).toBe("2026-10-31");
  });

  it("localTodayKey formats the local day", () => {
    expect(localTodayKey(new Date(2026, 0, 5, 23, 59).getTime())).toBe("2026-01-05");
  });
});

describe("custom range stats + chart routes", () => {
  let db;
  const today = localTodayKey();
  const dayKey = (n) => shiftDateKey(today, -n);
  const url = (route, query) => `http://localhost/api/usage/${route}?${query}`;
  const seed = (n, requests) =>
    upsertRollupRowUnscoped(
      db,
      { dateKey: dayKey(n), provider: "openai", model: "gpt-x", endpoint: "/v1/chat/completions" },
      { requests, tokensIn: requests * 10, tokensOut: requests, cost: requests },
    );

  beforeEach(async () => {
    db = await getAdapter();
    db.exec("DELETE FROM usageHistory; DELETE FROM usageRollup");
    // Days ago: 1->1, 3->2, 5->4 (window), 2 -> 8 (inside), 6->16 / 7->32 (previous), 10->64 (outside)
    for (const [n, r] of [
      [1, 1],
      [3, 2],
      [5, 4],
      [6, 16],
      [7, 32],
      [10, 64],
    ]) {
      seed(n, r);
    }
  });

  it.each([
    ["period=custom", "range_missing"],
    ["period=custom&from=2026-09-10", "range_missing"],
    ["period=custom&from=nope&to=2026-09-10", "range_format"],
    ["period=custom&from=2026-09-10&to=2026-09-01", "range_order"],
    ["period=custom&from=2026-09-01&to=2999-01-01", "range_future"],
    ["period=custom&from=2000-01-01&to=2001-01-01", "range_span"],
  ])("both routes 400 with the typed shape for %s", async (query, reason) => {
    const { GET: stats } = await import("../../src/app/api/usage/stats/route.js");
    const { GET: chart } = await import("../../src/app/api/usage/chart/route.js");
    for (const [GET, route] of [
      [stats, "stats"],
      [chart, "chart"],
    ]) {
      const res = await GET(new Request(url(route, query)));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: expect.any(String),
        code: "invalid_request",
        reason,
      });
    }
  });

  it("stats totals sum only the days inside the range, with echo + previous window", async () => {
    const { GET } = await import("../../src/app/api/usage/stats/route.js");
    // Window: 5..1 days ago (5 days) -> requests 4 + 2 + 1 = 7; previous: 10..6 days ago -> 16+32+64.
    const query = `period=custom&from=${dayKey(5)}&to=${dayKey(1)}&compare=previous`;
    const res = await GET(new Request(url("stats", query)));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.range).toEqual({ from: dayKey(5), to: dayKey(1), days: 5 });
    expect(data.totalRequests).toBe(7);
    expect(data.totalPromptTokens).toBe(70);
    expect(data.currentTotals).toMatchObject({ requests: 7, promptTokens: 70, cost: 7 });
    expect(data.previous).toMatchObject({ requests: 112, promptTokens: 1120 });

    const plain = await GET(
      new Request(url("stats", `period=custom&from=${dayKey(5)}&to=${dayKey(1)}`)),
    );
    const plainData = await plain.json();
    expect(plainData).not.toHaveProperty("previous");
    expect(plainData.totalRequests).toBe(7);
  });

  it("excludes days outside both ends (single-day range)", async () => {
    const { GET } = await import("../../src/app/api/usage/stats/route.js");
    const res = await GET(
      new Request(url("stats", `period=custom&from=${dayKey(3)}&to=${dayKey(3)}`)),
    );
    expect((await res.json()).totalRequests).toBe(2);
  });

  it("chart: one daily bucket per day in range", async () => {
    const { GET } = await import("../../src/app/api/usage/chart/route.js");
    const res = await GET(
      new Request(url("chart", `period=custom&from=${dayKey(6)}&to=${dayKey(1)}`)),
    );
    expect(res.status).toBe(200);
    const buckets = await res.json();
    expect(buckets).toHaveLength(6);
    expect(buckets.map((b) => b.requests)).toEqual([16, 4, 0, 2, 0, 1]);
    expect(buckets[1]).toMatchObject({ input: 40, output: 4, tokens: 44, cost: 4 });
  });

  it("chart: spans over 92 days use coarser buckets and keep totals", async () => {
    const { GET } = await import("../../src/app/api/usage/chart/route.js");
    const from = shiftDateKey(today, -200);
    const res = await GET(new Request(url("chart", `period=custom&from=${from}&to=${today}`)));
    const buckets = await res.json();
    expect(buckets.length).toBeLessThan(201);
    expect(buckets.length).toBeGreaterThan(1);
    expect(buckets.reduce((s, b) => s + b.requests, 0)).toBe(1 + 2 + 4 + 16 + 32 + 64);
  });

  it("routes tolerate `to` one day past server today, but not two", async () => {
    const { GET: stats } = await import("../../src/app/api/usage/stats/route.js");
    const { GET: chart } = await import("../../src/app/api/usage/chart/route.js");
    const from = dayKey(1);
    for (const [GET, route] of [
      [stats, "stats"],
      [chart, "chart"],
    ]) {
      const ok = await GET(
        new Request(url(route, `period=custom&from=${from}&to=${shiftDateKey(today, 1)}`)),
      );
      expect(ok.status).toBe(200);
      const bad = await GET(
        new Request(url(route, `period=custom&from=${from}&to=${shiftDateKey(today, 2)}`)),
      );
      expect(bad.status).toBe(400);
      expect((await bad.json()).reason).toBe("range_future");
    }
    // The client-side default stays strict.
    expect(parseDateRange(from, shiftDateKey(today, 1), today).reason).toBe("range_future");
  });

  it("existing named periods still reject unknown values", async () => {
    const { GET } = await import("../../src/app/api/usage/stats/route.js");
    const res = await GET(new Request(url("stats", "period=bogus")));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid period" });
  });
});

describe("custom range respects usage scope", () => {
  const today = localTodayKey();
  const day = shiftDateKey(today, -2);

  it("stats, chart and range totals exclude the other workspace", async () => {
    const db = await getAdapter();
    db.exec("DELETE FROM usageHistory; DELETE FROM usageRollup");
    for (const [workspaceId, model, requests] of [
      ["ws-a", "model-a", 3],
      ["ws-b", "model-b", 100],
    ]) {
      for (const dateKey of [day, shiftDateKey(day, -10)]) {
        upsertRollupRowUnscoped(
          db,
          { dateKey, workspaceId, provider: "openai", model, endpoint: "/v1/chat/completions" },
          { requests, tokensIn: requests * 10, tokensOut: requests, cost: requests },
        );
      }
    }
    const ctx = { workspaceId: "ws-a" };
    const range = { from: shiftDateKey(day, -1), to: today };

    const stats = await getUsageStats(ctx, "custom", range);
    expect(stats.totalRequests).toBe(3);
    expect(Object.keys(stats.byModel)).toEqual(["model-a (openai)"]);

    const chart = await getChartData(ctx, "custom", range);
    expect(chart.reduce((s, b) => s + b.requests, 0)).toBe(3);

    const totals = await getRollupRangeTotals(ctx, { from: day, to: day });
    expect(totals.currentTotals.requests).toBe(3);
    // previous = the single day before `day` (empty); the -10d row is outside it.
    expect(totals.previous.requests).toBe(0);
    const wide = await getRollupRangeTotals(ctx, { from: shiftDateKey(day, -10), to: day });
    expect(wide.currentTotals.requests).toBe(6);
    expect(wide.previous.requests).toBe(0);

    // Unscoped sees both workspaces (control: the scope filter is what isolates).
    expect((await getUsageStats(null, "custom", range)).totalRequests).toBe(103);
  });
});
