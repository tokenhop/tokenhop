import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { periodStart, previousPeriodRange } from "@/shared/utils/period.js";
import { rebuildRollupFromHistoryUnscoped } from "@/lib/db/repos/usageRollupRepo.js";
import {
  savingsCostTrendInput,
  trendDelta,
} from "../../src/app/(dashboard)/dashboard/usage/lib/tileTrends.js";

const scopeHolder = vi.hoisted(() => ({ scope: null }));
vi.mock("@/lib/usage/scope.js", () => ({ usageScope: async () => scopeHolder.scope }));
// Provider "boom" makes the pricing lookup reject (YAN-1812 failed-pricing case).
vi.mock("@/lib/db/repos/pricingRepo.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getPricingForModel: async (provider, model) => {
      if (provider === "boom") throw new Error("pricing lookup failed");
      return actual.getPricingForModel(provider, model);
    },
  };
});

const NOW = new Date(2026, 8, 29, 12, 30).getTime();
const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let adapter;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-savings-compare-"));
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
  adapter.run("DELETE FROM usageRollup");
  adapter.run("DELETE FROM usageComboRollup");
});

const saved = (...tokens) => ({
  savings: {
    byMethod: Object.fromEntries(tokens.map((t, i) => [`m${i}`, { tokensSavedEst: t }])),
  },
});

function seed(
  timestamp,
  meta,
  { workspaceId = null, userId = null, provider = null, model = null } = {},
) {
  adapter.run(
    `INSERT INTO usageHistory(timestamp, workspaceId, userId, provider, model, meta) VALUES(?, ?, ?, ?, ?, ?)`,
    [
      new Date(timestamp).toISOString(),
      workspaceId,
      userId,
      provider,
      model,
      typeof meta === "string" || meta === null ? meta : JSON.stringify(meta),
    ],
  );
  // Raw history inserts simulate retained legacy rows; production writes fold
  // these measures transactionally. Rebuild keeps both sources in sync here.
  rebuildRollupFromHistoryUnscoped(adapter);
}

describe("getSavingsTotals", () => {
  it("uses a half-open [start, end) window", async () => {
    const start = NOW - 1000;
    seed(start - 1, saved(1));
    seed(start, saved(10));
    seed(NOW - 1, saved(100));
    seed(NOW, saved(1000));
    expect(await db.getSavingsTotals(null, { start, end: NOW })).toEqual({
      tokensSavedEst: 110,
      requestsWithSavings: 2,
      costSavedEst: null,
      pricedRequests: 0,
    });
  });

  it("sums positive methods only and counts a multi-method row once", async () => {
    seed(NOW - 10, saved(5, 7, -3, 0));
    seed(NOW - 20, saved(0, -4));
    expect(await db.getSavingsTotals(null, { start: NOW - 100, end: NOW })).toEqual({
      tokensSavedEst: 12,
      requestsWithSavings: 1,
      costSavedEst: null,
      pricedRequests: 0,
    });
  });

  it("ignores NULL, malformed and non-object meta without throwing", async () => {
    seed(NOW - 10, null);
    seed(NOW - 11, "{bad");
    seed(NOW - 12, { savings: { byMethod: { rtk: "abc" } } });
    seed(NOW - 13, { savings: { byMethod: { rtk: 5 } } });
    seed(NOW - 14, { savings: { byMethod: "x" } });
    seed(NOW - 15, saved(9));
    expect(await db.getSavingsTotals(null, { start: NOW - 100, end: NOW })).toEqual({
      tokensSavedEst: 9,
      requestsWithSavings: 1,
      costSavedEst: null,
      pricedRequests: 0,
    });
  });

  it("matches getUsageSavings for the same rows", async () => {
    const start = periodStart("7d", NOW);
    seed(start, saved(10, 20));
    seed(NOW - 60000, saved(5));
    seed(NOW - 120000, saved(0));
    seed(start - 1, saved(999));
    const headline = await db.getUsageSavings(null, "7d", NOW);
    const totals = await db.getSavingsTotals(null, { start, end: NOW });
    expect(totals.tokensSavedEst).toBe(headline.tokensSavedEst);
    expect(totals.requestsWithSavings).toBe(headline.requestsWithSavings);
    expect(totals.tokensSavedEst).toBe(35);
  });

  it.each(["today", "24h", "7d"])("splits current and previous windows for %s", async (period) => {
    const start = periodStart(period, NOW);
    const prev = previousPeriodRange(period, NOW);
    seed(start, saved(1));
    seed(NOW - 1, saved(2));
    seed(prev.start, saved(10));
    seed(prev.end - 1, saved(20));
    seed(prev.start - 1, saved(1000));
    // Past the previous window: only inside the current one when it adjoins it.
    if (prev.end < start) seed(prev.end, saved(2000));
    const current = await db.getSavingsTotals(null, { start, end: NOW });
    const previous = await db.getSavingsTotals(null, prev);
    const unpriced = { costSavedEst: null, pricedRequests: 0 };
    expect(current).toEqual({ tokensSavedEst: 3, requestsWithSavings: 2, ...unpriced });
    expect(previous).toEqual({ tokensSavedEst: 30, requestsWithSavings: 2, ...unpriced });
  });

  it("isolates by workspace and user", async () => {
    const range = { start: NOW - 1000, end: NOW };
    const at = new Date(NOW).toISOString();
    for (const u of ["u1", "u2"]) {
      adapter.run(
        "INSERT OR IGNORE INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES (?, 'user', 'active', ?, ?)",
        [u, at, at],
      );
    }
    for (const w of ["ws-a", "ws-b"]) {
      adapter.run(
        "INSERT OR IGNORE INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES (?, ?, 'shared', ?, ?)",
        [w, w, at, at],
      );
    }
    seed(NOW - 10, saved(1), { workspaceId: "ws-a", userId: "u1" });
    seed(NOW - 10, saved(10), { workspaceId: "ws-a", userId: "u2" });
    seed(NOW - 10, saved(100), { workspaceId: "ws-b", userId: "u1" });
    expect((await db.getSavingsTotals(null, range)).tokensSavedEst).toBe(111);
    expect((await db.getSavingsTotals({ workspaceId: "ws-a" }, range)).tokensSavedEst).toBe(11);
    expect(await db.getSavingsTotals({ workspaceId: "ws-a", userId: "u1" }, range)).toEqual({
      tokensSavedEst: 1,
      requestsWithSavings: 1,
      costSavedEst: null,
      pricedRequests: 0,
    });
    await expect(db.getSavingsTotals({}, range)).rejects.toThrow();
  });

  it("rejects invalid bounds", async () => {
    for (const range of [
      { start: Number.NaN, end: 1 },
      { start: 5, end: 1 },
      { start: 0, end: Number.POSITIVE_INFINITY },
      undefined,
    ]) {
      await expect(db.getSavingsTotals(null, range)).rejects.toThrow();
    }
  });
});

describe("savings route compare", () => {
  const call = async (query) => {
    const { GET } = await import("../../src/app/api/usage/savings/route.js");
    return GET(new Request(`http://localhost/api/usage/savings?${query}`));
  };

  it("adds currentTotals and previous when compare=previous", async () => {
    seed(Date.now() - 1000, saved(50));
    const res = await call("period=7d&compare=previous");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentTotals).toEqual({
      tokensSavedEst: 50,
      requestsWithSavings: 1,
      costSavedEst: null,
      pricedRequests: 0,
    });
    expect(body.previous).toEqual({
      tokensSavedEst: 0,
      requestsWithSavings: 0,
      costSavedEst: null,
      pricedRequests: 0,
    });
    expect(body.tokensSavedEst).toBe(50);
  });

  it("omits compare fields by default", async () => {
    const body = await (await call("period=7d")).json();
    expect(body).not.toHaveProperty("previous");
    expect(body).not.toHaveProperty("currentTotals");
  });

  it("rejects an invalid compare value", async () => {
    const res = await call("period=7d&compare=bogus");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid compare" });
  });

  it("supports 90d from the daily rollup", async () => {
    seed(Date.now() - 1000, saved(50));
    const res = await call("period=90d&compare=previous");
    expect(res.status).toBe(200);
    expect((await res.json()).currentTotals).toEqual({
      tokensSavedEst: 50,
      requestsWithSavings: 1,
      costSavedEst: null,
      pricedRequests: 0,
    });
  });

  it("keeps headline, currentTotals and previous inside the Users & teams scope", async () => {
    const at = new Date(NOW).toISOString();
    for (const u of ["u1", "u2"]) {
      adapter.run(
        "INSERT OR IGNORE INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES (?, 'user', 'active', ?, ?)",
        [u, at, at],
      );
    }
    for (const w of ["ws-a", "ws-b"]) {
      adapter.run(
        "INSERT OR IGNORE INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES (?, ?, 'shared', ?, ?)",
        [w, w, at, at],
      );
    }
    const prev = previousPeriodRange("7d", NOW);
    const mine = { workspaceId: "ws-a", userId: "u1" };
    // Row stamped exactly at `now` counts in the headline and currentTotals.
    seed(NOW, saved(1), mine);
    seed(NOW - 1000, saved(10), { workspaceId: "ws-a", userId: "u2" });
    seed(NOW - 1000, saved(100), { workspaceId: "ws-b", userId: "u1" });
    seed(prev.start, saved(2), mine);
    seed(prev.start, saved(20), { workspaceId: "ws-a", userId: "u2" });
    seed(prev.start, saved(200), { workspaceId: "ws-b", userId: "u1" });

    scopeHolder.scope = mine;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      const body = await (await call("period=7d&compare=previous")).json();
      expect(body.tokensSavedEst).toBe(1);
      expect(body.currentTotals).toEqual({
        tokensSavedEst: 1,
        requestsWithSavings: 1,
        costSavedEst: null,
        pricedRequests: 0,
      });
      expect(body.previous).toEqual({
        tokensSavedEst: 2,
        requestsWithSavings: 1,
        costSavedEst: null,
        pricedRequests: 0,
      });
    } finally {
      nowSpy.mockRestore();
      scopeHolder.scope = null;
    }
  });
});

describe("getRollupSavingsTotals with days pruned before tracking", () => {
  const range = { from: "2026-09-23", to: "2026-09-29" }; // previous = 09-16..09-22
  const untracked = (dateKey) =>
    adapter.run(
      `INSERT INTO usageRollup (dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint, requests, lastUsedAt)
       VALUES (?, '', '', 'local-no-key', 'p', 'm', 'c', '/e', 5, '')`,
      [dateKey],
    );

  it("returns the previous window when every rollup day is tracked", async () => {
    seed(new Date(2026, 8, 20, 12).getTime(), saved(7));
    seed(new Date(2026, 8, 25, 12).getTime(), saved(3));
    const out = await db.getRollupSavingsTotals(null, range);
    expect(out.currentTotals.tokensSavedEst).toBe(3);
    expect(out.previous).toEqual({
      tokensSavedEst: 7,
      requestsWithSavings: 1,
      costSavedEst: null,
      pricedRequests: 0,
    });
  });

  it("returns previous: null when the previous window has an untracked day", async () => {
    seed(new Date(2026, 8, 25, 12).getTime(), saved(3));
    untracked("2026-09-18");
    const out = await db.getRollupSavingsTotals(null, range);
    expect(out.currentTotals.tokensSavedEst).toBe(3);
    expect(out.previous).toBeNull();
  });

  it("keeps previous when the untracked day is outside the previous window", async () => {
    seed(new Date(2026, 8, 20, 12).getTime(), saved(7));
    untracked("2026-09-25"); // current window, not previous
    untracked("2026-09-15"); // before previous window
    const out = await db.getRollupSavingsTotals(null, range);
    expect(out.previous).toEqual({
      tokensSavedEst: 7,
      requestsWithSavings: 1,
      costSavedEst: null,
      pricedRequests: 0,
    });
  });
});

describe("compare totals costSavedEst (YAN-1237)", () => {
  const priced = { provider: "openai", model: "gpt-4o-mini" };

  it("history path (24h): currentTotals/previous price like getUsageSavings", async () => {
    const start = periodStart("24h", NOW);
    const prev = previousPeriodRange("24h", NOW);
    seed(start, saved(1000), priced);
    seed(NOW - 1000, saved(2000), priced);
    seed(prev.start, saved(4000), { provider: "nope", model: "nope" }); // unpriced
    seed(prev.end - 1, saved(500), { provider: "nope", model: "nope" }); // unpriced

    const [headline, current, previous] = await Promise.all([
      db.getUsageSavings(null, "24h", NOW),
      db.getSavingsTotals(null, { start, end: NOW + 1 }),
      db.getSavingsTotals(null, prev),
    ]);
    expect(headline.costSavedEst).toBeGreaterThan(0);
    expect(current.costSavedEst).toBe(headline.costSavedEst);
    // Previous window: both rows are on unknown pricing, so tokens count but
    // no dollars are invented.
    expect(previous.costSavedEst).toBeNull();
    expect(previous.tokensSavedEst).toBe(4500);
  });

  it("rollup path (7d): currentTotals/previous price like getUsageSavings", async () => {
    const range = { from: "2026-09-23", to: "2026-09-29" }; // previous = 09-16..09-22
    seed(new Date(2026, 8, 20, 12).getTime(), saved(3000), priced); // previous
    seed(new Date(2026, 8, 21, 12).getTime(), saved(600), { provider: "nope", model: "nope" });
    seed(new Date(2026, 8, 25, 12).getTime(), saved(1000), priced); // current

    const headline = await db.getUsageSavings(null, "7d", NOW);
    expect(headline.costSavedEst).toBeGreaterThan(0);
    const out = await db.getRollupSavingsTotals(null, range);
    expect(out.currentTotals.costSavedEst).toBe(headline.costSavedEst);
    expect(out.previous.tokensSavedEst).toBe(3600);
    // gpt-4o-mini input is 0.15 $/1M tokens.
    expect(out.currentTotals.costSavedEst).toBeCloseTo(1000 * 0.15e-6, 9);
    expect(out.previous.costSavedEst).toBeCloseTo(3000 * 0.15e-6, 9);
  });

  it("is null when no group in the window had resolvable pricing", async () => {
    seed(new Date(2026, 8, 25, 12).getTime(), saved(1000), {
      provider: "nope",
      model: "nope",
    });
    const out = await db.getRollupSavingsTotals(null, { from: "2026-09-23", to: "2026-09-29" });
    expect(out.currentTotals.costSavedEst).toBeNull();
    expect(out.previous.costSavedEst).toBeNull();
    // History path, same rule: an unpriced row inside the window counts
    // tokens but contributes no dollars.
    seed(NOW - 500, saved(700), { provider: "nope", model: "nope" });
    const hist = await db.getSavingsTotals(null, { start: NOW - 1000, end: NOW + 1 });
    expect(hist.tokensSavedEst).toBeGreaterThan(0);
    expect(hist.costSavedEst).toBeNull();
  });
});

describe("compare totals pricedRequests (YAN-1788)", () => {
  const priced = { provider: "openai", model: "gpt-4o-mini" };
  const unpriced = { provider: "nope", model: "nope" };

  it("history path (24h): matches getUsageSavings for the same rows", async () => {
    const start = periodStart("24h", NOW);
    const prev = previousPeriodRange("24h", NOW);
    seed(start, saved(1000), priced);
    seed(NOW - 2000, saved(2000), priced);
    seed(NOW - 1000, saved(300), unpriced);
    seed(prev.start, saved(4000), priced);
    seed(prev.end - 1, saved(500), unpriced);
    seed(prev.end - 2, saved(50), unpriced);

    const [headline, current, previous] = await Promise.all([
      db.getUsageSavings(null, "24h", NOW),
      db.getSavingsTotals(null, { start, end: NOW + 1 }),
      db.getSavingsTotals(null, prev),
    ]);
    expect(headline.pricedRequests).toBe(2);
    expect(current.pricedRequests).toBe(headline.pricedRequests);
    expect(current.requestsWithSavings).toBe(3);
    expect(previous.pricedRequests).toBe(1);
    expect(previous.requestsWithSavings).toBe(3);
  });

  it("rollup path (7d): matches getUsageSavings for the same rows", async () => {
    const range = { from: "2026-09-23", to: "2026-09-29" }; // previous = 09-16..09-22
    seed(new Date(2026, 8, 20, 12).getTime(), saved(3000), priced); // previous
    seed(new Date(2026, 8, 21, 12).getTime(), saved(600), unpriced); // previous
    seed(new Date(2026, 8, 25, 12).getTime(), saved(1000), priced); // current
    seed(new Date(2026, 8, 26, 12).getTime(), saved(1000), priced); // current
    seed(new Date(2026, 8, 27, 12).getTime(), saved(10), unpriced); // current

    const headline = await db.getUsageSavings(null, "7d", NOW);
    const out = await db.getRollupSavingsTotals(null, range);
    expect(headline.pricedRequests).toBe(2);
    expect(out.currentTotals.pricedRequests).toBe(headline.pricedRequests);
    expect(out.currentTotals.requestsWithSavings).toBe(3);
    expect(out.previous.pricedRequests).toBe(1);
    expect(out.previous.requestsWithSavings).toBe(2);
  });

  it("counts priced requests inside a workspace scope on both paths", async () => {
    const at = new Date(NOW).toISOString();
    for (const w of ["ws-a", "ws-b"]) {
      adapter.run(
        "INSERT OR IGNORE INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES (?, ?, 'shared', ?, ?)",
        [w, w, at, at],
      );
    }
    const a = { workspaceId: "ws-a" };
    seed(NOW - 2000, saved(1000), { ...a, ...priced });
    seed(NOW - 1000, saved(300), { ...a, ...unpriced });
    seed(NOW - 1500, saved(5000), { workspaceId: "ws-b", ...priced }); // other workspace
    seed(new Date(2026, 8, 20, 12).getTime(), saved(3000), { ...a, ...priced }); // previous 7d

    const hist = await db.getSavingsTotals(a, { start: periodStart("24h", NOW), end: NOW + 1 });
    expect(hist).toMatchObject({ requestsWithSavings: 2, pricedRequests: 1 });
    expect(hist.costSavedEst).toBeGreaterThan(0);

    const out = await db.getRollupSavingsTotals(a, { from: "2026-09-23", to: "2026-09-29" });
    expect(out.currentTotals).toMatchObject({ requestsWithSavings: 2, pricedRequests: 1 });
    expect(out.previous).toMatchObject({ requestsWithSavings: 1, pricedRequests: 1 });
    // Control: unscoped also sees ws-b's priced row.
    const all = await db.getSavingsTotals(null, { start: periodStart("24h", NOW), end: NOW + 1 });
    expect(all.pricedRequests).toBe(2);
  });
});

describe("free-model pricing coverage (YAN-1812)", () => {
  const paid = { provider: "openai", model: "gpt-4o-mini" }; // input 0.15 $/1M
  const free = { provider: "test", model: "free-model" }; // user pricing, input 0
  const missing = { provider: "nope", model: "nope" };
  const failed = { provider: "boom", model: "boom" }; // lookup rejects (mock above)
  const paidCost = +(1000 * 0.15e-6).toFixed(6);
  // Raw kv overrides bypass PATCH validation, like a hand-edited or legacy row.
  const rawRates = {
    "rate-neg": { input: -1 },
    "rate-null": { input: null },
    "rate-abc": { input: "abc" },
    "rate-zero": { input: 0 },
    "rate-str": { input: "0.15" }, // numeric string resolves like gpt-4o-mini
    "rate-blank": { input: "  " },
  };

  beforeAll(async () => {
    await db.updatePricing({ test: { "free-model": { input: 0, output: 0 } } });
    adapter.run(`INSERT INTO kv(scope, key, value) VALUES('pricing', 'raw', ?)`, [
      JSON.stringify(rawRates),
    ]);
    db.invalidatePricingCache();
  });

  afterAll(() => {
    adapter.run(`DELETE FROM kv WHERE scope = 'pricing' AND key IN ('test', 'raw')`);
    db.invalidatePricingCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Each path seeds up to 5 current-window and 5 previous-window rows and reads
  // [getUsageSavings headline, compare currentTotals] plus compare previous.
  const paths = {
    "history (24h)": {
      currentAt: (i) => (i === 0 ? periodStart("24h", NOW) : NOW - i * 1000),
      previousAt: (i) => previousPeriodRange("24h", NOW).start + i * 1000,
      async read() {
        const prev = previousPeriodRange("24h", NOW);
        const [headline, current, previous] = await Promise.all([
          db.getUsageSavings(null, "24h", NOW),
          db.getSavingsTotals(null, { start: periodStart("24h", NOW), end: NOW + 1 }),
          db.getSavingsTotals(null, prev),
        ]);
        return { currents: [headline, current], current, previous };
      },
    },
    "rollup (7d)": {
      currentAt: (i) => new Date(2026, 8, 24 + i, 12).getTime(), // 09-24 onward, inside 7d
      previousAt: (i) => new Date(2026, 8, 17 + i, 12).getTime(), // 09-17..09-21
      async read() {
        const headline = await db.getUsageSavings(null, "7d", NOW);
        const out = await db.getRollupSavingsTotals(null, { from: "2026-09-23", to: "2026-09-29" });
        return {
          currents: [headline, out.currentTotals],
          current: out.currentTotals,
          previous: out.previous,
        };
      },
    },
  };

  describe.each(Object.entries(paths))("%s", (_name, path) => {
    const seedWindow = (at, rows) => {
      for (const [i, [tokens, model]] of rows.entries()) seed(at(i), saved(tokens), model);
    };

    it("counts free as priced, never missing/failed; $ is the paid part only", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      seedWindow(path.currentAt, [
        [500, free],
        [700, free],
        [1000, paid],
        [300, missing],
        [200, failed],
      ]);
      seedWindow(path.previousAt, [
        [400, free],
        [600, free],
      ]);
      const { currents, previous } = await path.read();
      for (const totals of currents) {
        expect(totals).toMatchObject({
          requestsWithSavings: 5,
          pricedRequests: 3,
          costSavedEst: paidCost,
        });
      }
      // All-free window: fully covered, but no list-price dollars.
      expect(previous).toEqual({
        tokensSavedEst: 1000,
        requestsWithSavings: 2,
        costSavedEst: null,
        pricedRequests: 2,
      });
      expect(errorSpy).toHaveBeenCalledWith(
        "[usageSavingsPricing] savings pricing failed:",
        "pricing lookup failed",
      );
    });

    it("an all-free current window vs a priced previous shows no cost trend", async () => {
      seedWindow(path.currentAt, [
        [500, free],
        [700, free],
      ]);
      seedWindow(path.previousAt, [
        [1000, paid],
        [2000, paid],
      ]);
      const { current, previous } = await path.read();
      expect(current).toMatchObject({
        requestsWithSavings: 2,
        pricedRequests: 2,
        costSavedEst: null,
      });
      expect(previous).toMatchObject({ requestsWithSavings: 2, pricedRequests: 2 });
      expect(previous.costSavedEst).toBeGreaterThan(0);
      const input = savingsCostTrendInput({ currentTotals: current, previous });
      expect(input.current).toBeUndefined();
      expect(trendDelta(input.current, input.previous)).toEqual({ kind: "none" });
    });

    it("is null when the priced sum rounds to $0 at 6dp", async () => {
      // 3 tokens × 0.15 $/1M = 4.5e-7, below the 6dp resolution.
      seedWindow(path.currentAt, [
        [500, free],
        [3, paid],
      ]);
      const { currents } = await path.read();
      for (const totals of currents) {
        expect(totals).toMatchObject({
          requestsWithSavings: 2,
          pricedRequests: 2,
          costSavedEst: null,
        });
      }
    });

    it("treats non-numeric, blank or negative input rates as unresolved, 0 as free", async () => {
      seedWindow(
        path.currentAt,
        Object.keys(rawRates).map((model) => [1000, { provider: "raw", model }]),
      );
      const { currents } = await path.read();
      for (const totals of currents) {
        expect(totals).toMatchObject({
          requestsWithSavings: 6,
          pricedRequests: 2, // rate-zero (free) + rate-str
          costSavedEst: paidCost,
        });
      }
    });
  });
});

describe("failing pricing lookup logs once per call (YAN-1818)", () => {
  const paid = { provider: "openai", model: "gpt-4o-mini" }; // input 0.15 $/1M
  const failed = { provider: "boom", model: "boom" }; // lookup rejects (mock above)
  const failureLogs = (spy) =>
    spy.mock.calls.filter(([msg]) => msg === "[usageSavingsPricing] savings pricing failed:");

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("history (24h): many failing rows log once; only resolvable rows are priced", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 1; i <= 4; i++) seed(NOW - i * 1000, saved(100 * i), failed);
    seed(NOW - 5000, saved(1000), paid);
    seed(NOW - 6000, saved(500), paid);

    const out = await db.getUsageSavings(null, "24h", NOW);

    expect(out).toMatchObject({
      requestsWithSavings: 6,
      pricedRequests: 2,
      costSavedEst: +(1500 * 0.15e-6).toFixed(6),
    });
    expect(failureLogs(errorSpy)).toEqual([
      ["[usageSavingsPricing] savings pricing failed:", "pricing lookup failed"],
    ]);
  });

  it("history (24h): an all-failing window logs once and prices nothing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 1; i <= 3; i++) seed(NOW - i * 1000, saved(100), failed);

    const out = await db.getUsageSavings(null, "24h", NOW);

    expect(out).toMatchObject({ requestsWithSavings: 3, pricedRequests: 0, costSavedEst: null });
    expect(failureLogs(errorSpy)).toHaveLength(1);
  });

  it("rollup compare: current and previous share one cache, so one log", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    seed(new Date(2026, 8, 25, 12).getTime(), saved(300), failed); // current 7d
    seed(new Date(2026, 8, 26, 12).getTime(), saved(1000), paid); // current 7d
    seed(new Date(2026, 8, 18, 12).getTime(), saved(200), failed); // previous 7d

    const out = await db.getRollupSavingsTotals(null, { from: "2026-09-23", to: "2026-09-29" });

    expect(out.currentTotals).toMatchObject({
      requestsWithSavings: 2,
      pricedRequests: 1,
      costSavedEst: +(1000 * 0.15e-6).toFixed(6),
    });
    expect(out.previous).toMatchObject({
      requestsWithSavings: 1,
      pricedRequests: 0,
      costSavedEst: null,
    });
    expect(failureLogs(errorSpy)).toHaveLength(1);
  });

  it("concurrent lookups on one cache share a single failing lookup and log", async () => {
    // boom/boom gets a real user price, so a caller that misses the shared
    // failed lookup either prices it or logs again; both fail this test.
    await db.updatePricing({ boom: { boom: { input: 1, output: 0 } } });
    try {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { savedTokensCost } = await import("@/lib/db/repos/usageSavingsPricing.js");
      const cache = new Map();

      const costs = await Promise.all(
        [100, 200, 300].map((t) => savedTokensCost(failed.provider, failed.model, t, cache)),
      );

      expect(costs).toEqual([null, null, null]);
      expect(cache.size).toBe(1);
      expect(failureLogs(errorSpy)).toHaveLength(1);
    } finally {
      adapter.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = 'boom'`);
      db.invalidatePricingCache();
    }
  });
});
