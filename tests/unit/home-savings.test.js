import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSavingsEntry } from "../../src/lib/home/savings.js";

const H = 3600_000;
const DAY = 24 * H;

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
  it("home summary: request count + top combos from recorded names", async () => {
    const summary = await db.getHomeSummary(null, "7d");
    expect(summary.requests).toBeGreaterThanOrEqual(3);
    expect(summary).not.toHaveProperty("previousRequests");
    const pack = summary.topCombos.find((c) => c.name === "research-pack");
    expect(pack).toBeDefined();
    expect(pack.requests).toBe(1);
  });

  it("getUsageSavings/getHomeSummary serve 90d and all; unknown periods still throw", async () => {
    await expect(db.getUsageSavings(null, "90d")).resolves.toMatchObject({ period: "90d" });
    await expect(db.getUsageSavings(null, "all")).resolves.toMatchObject({ period: "all" });
    await expect(db.getHomeSummary(null, "all")).resolves.toMatchObject({ period: "all" });
    await expect(db.getUsageSavings(null, "bogus")).rejects.toThrow(/Invalid period/);
    await expect(db.getHomeSummary(null, "bogus")).rejects.toThrow(/Invalid period/);
  });
});

describe("savings and summary windows", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let db;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-savings-windows-"));
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

  it("savings and summary use calendar windows", async () => {
    const now = new Date(2026, 8, 29, 12).getTime();
    const start = new Date(2026, 8, 23).getTime(); // 7d = local midnight of today - 6
    const meta = {
      savings: {
        tokensSavedEst: 10,
        tokensBeforeEst: 40,
        byMethod: { rtk: { tokensSavedEst: 10 } },
      },
    };
    // Rolling 7×24h would include start - 1h; the calendar window does not.
    // Seeded through the real writer so the rollup carries the same rows.
    for (const t of [start, now - H, start - H, start - 2 * DAY]) {
      await db.saveRequestUsageUnscoped({
        provider: "openai",
        model: "gpt-5",
        timestamp: new Date(t).toISOString(),
        tokens: { prompt_tokens: 10, completion_tokens: 5 },
        endpoint: "/v1/chat/completions",
        meta,
      });
    }
    expect((await db.getUsageSavings(null, "7d", now)).requestsWithSavings).toBe(2);
    const summary = await db.getHomeSummary(null, "7d", now);
    expect(summary.requests).toBe(2);
    expect(summary).not.toHaveProperty("previousRequests");
    expect((await db.getUsageSavings(null, "24h", now)).requestsWithSavings).toBe(1);
    expect((await db.getHomeSummary(null, "60d", now)).requests).toBe(4);
  });
});

describe("home summary today/24h top combos", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let db;
  let adapter;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-home-combos-"));
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

  beforeEach(() => {
    adapter.run("DELETE FROM usageHistory");
  });

  const NOW = new Date(2026, 8, 29, 12).getTime();
  const seed = (offsetMs, meta) =>
    adapter.run(
      `INSERT INTO usageHistory(timestamp, provider, model, meta) VALUES(?, 'openai', 'gpt-5', ?)`,
      [new Date(NOW - offsetMs).toISOString(), meta],
    );
  const combo = (name) => JSON.stringify({ comboName: name });

  it("counts per combo, orders by requests then name, and caps at five", async () => {
    for (const name of ["beta", "alpha", "alpha", "gamma", "zeta", "eta", "theta", "beta"]) {
      seed(H, combo(name));
    }
    const summary = await db.getHomeSummary(null, "today", NOW);
    expect(summary).toEqual({
      period: "today",
      requests: 8,
      topCombos: [
        { name: "alpha", requests: 2 },
        { name: "beta", requests: 2 },
        { name: "eta", requests: 1 },
        { name: "gamma", requests: 1 },
        { name: "theta", requests: 1 },
      ],
    });
  });

  it("ignores missing, empty, non-string and malformed comboName meta but counts the requests", async () => {
    seed(H, combo("real"));
    seed(H, null);
    seed(H, "");
    seed(H, "{not json");
    seed(H, JSON.stringify({ other: 1 }));
    seed(H, combo(""));
    seed(H, JSON.stringify({ comboName: 42 }));
    seed(H, JSON.stringify({ comboName: ["real"] }));
    seed(H, JSON.stringify({ comboName: null }));
    const summary = await db.getHomeSummary(null, "24h", NOW);
    expect(summary.requests).toBe(9);
    expect(summary.topCombos).toEqual([{ name: "real", requests: 1 }]);
  });

  it("respects the window: rows older than the period or in the future are excluded", async () => {
    seed(H, combo("in"));
    seed(30 * H, combo("old"));
    seed(-H, combo("future"));
    const summary = await db.getHomeSummary(null, "24h", NOW);
    expect(summary.requests).toBe(1);
    expect(summary.topCombos).toEqual([{ name: "in", requests: 1 }]);
  });

  it("truncates long names to 128 chars like the rollup path", async () => {
    const long = "x".repeat(200);
    seed(H, combo(long));
    seed(H, combo(long));
    const summary = await db.getHomeSummary(null, "24h", NOW);
    expect(summary.topCombos).toEqual([{ name: "x".repeat(128), requests: 2 }]);
  });

  it("scopes by workspace", async () => {
    // A bare workspace row: seeding users would put later route tests into multi-user mode.
    const ws = "ws-home-scope";
    adapter.run(
      `INSERT OR IGNORE INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES(?, 'Scope', 'shared', ?, ?)`,
      [ws, new Date(NOW).toISOString(), new Date(NOW).toISOString()],
    );
    adapter.run(
      `INSERT INTO usageHistory(timestamp, provider, model, meta, workspaceId) VALUES(?, 'openai', 'gpt-5', ?, ?)`,
      [new Date(NOW - H).toISOString(), combo("mine"), ws],
    );
    seed(H, combo("other"));
    const summary = await db.getHomeSummary({ workspaceId: ws }, "24h", NOW);
    expect(summary.requests).toBe(1);
    expect(summary.topCombos).toEqual([{ name: "mine", requests: 1 }]);
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

  it.each(["90d", "all"])("savings and home summary routes accept %s", async (period) => {
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
