// YAN-421: 90d and All time read usageRollup only (no usageHistory scans beyond
// the bounded recentRequests / last10Minutes reads), and the all-time chart
// buckets stay weekly/monthly/yearly with at most ~100 points.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import {
  getChartData,
  getRollupUsageTotals,
  getUsageStats,
} from "@/lib/db/repos/usageStatsRepo.js";
import { saveRequestUsageUnscoped } from "@/lib/db/repos/usageRepo.js";
import { buildAllTimeBuckets } from "@/lib/usage/allTimeBuckets.js";

const row = (dateKey, over = {}) => ({
  dateKey,
  requests: 1,
  tokensIn: 10,
  tokensOut: 5,
  tokensCached: 0,
  cost: 0.5,
  ...over,
});

describe("buildAllTimeBuckets", () => {
  let today; // Wed 2026-09-30, built after the TZ pin
  let prevTz;
  // Pin a DST zone so the DST case is not vacuous on UTC CI (Node re-reads TZ at runtime).
  beforeAll(() => {
    prevTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    today = new Date(2026, 8, 30, 12);
  });
  afterAll(() => {
    if (prevTz === undefined) delete process.env.TZ;
    else process.env.TZ = prevTz;
  });

  it("runs in a DST zone (precondition)", () => {
    expect(new Date(2026, 2, 8, 12).getTimezoneOffset()).toBe(240); // EDT
    expect(new Date(2026, 0, 8, 12).getTimezoneOffset()).toBe(300); // EST
  });

  it("returns one zero bucket for the current week when empty", () => {
    const out = buildAllTimeBuckets([], today);
    expect(out).toEqual([
      { label: "Sep 28", input: 0, cached: 0, output: 0, tokens: 0, cost: 0, requests: 0 },
    ]);
  });

  it("buckets weekly (Monday start) with the daily-path token shape", () => {
    const out = buildAllTimeBuckets(
      [
        row("2026-09-20", { tokensIn: 3, tokensCached: 8 }), // Sunday -> week of Sep 14
        row("2026-09-21"), // Monday -> week of Sep 21
        row("2026-09-27"), // Sunday -> week of Sep 21
        row("2026-09-30"),
      ],
      today,
    );
    expect(out.map((b) => b.label)).toEqual(["Sep 14", "Sep 21", "Sep 28"]);
    expect(out[0]).toMatchObject({ input: 8, cached: 8, output: 5, tokens: 13, requests: 1 });
    expect(out[1]).toMatchObject({ requests: 2, tokens: 30, cost: 1 });
    expect(out[2].requests).toBe(1);
  });

  it("adds the year to weekly labels when the span crosses a year", () => {
    const out = buildAllTimeBuckets([row("2025-12-29")], today);
    expect(out[0].label).toBe("Dec 29, 2025");
    expect(out.length).toBeLessThanOrEqual(98);
  });

  it("switches to monthly buckets past 98 weeks", () => {
    const out = buildAllTimeBuckets([row("2024-01-15"), row("2026-09-02")], today);
    expect(out[0].label).toBe("Jan 2024");
    expect(out.at(-1).label).toBe("Sep 2026");
    expect(out).toHaveLength(33);
    expect(out[0].requests).toBe(1);
    expect(out.at(-1).requests).toBe(1);
  });

  it("keeps exactly 98 weeks weekly and 99 weeks monthly", () => {
    const k = (d) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const start = new Date(2026, 8, 28);
    start.setDate(start.getDate() - 97 * 7);
    const weekly = buildAllTimeBuckets([row(k(start))], today);
    expect(weekly).toHaveLength(98);
    expect(weekly[0].label).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
    start.setDate(start.getDate() - 7);
    const monthly = buildAllTimeBuckets([row(k(start))], today); // Nov 2024 .. Sep 2026
    expect(monthly).toHaveLength(23);
    for (const b of monthly) expect(b.label).toMatch(/^[A-Z][a-z]{2} \d{4}$/);
    expect(monthly[0].requests).toBe(1);
  });

  it("goes yearly past 100 months and never exceeds 100 points", () => {
    const m100 = buildAllTimeBuckets([row("2018-06-15")], today);
    expect(m100).toHaveLength(100);
    expect(m100[0].label).toBe("Jun 2018");
    const y = buildAllTimeBuckets([row("2018-05-15"), row("2020-03-01")], today);
    expect(y.map((b) => b.label)).toEqual([
      "2018",
      "2019",
      "2020",
      "2021",
      "2022",
      "2023",
      "2024",
      "2025",
      "2026",
    ]);
    expect(y[0].requests).toBe(1);
    expect(y[2].requests).toBe(1);
    const decade = buildAllTimeBuckets([row("2016-01-15")], today);
    expect(decade).toHaveLength(11);
    expect(decade[0].label).toBe("2016");
  });

  it("clamps rows outside the bucket range into the edge buckets", () => {
    const out = buildAllTimeBuckets([row("2026-09-21"), row("2026-10-05")], today);
    expect(out.map((b) => b.label)).toEqual(["Sep 21", "Sep 28"]);
    expect(out[1].requests).toBe(1); // future-dated row lands in the last bucket
    const yearly = buildAllTimeBuckets([row("2016-01-15"), row("2027-02-01")], today);
    expect(yearly.at(-1).label).toBe("2026");
    expect(yearly.at(-1).requests).toBe(1);
  });

  it("never throws when every row is future-dated or malformed", () => {
    const sunday = new Date(2026, 8, 27, 12);
    const future = buildAllTimeBuckets([row("2026-09-28")], sunday);
    expect(future.map((b) => b.label)).toEqual(["Sep 21"]);
    expect(future[0].requests).toBe(1);
    const bad = buildAllTimeBuckets([row("garbage")], today);
    expect(bad).toHaveLength(1);
    expect(bad[0].requests).toBe(1);
  });

  it("is DST-safe: every week boundary lands on a distinct Monday", () => {
    // Spans both US DST transitions.
    const out = buildAllTimeBuckets(
      [row("2026-01-05"), row("2026-03-09"), row("2026-11-16")],
      new Date(2026, 10, 20, 12),
    );
    const labels = out.map((b) => b.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels[0]).toBe("Jan 5");
    expect(out).toHaveLength(46);
    for (const label of labels) expect(new Date(`${label}, 2026`).getDay()).toBe(1);
    expect(out.find((b) => b.label === "Mar 9").requests).toBe(1);
    expect(out.find((b) => b.label === "Nov 16").requests).toBe(1);
  });
});

describe("90d / all read usageRollup only", () => {
  let db;
  const day = (n) => {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - n);
    return d.toISOString();
  };

  beforeEach(async () => {
    db = await getAdapter();
    db.exec("DELETE FROM usageHistory; DELETE FROM usageRollup");
    for (const [n, tokens] of [
      [1, 10],
      [50, 20],
      [80, 30],
      [120, 40], // outside 90d, inside previous 90d window
      [300, 50], // only in all
    ]) {
      await saveRequestUsageUnscoped({
        provider: "openai",
        model: "gpt-x",
        timestamp: day(n),
        tokens: { prompt_tokens: tokens, completion_tokens: 1 },
        cost: 1,
        endpoint: "/v1/chat/completions",
      });
    }
  });

  afterEach(() => vi.restoreAllMocks());

  function historySql() {
    const sqls = [];
    for (const m of ["all", "get"]) {
      for (const [sql] of vi.spyOn(db, m).mock.calls) {
        if (/usageHistory/.test(sql)) sqls.push(sql);
      }
    }
    return sqls;
  }
  // The only two bounded usageHistory reads getUsageStats may issue for rollup-only periods.
  const norm = (sql) => sql.replace(/\s+/g, " ").trim();
  const BOUNDED = [
    /^SELECT timestamp, provider, model, tokens, status FROM usageHistory ORDER BY id DESC LIMIT 100$/,
    /^SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= \? AND timestamp <= \?$/,
  ];
  const allowed = (sql) => BOUNDED.some((re) => re.test(norm(sql)));

  it.each([
    ["90d", 3, 60],
    ["all", 5, 150],
  ])(
    "getUsageStats(%s) totals match and avoid usageHistory scans",
    async (period, reqs, prompt) => {
      vi.spyOn(db, "all");
      vi.spyOn(db, "get");
      const stats = await getUsageStats(null, period);
      expect(stats.totalRequests).toBe(reqs);
      expect(stats.totalPromptTokens).toBe(prompt);
      const offenders = historySql().filter((s) => !allowed(s));
      expect(offenders).toEqual([]);
    },
  );

  it("negative control: 60d does scan usageHistory (spies see real offenders)", async () => {
    vi.spyOn(db, "all");
    vi.spyOn(db, "get");
    await getUsageStats(null, "60d");
    expect(historySql().filter((s) => !allowed(s)).length).toBeGreaterThan(0);
  });

  it.each(["90d", "all"])("getChartData(%s) avoids usageHistory", async (period) => {
    vi.spyOn(db, "all");
    vi.spyOn(db, "get");
    const data = await getChartData(null, period);
    expect(historySql()).toEqual([]);
    expect(data.length).toBeLessThanOrEqual(100);
    if (period === "90d") expect(data).toHaveLength(90);
    expect(data.reduce((s, b) => s + b.requests, 0)).toBe(period === "90d" ? 3 : 5);
  });

  it("compare totals: 90d current/previous and all with previous null", async () => {
    vi.spyOn(db, "all");
    vi.spyOn(db, "get");
    const d90 = await getRollupUsageTotals(null, "90d");
    expect(d90.currentTotals).toMatchObject({ requests: 3, promptTokens: 60, cost: 3 });
    expect(d90.previous).toMatchObject({ requests: 1, promptTokens: 40 });
    const all = await getRollupUsageTotals(null, "all");
    expect(all.currentTotals).toMatchObject({ requests: 5, promptTokens: 150 });
    expect(all.previous).toBeNull();
    expect(historySql()).toEqual([]);
    await expect(getRollupUsageTotals(null, "30d")).rejects.toThrow(/unsupported/);
  });
});

describe("90d / all respect usage scope", () => {
  let db;
  const day = (n) => {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - n);
    return d.toISOString();
  };
  const seed = (workspaceId, userId, n, tokens) =>
    saveRequestUsageUnscoped({
      provider: "openai",
      model: "gpt-x",
      timestamp: day(n),
      tokens: { prompt_tokens: tokens, completion_tokens: 1 },
      cost: 1,
      endpoint: "/v1/chat/completions",
      workspaceId,
      userId,
    });

  beforeEach(async () => {
    db = await getAdapter();
    db.exec(
      "DELETE FROM usageHistory; DELETE FROM usageRollup; DELETE FROM memberships; DELETE FROM workspaces; DELETE FROM users",
    );
    for (const u of ["u1", "u2"]) {
      db.run(
        "INSERT INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES (?, 'user', 'active', 't', 't')",
        [u],
      );
    }
    for (const w of ["wA", "wB"]) {
      db.run(
        "INSERT INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES (?, ?, 'shared', 't', 't')",
        [w, w],
      );
    }
    await seed("wA", "u1", 1, 10);
    await seed("wA", "u2", 2, 20);
    await seed("wB", "u1", 3, 40);
    await seed("wA", "u1", 120, 7); // previous 90d window
    await seed("wA", "u1", 200, 5); // only in all
    await seed(null, null, 4, 80); // unscoped row, never visible to a scope
  });

  // [ctx, 90d requests, 90d prompt, previous requests, all requests, all prompt]
  const CASES = [
    [{ workspaceId: "wA" }, 2, 30, 1, 4, 42],
    [{ workspaceId: "wA", userId: "u1" }, 1, 10, 1, 3, 22],
    [{ workspaceId: "wA", userId: "u2" }, 1, 20, 0, 1, 20],
    [{ workspaceId: "wB" }, 1, 40, 0, 1, 40],
    [{ workspaceId: "wB", userId: "u2" }, 0, 0, 0, 0, 0],
  ];

  it.each(CASES)("%j counts only scoped rows", async (ctx, r90, p90, rPrev, rAll, pAll) => {
    const t90 = await getRollupUsageTotals(ctx, "90d");
    expect(t90.currentTotals).toMatchObject({ requests: r90, promptTokens: p90 });
    expect(t90.previous.requests).toBe(rPrev);
    const tAll = await getRollupUsageTotals(ctx, "all");
    expect(tAll.currentTotals).toMatchObject({ requests: rAll, promptTokens: pAll });
    expect(tAll.previous).toBeNull();

    for (const [period, reqs, prompt] of [
      ["90d", r90, p90],
      ["all", rAll, pAll],
    ]) {
      const stats = await getUsageStats(ctx, period);
      expect(stats.totalRequests).toBe(reqs);
      expect(stats.totalPromptTokens).toBe(prompt);
      const chart = await getChartData(ctx, period);
      expect(chart.reduce((sum, b) => sum + b.requests, 0)).toBe(reqs);
    }
  });
});
