import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PERIOD_VALUES, periodStart, previousPeriodRange } from "@/shared/utils/period.js";
import {
  bucketSeries,
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
  it.each(PERIOD_VALUES)("%s uses an equal-length preceding window", (period) => {
    const currentStart = periodStart(period, NOW);
    const { start, end } = previousPeriodRange(period, NOW);
    expect(end - start).toBe(NOW - currentStart);
    expect(end).toBeLessThanOrEqual(currentStart);
    if (period !== "today") expect(end).toBe(currentStart);
  });

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
    expect(await db.getUsageTotals({ start, end })).toEqual({
      requests: 4,
      promptTokens: 532,
      completionTokens: 8,
      cachedTokens: 48,
      cost: 2,
    });
  });

  it("rejects invalid and reversed boundaries", async () => {
    await expect(db.getUsageTotals({ start: NaN, end: NOW })).rejects.toThrow();
    await expect(db.getUsageTotals({ start: NOW + 1, end: NOW })).rejects.toThrow();
    await expect(db.getUsageTotals({ start: NOW, end: Infinity })).rejects.toThrow();
    expect(await db.getUsageTotals({ start: NOW, end: NOW })).toEqual({
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      cost: 0,
    });
  });
});

describe("stats compare route", () => {
  it("rejects unknown compare values and all-period comparison", async () => {
    const { GET } = await import("../../src/app/api/usage/stats/route.js");
    for (const query of ["period=7d&compare=bogus", "period=all&compare=previous"]) {
      const response = await GET(new Request(`http://localhost/api/usage/stats?${query}`));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid compare" });
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
});
