import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PERIOD_VALUES, periodStart, previousPeriodRange } from "@/shared/utils/period.js";
import {
  PRICED_SHARE_TOLERANCE,
  bucketSeries,
  pricedShare,
  savingsCostTrendInput,
  savingsTrendInput,
  trendDelta,
} from "../../src/app/(dashboard)/dashboard/usage/lib/tileTrends.js";

const DAY = 86400000;
const NOW = new Date(2026, 8, 29, 12, 30).getTime();
const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let adapter;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-usage-trends-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function seed(timestamp, promptTokens, completionTokens, cost, tokens) {
  adapter.run(
    `INSERT INTO usageHistory(timestamp, promptTokens, completionTokens, cost, tokens) VALUES(?, ?, ?, ?, ?)`,
    [
      new Date(timestamp).toISOString(),
      promptTokens,
      completionTokens,
      cost,
      JSON.stringify(tokens),
    ],
  );
}

describe("previousPeriodRange", () => {
  it("all has no previous window", () => {
    expect(previousPeriodRange("all", NOW)).toBeNull();
  });

  it.each(PERIOD_VALUES.filter((p) => p !== "all"))(
    "%s uses an equal-length preceding window",
    (period) => {
      const currentStart = periodStart(period, NOW);
      const { start, end } = previousPeriodRange(period, NOW);
      expect(end - start).toBe(NOW - currentStart);
      expect(end).toBeLessThanOrEqual(currentStart);
      if (period !== "today") expect(end).toBe(currentStart);
    },
  );

  it("today compares the same elapsed slice yesterday", () => {
    const midnight = new Date(periodStart("today", NOW));
    midnight.setDate(midnight.getDate() - 1);
    expect(previousPeriodRange("today", NOW)).toEqual({
      start: midnight.getTime(),
      end: midnight.getTime() + NOW - periodStart("today", NOW),
    });
  });

  it("keeps yesterday's local midnight through DST", () => {
    const modulePath = fileURLToPath(new URL("../../src/shared/utils/period.js", import.meta.url));
    const script = `import { previousPeriodRange } from ${JSON.stringify(modulePath)};
      const now = new Date(2026, 10, 1, 12).getTime();
      const {start, end} = previousPeriodRange("today", now);
      process.stdout.write([new Date(start).getDate(), new Date(start).getHours(), end-start].join(":"));`;
    expect(
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, TZ: "America/New_York" },
        encoding: "utf8",
      }),
    ).toBe(`31:0:${13 * 60 * 60 * 1000}`);
  });
});

describe("getUsageTotals", () => {
  it("counts only [start, end), including start and excluding end, and reads token aliases", async () => {
    const start = NOW - DAY;
    const end = NOW;
    seed(start - 1, 99, 99, 99, { cached_tokens: 99 });
    seed(start, 10, 5, 0.5, { prompt_tokens: 10, cached_tokens: 3 });
    seed(start + 1, 0, 0, 1.25, { input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 4 });
    seed(end - 1, 2, 3, 0.25, { prompt_tokens: 2, cached_tokens: 1 });
    seed(end - 1, 0, 0, 0, {
      prompt_tokens: 0,
      input_tokens: 500,
      cached_tokens: 0,
      cache_read_input_tokens: 40,
    });
    seed(end, 99, 99, 99, { cached_tokens: 99 });
    // The second fallback aliases count even when earlier fields hold 0:
    // prompt_tokens 0 falls through to input_tokens, cached_tokens 0 to
    // cache_read_input_tokens — the zero-prefixed row's aliases stay.
    expect(await db.getUsageTotals(null, { start, end })).toEqual({
      requests: 4,
      promptTokens: 532,
      completionTokens: 8,
      cachedTokens: 48,
      cost: 2,
    });
  });

  it("rejects invalid and reversed boundaries", async () => {
    await expect(db.getUsageTotals(null, { start: NaN, end: NOW })).rejects.toThrow();
    await expect(db.getUsageTotals(null, { start: NOW + 1, end: NOW })).rejects.toThrow();
    await expect(db.getUsageTotals(null, { start: NOW, end: Infinity })).rejects.toThrow();
    expect(await db.getUsageTotals(null, { start: NOW, end: NOW })).toEqual({
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      cost: 0,
    });
  });
});

describe("stats compare route", () => {
  it("rejects unknown compare values", async () => {
    const { GET } = await import("../../src/app/api/usage/stats/route.js");
    for (const query of ["period=7d&compare=bogus", "period=all&compare=bogus"]) {
      const response = await GET(new Request(`http://localhost/api/usage/stats?${query}`));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid compare" });
    }
  });

  it("serves compare=previous for 90d and all from the rollup (all has no previous)", async () => {
    const { GET } = await import("../../src/app/api/usage/stats/route.js");
    for (const period of ["90d", "all"]) {
      const response = await GET(
        new Request(`http://localhost/api/usage/stats?period=${period}&compare=previous`),
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(Number.isFinite(data.currentTotals.requests)).toBe(true);
      if (period === "all") expect(data.previous).toBeNull();
      else expect(Number.isFinite(data.previous.requests)).toBe(true);
    }
  });

  it("returns numeric current and previous totals only when requested", async () => {
    const { GET } = await import("../../src/app/api/usage/stats/route.js");
    const response = await GET(
      new Request("http://localhost/api/usage/stats?period=24h&compare=previous"),
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    for (const totals of [data.currentTotals, data.previous]) {
      for (const key of ["requests", "promptTokens", "completionTokens", "cachedTokens", "cost"]) {
        expect(typeof totals[key]).toBe("number");
      }
    }
    const plain = await GET(new Request("http://localhost/api/usage/stats?period=24h"));
    expect(await plain.json()).not.toHaveProperty("previous");
  });
});

describe("tile trends", () => {
  it("handles missing, increasing, decreasing and flat baselines", () => {
    expect(trendDelta(20, 0)).toEqual({ kind: "none" });
    expect(trendDelta(NaN, 10)).toEqual({ kind: "none" });
    expect(trendDelta(108, 100)).toEqual({ kind: "up", pct: 8 });
    expect(trendDelta(75, 100)).toEqual({ kind: "down", pct: -25 });
    expect(trendDelta(100.2, 100)).toEqual({ kind: "flat", pct: 0 });
  });

  it("returns a field series or undefined for too few buckets", () => {
    expect(bucketSeries(null, "input")).toBeUndefined();
    expect(bucketSeries([{ input: 1 }], "input")).toBeUndefined();
    expect(bucketSeries([{ input: 2 }, {}, { input: 4 }], "input")).toEqual([2, 0, 4]);
  });

  it("maps a savings compare payload to trend inputs", () => {
    const input = savingsTrendInput({
      tokensSavedEst: 5000,
      currentTotals: { tokensSavedEst: 5000, requestsWithSavings: 2 },
      previous: { tokensSavedEst: 4000, requestsWithSavings: 3 },
    });
    expect(input).toEqual({ current: 5000, previous: 4000 });
    expect(trendDelta(input.current, input.previous)).toEqual({ kind: "up", pct: 25 });
  });

  it("yields no trend for a missing previous, missing compare fields or null savings", () => {
    const noPrev = savingsTrendInput({ currentTotals: { tokensSavedEst: 10 } });
    expect(noPrev).toEqual({ current: 10, previous: undefined });
    expect(trendDelta(noPrev.current, noPrev.previous)).toEqual({ kind: "none" });
    for (const savings of [null, undefined, { tokensSavedEst: 9 }]) {
      const input = savingsTrendInput(savings);
      expect(trendDelta(input.current, input.previous)).toEqual({ kind: "none" });
    }
  });

  // Fully priced window totals; `priced` = pricedRequests of `requests` (YAN-1788).
  const costTotals = (costSavedEst, priced = 10, requests = 10) => ({
    costSavedEst,
    pricedRequests: priced,
    requestsWithSavings: requests,
  });

  it("maps priced savings cost to trend inputs", () => {
    const input = savingsCostTrendInput({
      currentTotals: { tokensSavedEst: 5000, ...costTotals(1.5) },
      previous: { tokensSavedEst: 4000, ...costTotals(1) },
    });
    expect(input).toEqual({ current: 1.5, previous: 1 });
    expect(trendDelta(input.current, input.previous)).toEqual({ kind: "up", pct: 50 });
  });

  it("hides the cost trend when unpriced, previous missing or previous is zero", () => {
    // null costSavedEst means unpriced — never coerced to 0.
    expect(
      savingsCostTrendInput({ currentTotals: costTotals(null), previous: costTotals(2) }),
    ).toEqual({ current: undefined, previous: 2 });
    expect(
      savingsCostTrendInput({ currentTotals: costTotals(2), previous: costTotals(null) }),
    ).toEqual({ current: 2, previous: undefined });
    expect(savingsCostTrendInput({ currentTotals: costTotals(2) })).toEqual({
      current: undefined,
      previous: undefined,
    });
    for (const savings of [null, undefined, { costSavedEst: 3 }]) {
      expect(savingsCostTrendInput(savings)).toEqual({ current: undefined, previous: undefined });
    }
    const zeroPrev = savingsCostTrendInput({
      currentTotals: costTotals(2),
      previous: costTotals(0),
    });
    expect(trendDelta(zeroPrev.current, zeroPrev.previous)).toEqual({ kind: "none" });
  });

  it("shows a falling cost trend for a mostly-free window vs a paid previous (YAN-1812)", () => {
    // Free requests count as priced, so coverage matches and the list-price
    // drop is real: moving traffic to free models lowers Cost saved.
    const input = savingsCostTrendInput({
      currentTotals: costTotals(0.00001),
      previous: costTotals(1),
    });
    expect(input).toEqual({ current: 0.00001, previous: 1 });
    expect(trendDelta(input.current, input.previous).kind).toBe("down");
  });

  it("hides the cost trend when the priced share differs by more than the tolerance", () => {
    expect(PRICED_SHARE_TOLERANCE).toBe(0.2);
    const input = (cur, prev) => savingsCostTrendInput({ currentTotals: cur, previous: prev });
    const hidden = { current: undefined, previous: undefined };
    // Equal shares (both half priced) keep the trend.
    expect(input(costTotals(2, 5, 10), costTotals(1, 50, 100))).toEqual({
      current: 2,
      previous: 1,
    });
    // 2 of 100 priced vs 50 of 50 priced: different slices, hidden.
    expect(input(costTotals(2, 2, 100), costTotals(1, 50, 50))).toEqual(hidden);
    // Exactly 20 points apart is still shown; just over is hidden.
    expect(input(costTotals(2, 9, 10), costTotals(1, 7, 10))).toEqual({ current: 2, previous: 1 });
    expect(input(costTotals(2, 70, 100), costTotals(1, 90, 100))).toEqual({
      current: 2,
      previous: 1,
    });
    expect(input(costTotals(2, 70, 100), costTotals(1, 91, 100))).toEqual(hidden);
    expect(input(costTotals(2, 100, 100), costTotals(1, 79, 100))).toEqual(hidden);
    // No requests with savings, or no pricedRequests field: share unknown, hidden.
    expect(input(costTotals(2, 0, 0), costTotals(1))).toEqual(hidden);
    expect(input({ costSavedEst: 2, requestsWithSavings: 10 }, costTotals(1))).toEqual(hidden);
  });

  it("pricedShare is priced / requests with savings, undefined without requests", () => {
    expect(pricedShare({ pricedRequests: 1, requestsWithSavings: 4 })).toBe(0.25);
    expect(pricedShare({ pricedRequests: 0, requestsWithSavings: 0 })).toBeUndefined();
    expect(pricedShare({ requestsWithSavings: 4 })).toBeUndefined();
    expect(pricedShare(null)).toBeUndefined();
  });

  it("computes deltas over the Home stats field mappings", () => {
    const totals = { requests: 120, promptTokens: 900, completionTokens: 300, cost: 1.5 };
    const prev = { requests: 100, promptTokens: 1000, completionTokens: 0, cost: 1 };
    expect(trendDelta(totals.requests, prev.requests)).toEqual({ kind: "up", pct: 20 });
    expect(trendDelta(totals.promptTokens, prev.promptTokens)).toEqual({ kind: "down", pct: -10 });
    // A previous of 0 is the neutral "No prior data" case, never Infinity%.
    expect(trendDelta(totals.completionTokens, prev.completionTokens)).toEqual({ kind: "none" });
    expect(trendDelta(totals.cost, prev.cost)).toEqual({ kind: "up", pct: 50 });
  });
});
