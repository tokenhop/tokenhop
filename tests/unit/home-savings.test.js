import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSavingsEntry,
  aggregateSavings,
  resolvePeriodRange,
} from "../../src/lib/home/savings.js";

const H = 3600_000;
const DAY = 24 * H;

describe("resolvePeriodRange", () => {
  it("today spans local midnight to now", () => {
    const now = new Date("2026-09-26T12:00:00Z").getTime();
    const { startMs, endMs } = resolvePeriodRange("today", now);
    const start = new Date(startMs);
    expect(start.getHours()).toBe(0);
    expect(endMs).toBe(now);
    expect(startMs).toBeLessThan(now);
  });

  it("uses the shared calendar windows for every period", () => {
    const now = new Date(2026, 8, 29, 12).getTime();
    expect(resolvePeriodRange("24h", now).startMs).toBe(now - DAY);
    expect(resolvePeriodRange("7d", now).startMs).toBe(new Date(2026, 8, 23).getTime());
    expect(resolvePeriodRange("30d", now).startMs).toBe(new Date(2026, 7, 31).getTime());
    const { startMs, prevStartMs, prevEndMs } = resolvePeriodRange("60d", now);
    expect(startMs).toBe(new Date(2026, 7, 1).getTime());
    expect(prevEndMs).toBe(startMs);
    expect(prevEndMs - prevStartMs).toBe(now - startMs);
  });

  it("rejects unknown periods", () => {
    expect(() => resolvePeriodRange("90d")).toThrow(/period/);
  });
});

describe("buildSavingsEntry", () => {
  it("records RTK bytes delta as tokens/4", () => {
    const entry = buildSavingsEntry({
      rtkStats: { bytesBefore: 8000, bytesAfter: 4000, hits: [{ filter: "x" }] },
    });
    expect(entry.byMethod.rtk.tokensSavedEst).toBe(1000);
    expect(entry.byMethod.rtk.tokensBeforeEst).toBe(2000);
  });

  it("ignores RTK with no hits", () => {
    expect(
      buildSavingsEntry({
        rtkStats: { bytesBefore: 8000, bytesAfter: 8000, hits: [] },
      }),
    ).toBeNull();
  });

  it("records headroom tokens_saved when outbound shrank", () => {
    const entry = buildSavingsEntry({
      headroomStats: { tokens_before: 10000, tokens_after: 6000, tokens_saved: 4000 },
      headroomDiagnostics: { before: { bodyBytes: 40000 }, after: { bodyBytes: 20000 } },
    });
    expect(entry.byMethod.headroom.tokensSavedEst).toBe(4000);
  });

  it("drops headroom phantom savings (<5% outbound shrink)", () => {
    expect(
      buildSavingsEntry({
        headroomStats: { tokens_before: 10000, tokens_after: 6000, tokens_saved: 4000 },
        headroomDiagnostics: { before: { bodyBytes: 40000 }, after: { bodyBytes: 39000 } },
      }),
    ).toBeNull();
  });

  it("never counts caveman/ponytail (prompt-only, no measurable delta)", () => {
    expect(buildSavingsEntry({ cavemanLevel: "full", ponytailLevel: "full" })).toBeNull();
  });

  it("records pxpipe estimates", () => {
    const entry = buildSavingsEntry({
      pxpipeSummary: {
        applied: true,
        tokensBeforeEst: 8000,
        tokensAfterEst: 3000,
        tokensSavedEst: 5000,
      },
    });
    expect(entry.byMethod.pxpipe.tokensSavedEst).toBe(5000);
  });

  it("returns null when nothing measurable", () => {
    expect(buildSavingsEntry({})).toBeNull();
  });
});

describe("aggregateSavings", () => {
  // Noon-local fixture: "now - 1h" must always fall inside "today"
  // regardless of the runner's timezone (midnight-UTC flake guard).
  const noonLocal = () => {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    return d.getTime();
  };
  const rows = (now) => [
    {
      timestamp: new Date(now - 1 * H).toISOString(),
      savings: {
        tokensSavedEst: 1000,
        tokensBeforeEst: 4000,
        byMethod: { rtk: { tokensSavedEst: 1000, tokensBeforeEst: 4000 } },
      },
    },
    {
      timestamp: new Date(now - 2 * DAY).toISOString(),
      savings: {
        tokensSavedEst: 500,
        tokensBeforeEst: 2000,
        byMethod: { headroom: { tokensSavedEst: 500, tokensBeforeEst: 2000 } },
      },
    },
    {
      timestamp: new Date(now - 40 * DAY).toISOString(),
      savings: { tokensSavedEst: 9999, tokensBeforeEst: 9999, byMethod: {} },
    },
  ];

  it("today only counts in-window rows", () => {
    const now = noonLocal();
    const out = aggregateSavings(rows(now), "today", now);
    expect(out.tokensSavedEst).toBe(1000);
    expect(out.requestsWithSavings).toBe(1);
  });

  it("7d includes both recent rows, excludes 40d row", () => {
    const now = Date.now();
    const out = aggregateSavings(rows(now), "7d", now);
    expect(out.tokensSavedEst).toBe(1500);
    expect(out.byMethod.rtk.tokensSavedEst).toBe(1000);
    expect(out.byMethod.headroom.tokensSavedEst).toBe(500);
  });

  it("30d still excludes 40d row; percentage bounded", () => {
    const now = Date.now();
    const out = aggregateSavings(rows(now), "30d", now);
    expect(out.tokensSavedEst).toBe(1500);
    expect(out.percentage).toBeGreaterThanOrEqual(0);
    expect(out.percentage).toBeLessThanOrEqual(100);
  });

  it("skips rows without savings", () => {
    const out = aggregateSavings([{ timestamp: new Date().toISOString(), savings: null }], "today");
    expect(out.tokensSavedEst).toBe(0);
    expect(out.requestsWithSavings).toBe(0);
  });
});

describe("recorded savings (saveRequestUsageUnscoped -> getUsageSavings)", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let db;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-savings-e2e-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    await db.initDb();
  });

  afterAll(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("round-trips RTK + headroom savings through meta, aggregates by period", async () => {
    const rtk = buildSavingsEntry({
      rtkStats: { bytesBefore: 8000, bytesAfter: 4000, hits: [{ shape: "x" }] },
    });
    await db.saveRequestUsageUnscoped({
      provider: "openai",
      model: "gpt-5",
      tokens: { prompt_tokens: 100, completion_tokens: 50 },
      endpoint: "/v1/chat/completions",
      status: "ok",
      savings: rtk,
    });

    const headroom = buildSavingsEntry({
      headroomStats: { tokens_before: 10000, tokens_after: 6000, tokens_saved: 4000 },
      headroomDiagnostics: { before: { bodyBytes: 40000 }, after: { bodyBytes: 20000 } },
    });
    await db.saveRequestUsageUnscoped({
      provider: "anthropic",
      model: "claude-opus-4-6",
      tokens: { prompt_tokens: 200, completion_tokens: 80 },
      endpoint: "/v1/messages",
      status: "ok",
      savings: headroom,
      comboName: "research-pack",
    });

    // No savings row: counts as a request but not as savings
    await db.saveRequestUsageUnscoped({
      provider: "openai",
      model: "gpt-5-mini",
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      endpoint: "/v1/responses",
      status: "ok",
    });

    const out = await db.getUsageSavings(null, "7d");
    expect(out.estimated).toBe(true);
    expect(out.tokensSavedEst).toBe(1000 + 4000);
    expect(out.requestsWithSavings).toBe(2);
    expect(out.methods).toEqual(expect.arrayContaining(["rtk", "headroom"]));
    expect(out.byMethod.rtk.tokensSavedEst).toBe(1000);
    expect(out.byMethod.headroom.tokensSavedEst).toBe(4000);

    // today also includes these rows (just written)
    const today = await db.getUsageSavings(null, "today");
    expect(today.requestsWithSavings).toBe(2);

    // Phantom headroom never persists measurable savings
    const phantom = buildSavingsEntry({
      headroomStats: { tokens_before: 9000, tokens_after: 5000, tokens_saved: 4000 },
      headroomDiagnostics: { before: { bodyBytes: 40000 }, after: { bodyBytes: 39500 } },
    });
    expect(phantom).toBeNull();
  });

  it("prices saved tokens per request model; unknown models price nothing", async () => {
    // Realistic shapes: gh/tokenrouter-style provider keys with per-model
    // input rates; gpt-5 + claude-opus-4-6 resolve from the real pricing tables.
    const out = await db.getUsageSavings(null, "7d");
    expect(out.costSavedEst).toBeGreaterThan(0);
    expect(out.pricedRequests).toBe(2);

    await db.saveRequestUsageUnscoped({
      provider: "nope-provider",
      model: "nope-model-xyz",
      tokens: { prompt_tokens: 100, completion_tokens: 50 },
      endpoint: "/v1/chat/completions",
      status: "ok",
      savings: buildSavingsEntry({
        rtkStats: { bytesBefore: 4000, bytesAfter: 0, hits: [{ shape: "x" }] },
      }),
    });

    const after = await db.getUsageSavings(null, "7d");
    expect(after.tokensSavedEst).toBe(out.tokensSavedEst + 1000);
    expect(after.requestsWithSavings).toBe(out.requestsWithSavings + 1);
    // Tokens count, dollars unchanged: unknown pricing is never invented.
    expect(after.costSavedEst).toBe(out.costSavedEst);
    expect(after.pricedRequests).toBe(out.pricedRequests);
  });
  it("home summary: previous-period delta + top combos from recorded names", async () => {
    const summary = await db.getHomeSummary(null, "7d");
    expect(summary.requests).toBeGreaterThanOrEqual(3);
    expect(summary.previousRequests).toBe(0);
    const pack = summary.topCombos.find((c) => c.name === "research-pack");
    expect(pack).toBeDefined();
    expect(pack.requests).toBe(1);
  });

  it("getUsageSavings rejects invalid period", async () => {
    await expect(db.getUsageSavings(null, "90d")).rejects.toThrow(/Invalid period/);
  });
});

describe("savings and summary windows", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let db;
  let adapter;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-savings-windows-"));
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

  it("savings and summary use calendar windows and the shared previous window", async () => {
    const now = new Date(2026, 8, 29, 12).getTime();
    const start = new Date(2026, 8, 23).getTime(); // 7d = local midnight of today - 6
    const meta = JSON.stringify({
      savings: {
        tokensSavedEst: 10,
        tokensBeforeEst: 40,
        byMethod: { rtk: { tokensSavedEst: 10 } },
      },
    });
    // Rolling 7×24h would include start - 1h; the calendar window does not.
    for (const t of [start, now - H, start - H, start - 2 * DAY]) {
      adapter.run(`INSERT INTO usageHistory(timestamp, meta) VALUES(?, ?)`, [
        new Date(t).toISOString(),
        meta,
      ]);
    }
    expect((await db.getUsageSavings(null, "7d", now)).requestsWithSavings).toBe(2);
    const summary = await db.getHomeSummary(null, "7d", now);
    expect(summary.requests).toBe(2);
    expect(summary.previousRequests).toBe(2);
    expect((await db.getUsageSavings(null, "24h", now)).requestsWithSavings).toBe(1);
    expect((await db.getHomeSummary(null, "60d", now)).requests).toBe(4);
  });
});

describe("savings route validation", () => {
  it("rejects invalid period with 400", async () => {
    const { GET } = await import("../../src/app/api/usage/savings/route.js");
    const res = await GET(new Request("http://localhost/api/usage/savings?period=nope"));
    expect(res.status).toBe(400);
  });

  it.each(["24h", "60d"])("savings and home summary routes accept %s", async (period) => {
    const savings = await import("../../src/app/api/usage/savings/route.js");
    const home = await import("../../src/app/api/home/summary/route.js");
    for (const [GET, path] of [
      [savings.GET, "usage/savings"],
      [home.GET, "home/summary"],
    ]) {
      const res = await GET(new Request(`http://localhost/api/${path}?period=${period}`));
      expect(res.status).toBe(200);
    }
  });

  it("home summary route rejects invalid period with 400", async () => {
    const { GET } = await import("../../src/app/api/home/summary/route.js");
    const res = await GET(new Request("http://localhost/api/home/summary?period=nope"));
    expect(res.status).toBe(400);
  });
});
