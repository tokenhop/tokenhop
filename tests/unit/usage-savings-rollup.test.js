// YAN-1226/YAN-1242: savings + combo measures on usageRollup. Covers the write
// path (savingsDeltas fold, combo upsert, lastUsedAt), parity of 7d/30d/60d
// against the pre-change history algorithm (reimplemented in-test over the
// seeded usageHistory rows), migration 021 idempotency, and 90d/all reading
// only the rollup.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { periodStart } from "@/shared/utils/period.js";
import {
  hasUntrackedRollupDays,
  rebuildRollupFromHistoryUnscoped,
} from "@/lib/db/repos/usageRollupRepo.js";
import { getPricingForModel } from "@/lib/db/repos/pricingRepo.js";
import { calculateCostFromTokens } from "open-sse/providers/pricing.js";
import { seedTenancy } from "../setup/tenancyHarness.js";

const scopeHolder = vi.hoisted(() => ({ scope: null }));
vi.mock("@/lib/usage/scope.js", () => ({ usageScope: async () => scopeHolder.scope }));

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let NOW;
let db;
let adapter;

beforeAll(() => {
  // Pin a DST zone so local-day expectations never depend on the host zone
  // (same convention as usage-long-periods / usage-history-retention).
  process.env.TZ = "America/New_York";
  NOW = new Date(2026, 8, 29, 12, 30).getTime(); // local Tue 2026-09-29 12:30
});

afterAll(() => {
  delete process.env.TZ;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-savings-rollup-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
});

beforeEach(() => {
  adapter.run("DELETE FROM usageHistory");
  adapter.run("DELETE FROM usageRollup");
  adapter.run("DELETE FROM usageComboRollup");
});

const method = (saved, before = 50) => ({ tokensSavedEst: saved, tokensBeforeEst: before });
const savings = (byMethod, tokensBeforeEst = null) => ({
  savings: { byMethod, ...(tokensBeforeEst === null ? {} : { tokensBeforeEst }) },
});

async function save(entry) {
  const { timestamp, ...rest } = entry;
  await db.saveRequestUsageUnscoped({
    provider: "openai",
    model: "gpt-4o-mini",
    tokens: { prompt_tokens: 100, completion_tokens: 10 },
    cost: 0.001,
    endpoint: "/v1/chat/completions",
    ...rest,
    timestamp: new Date(timestamp).toISOString(),
  });
}

// Retained-legacy rows the writer cannot express (malformed / NULL meta).
function seedRaw(timestamp, meta) {
  adapter.run(
    `INSERT INTO usageHistory(timestamp, provider, model, meta) VALUES(?, 'openai', 'gpt-4o-mini', ?)`,
    [new Date(timestamp).toISOString(), meta],
  );
}

const rollupRows = () => adapter.all(`SELECT * FROM usageRollup ORDER BY dateKey`);
const comboRows = () => adapter.all(`SELECT * FROM usageComboRollup ORDER BY dateKey, comboName`);

describe("write path folds savings, combos and lastUsedAt", () => {
  it("multi-method rows accumulate per-method columns and one savingsRequests", async () => {
    await save({
      timestamp: NOW,
      meta: savings({ rtk: method(10, 100), headroom: method(-3, 7) }, 130),
    });
    await save({
      timestamp: NOW + 60_000,
      meta: savings({ pxpipe: method(5, 40), unknownm: method(2, 9) }, 45),
      comboName: "px-combo",
    });
    // Zero/negative-only methods contribute nothing.
    await save({
      timestamp: NOW + 120_000,
      meta: savings({ rtk: method(0), headroom: method(-3, 7) }, 7),
    });
    const rows = rollupRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      savingsSavedEst: 17,
      savingsBeforeEst: 175,
      savingsRequests: 2,
      rtkSavedEst: 10,
      rtkBeforeEst: 100,
      rtkRequests: 1,
      headroomSavedEst: 0,
      headroomBeforeEst: 0,
      headroomRequests: 0,
      pxpipeSavedEst: 5,
      pxpipeBeforeEst: 40,
      pxpipeRequests: 1,
      lastUsedAt: new Date(NOW + 120_000).toISOString(),
    });
    expect(comboRows()).toEqual([
      {
        dateKey: rows[0].dateKey,
        workspaceId: "",
        userId: "",
        apiKeyId: "local-no-key",
        comboName: "px-combo",
        requests: 1,
      },
    ]);
  });

  it("top-level tokensBeforeEst is stored, not the sum of method befores", async () => {
    await save({ timestamp: NOW, meta: savings({ rtk: method(10, 100) }, 999) });
    expect(rollupRows()[0]).toMatchObject({
      savingsBeforeEst: 999,
      rtkBeforeEst: 100,
      savingsSavedEst: 10,
    });
  });

  it("non-savings rows still fold lastUsedAt with zero savings columns", async () => {
    await save({ timestamp: NOW, meta: {} });
    expect(rollupRows()[0]).toMatchObject({
      savingsSavedEst: 0,
      savingsRequests: 0,
      lastUsedAt: new Date(NOW).toISOString(),
    });
  });

  it("rebuildRollupFromHistoryUnscoped reproduces the writer's fold", async () => {
    await save({
      timestamp: NOW - 86_400_000,
      meta: savings({ rtk: method(10, 100) }, 120),
      comboName: "c1",
    });
    await save({ timestamp: NOW, meta: savings({ pxpipe: method(4, 20) }, 24) });
    const writerRows = rollupRows();
    const writerCombos = comboRows();
    adapter.exec("DELETE FROM usageRollup; DELETE FROM usageComboRollup");
    rebuildRollupFromHistoryUnscoped(adapter);
    expect(rollupRows()).toEqual(writerRows);
    expect(comboRows()).toEqual(writerCombos);
  });
});

describe("parity 7d/30d/60d vs the history algorithm", () => {
  let t;

  beforeEach(async () => {
    t = await seedTenancy();
  });

  const scopedConds = (ctx, startIso, endIso) => {
    const conds = ["timestamp >= ?", "timestamp <= ?"];
    const params = [startIso, endIso];
    if (ctx) {
      conds.unshift("workspaceId = ?");
      params.unshift(ctx.workspaceId);
      if (ctx.userId) {
        conds.push("userId = ?");
        params.push(ctx.userId);
      }
    }
    return { sql: conds.join(" AND "), params };
  };

  const parseMeta = (raw) => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  /**
   * Pre-change getUsageSavings over usageHistory rows (the old loop from
   * usageRepo.js): per-method positive-only sums, top-level before, one
   * requestsWithSavings per row with rowSaved > 0, per-row list pricing.
   */
  async function oldSavings(ctx, period) {
    const { sql, params } = scopedConds(
      ctx,
      new Date(periodStart(period, NOW)).toISOString(),
      new Date(NOW).toISOString(),
    );
    const rows = adapter.all(`SELECT provider, model, meta FROM usageHistory WHERE ${sql}`, params);
    let tokensSavedEst = 0;
    let tokensBeforeEst = 0;
    let requestsWithSavings = 0;
    let costSavedEst = 0;
    let pricedRequests = 0;
    for (const row of rows) {
      const byMethod = parseMeta(row.meta)?.savings?.byMethod;
      if (!byMethod || typeof byMethod !== "object") continue;
      let rowSaved = 0;
      for (const m of Object.values(byMethod)) {
        const saved = Number(m?.tokensSavedEst) || 0;
        if (saved > 0) rowSaved += saved;
      }
      if (rowSaved <= 0) continue;
      tokensSavedEst += rowSaved;
      tokensBeforeEst += Number(parseMeta(row.meta).savings.tokensBeforeEst) || 0;
      requestsWithSavings += 1;
      // Old per-row pricing: saved tokens priced as uncached input.
      const pricing = row.model ? await getPricingForModel(row.provider, row.model) : null;
      if (pricing && Number(pricing.input) > 0) {
        costSavedEst += calculateCostFromTokens({ prompt_tokens: rowSaved }, pricing);
        pricedRequests += 1;
      }
    }
    return {
      tokensSavedEst,
      tokensBeforeEst,
      requestsWithSavings,
      costSavedEst: pricedRequests > 0 ? +costSavedEst.toFixed(6) : null,
      pricedRequests,
    };
  }

  /** Pre-change getHomeSummary combo counting + request count over history. */
  function oldHome(ctx, period) {
    const { sql, params } = scopedConds(
      ctx,
      new Date(periodStart(period, NOW)).toISOString(),
      new Date(NOW).toISOString(),
    );
    const rows = adapter.all(`SELECT meta FROM usageHistory WHERE ${sql}`, params);
    const counts = {};
    for (const row of rows) {
      const name = parseMeta(row.meta)?.comboName;
      if (typeof name === "string" && name) counts[name] = (counts[name] || 0) + 1;
    }
    const topCombos = Object.entries(counts)
      .map(([name, requests]) => ({ name, requests }))
      .sort((a, b) => b.requests - a.requests || (a.name < b.name ? -1 : 1))
      .slice(0, 5);
    return { requests: rows.length, topCombos };
  }

  it.each(["7d", "30d", "60d"])("%s savings match the history algorithm", async (period) => {
    const windowStart = periodStart(period, NOW); // local midnight of the first day
    const ws = t.shared.id;
    const user = t.a.user.id;
    await save({
      timestamp: windowStart,
      meta: savings({ rtk: method(10, 100), headroom: method(5, 60) }, 160),
      comboName: "alpha",
      workspaceId: ws,
      userId: user,
    });
    await save({
      timestamp: NOW,
      meta: savings({ pxpipe: method(4, 20), rtk: method(-2, 9) }, 24),
      comboName: "beta",
      workspaceId: ws,
      userId: user,
    });
    await save({ timestamp: NOW - 1, meta: savings({ rtk: method(0), headroom: method(0) }, 0) });
    await save({ timestamp: windowStart - 1000, meta: savings({ rtk: method(999, 999) }, 999) });
    // Unknown legacy method: headline-only contribution (no breakdown column).
    await save({
      timestamp: NOW - 2000,
      meta: savings({ legacy: method(7, 70) }, 70),
    });
    // Malformed / NULL meta (retained legacy rows) must count nowhere.
    seedRaw(NOW - 3000, "{bad json");
    seedRaw(NOW - 4000, null);
    rebuildRollupFromHistoryUnscoped(adapter);

    for (const ctx of [null, { workspaceId: ws }, { workspaceId: ws, userId: user }]) {
      const expected = await oldSavings(ctx, period);
      const result = await db.getUsageSavings(ctx, period, NOW);
      expect(result.tokensSavedEst).toBe(expected.tokensSavedEst);
      expect(result.tokensBeforeEst).toBe(expected.tokensBeforeEst);
      expect(result.requestsWithSavings).toBe(expected.requestsWithSavings);
      expect(result.costSavedEst).toBe(expected.costSavedEst);
      expect(result.pricedRequests).toBe(expected.pricedRequests);
    }
    const unscoped = await db.getUsageSavings(null, period, NOW);
    expect(unscoped.tokensSavedEst).toBeGreaterThan(0);
    // Canonical method order, breakdown filtered to the known methods.
    expect(unscoped.methods).toEqual(["rtk", "headroom", "pxpipe"]);
  });

  it.each(["7d", "30d", "60d"])("%s home summary matches history counting", async (period) => {
    const windowStart = periodStart(period, NOW);
    const ws = t.shared.id;
    const user = t.a.user.id;
    for (const [combo, at] of [
      ["alpha", windowStart],
      ["alpha", NOW],
      ["alpha", NOW - 500],
      ["gamma", NOW - 1000],
      ["gamma", NOW - 2000],
    ]) {
      await save({ timestamp: at, comboName: combo, workspaceId: ws, userId: user });
    }
    await save({ timestamp: NOW - 3000, workspaceId: ws, userId: user }); // no combo
    await save({ timestamp: windowStart - 1000, comboName: "old", workspaceId: ws, userId: user });

    for (const ctx of [null, { workspaceId: ws }, { workspaceId: ws, userId: user }]) {
      const expected = oldHome(ctx, period);
      const summary = await db.getHomeSummary(ctx, period, NOW);
      expect(summary.requests).toBe(expected.requests);
      expect(summary.topCombos).toEqual(expected.topCombos);
    }
    expect((await db.getHomeSummary(null, period, NOW)).topCombos[0]).toEqual({
      name: "alpha",
      requests: 3,
    });
  });
});

describe("migration 021", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-021-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("backfills savings/combos/lastUsedAt, preserves base measures, and is idempotent", async () => {
    const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
    const { runVersionedMigrations } = await import("@/lib/db/migrate.js");
    const { MIGRATIONS } = await import("@/lib/db/migrations/index.js");
    const m021 = (await import("@/lib/db/migrations/021-usage-savings-combo-rollup.js")).default;
    expect(MIGRATIONS.find((m) => m.version === 21).name).toBe("usage-savings-combo-rollup");

    const old = await createSqlJsAdapter(path.join(dir, "pre021.sqlite"));
    runVersionedMigrations(
      old,
      MIGRATIONS.filter((m) => m.version < 21),
    );
    expect(old.all(`PRAGMA table_info(usageRollup)`).map((c) => c.name)).not.toContain(
      "savingsSavedEst",
    );

    const ts = (h, day = 10) => new Date(2026, 0, day, h).toISOString();
    const hist = (t, meta) =>
      old.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
         VALUES(?, 'p', 'm', 'c1', '/v1/chat', 10, 5, 0.5, 'ok', '{}', ?)`,
        [t, meta == null ? null : JSON.stringify(meta)],
      );
    // Day 10: covered by an existing rollup row below.
    hist(ts(10), savings({ rtk: method(10, 100) }, 120));
    hist(ts(11), savings({ pxpipe: method(4, 20), legacyUnknown: method(3, 30) }, 24));
    hist(ts(12), null);
    // Day 11: never rolled up (legacy group) — combo-bearing, no savings.
    hist(ts(13, 11), { comboName: "solo-combo" });

    const insertRollup = (dateKey, requests, tokensIn, cost) =>
      old.run(
        `INSERT INTO usageRollup (dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint, requests, tokensIn, tokensOut, tokensCached, cost)
         VALUES (?, '', '', 'local-no-key', 'p', 'm', 'c1', '/v1/chat', ?, ?, 0, 0, ?)`,
        [dateKey, requests, tokensIn, cost],
      );
    insertRollup("2026-01-10", 3, 30, 1.5); // covered by history above
    insertRollup("2026-01-02", 9, 90, 4); // history pruned: must stay untouched

    const before = old.all(
      `SELECT dateKey, requests, tokensIn, tokensOut, tokensCached, cost FROM usageRollup ORDER BY dateKey`,
    );

    runVersionedMigrations(old);
    const rows = old.all(`SELECT * FROM usageRollup ORDER BY dateKey`);
    // Base measures of every pre-existing row are untouched (the new legacy
    // row on 2026-01-11 carries zero base measures by design).
    expect(
      rows
        .filter((r) => r.dateKey !== "2026-01-11")
        .map(({ dateKey, requests, tokensIn, tokensOut, tokensCached, cost }) => ({
          dateKey,
          requests,
          tokensIn,
          tokensOut,
          tokensCached,
          cost,
        })),
    ).toEqual(before);
    const day10 = rows.find((r) => r.dateKey === "2026-01-10");
    expect(day10).toMatchObject({
      requests: 3,
      savingsSavedEst: 17,
      savingsBeforeEst: 144,
      savingsRequests: 2,
      rtkSavedEst: 10,
      rtkBeforeEst: 100,
      rtkRequests: 1,
      pxpipeSavedEst: 4,
      pxpipeBeforeEst: 20,
      pxpipeRequests: 1,
      lastUsedAt: ts(12),
    });
    // Never-rolled-up legacy group: zero-measure row carrying lastUsedAt.
    const day11 = rows.find((r) => r.dateKey === "2026-01-11");
    expect(day11).toMatchObject({
      requests: 0,
      tokensIn: 0,
      cost: 0,
      savingsSavedEst: 0,
      savingsRequests: 0,
      lastUsedAt: ts(13, 11),
    });
    // Pruned-history day keeps its base measures and gets no savings.
    const day02 = rows.find((r) => r.dateKey === "2026-01-02");
    expect(day02).toMatchObject({
      requests: 9,
      savingsSavedEst: 0,
      savingsRequests: 0,
      lastUsedAt: "",
    });
    expect(old.all(`SELECT * FROM usageComboRollup`)).toEqual([
      {
        dateKey: "2026-01-11",
        workspaceId: "",
        userId: "",
        apiKeyId: "local-no-key",
        comboName: "solo-combo",
        requests: 1,
      },
    ]);

    // Idempotency: rerun with the marker, then again after clearing it.
    const snap = () => JSON.stringify(old.all(`SELECT * FROM usageRollup ORDER BY dateKey`));
    const comboSnap = () => JSON.stringify(old.all(`SELECT * FROM usageComboRollup`));
    const s1 = snap();
    const c1 = comboSnap();
    m021.up(old);
    expect(snap()).toBe(s1);
    expect(comboSnap()).toBe(c1);
    old.run(`DELETE FROM _meta WHERE key = 'usageSavingsComboBackfilled'`);
    m021.up(old);
    expect(snap()).toBe(s1);
    expect(comboSnap()).toBe(c1);
    old.close();
  });
});

describe("backfilled lastUsedAt is the exact per-local-day max", () => {
  // TZ is America/New_York (UTC-4 in September, UTC-5 in January). Rows sit on
  // both sides of local midnight (same UTC day, different local days) and on
  // both sides of UTC midnight (different UTC days, same local day).
  // Built lazily: TZ is only pinned in beforeAll, after describe-time collection.
  const fixture = () => {
    const at = (day, h, min) => new Date(2026, 8, day, h, min).toISOString();
    const rows = [
      at(28, 23, 30), // local 09-28, UTC 09-29 03:30
      at(28, 23, 59), // local 09-28 max
      at(29, 0, 5), // local 09-29, same UTC day as the rows above
      at(29, 19, 50), // local 09-29, UTC 23:50
      at(29, 20, 10), // local 09-29 max, UTC 09-30 00:10 (other UTC day)
      at(30, 0, 1), // local 09-30, UTC 09-30 04:01
    ];
    return {
      rows,
      expected: { "2026-09-28": rows[1], "2026-09-29": rows[4], "2026-09-30": rows[5] },
    };
  };
  const insert = (dbLike) => {
    for (const [index, t] of fixture().rows.toReversed().entries()) {
      // Sparse ids cross the 50,000-id boundary without allocating 50,000 rows.
      // Reverse timestamp order also proves that the merge keeps the maximum,
      // rather than simply the last chunk's value for a local day.
      const id = index < 2 ? index + 1 : 50_001 + index;
      dbLike.run(
        `INSERT INTO usageHistory(id, timestamp, provider, model, connectionId, endpoint, status, tokens) VALUES(?, ?, 'p', 'm', 'c1', '/v1/chat', 'ok', '{}')`,
        [id, t],
      );
    }
  };
  const lastUsedByDay = (dbLike) =>
    Object.fromEntries(
      dbLike
        .all(`SELECT dateKey, lastUsedAt FROM usageRollup ORDER BY dateKey`)
        .map((r) => [r.dateKey, r.lastUsedAt]),
    );

  it("backfillSavingsComboFromHistory matches the JS local day of each row", async () => {
    const { backfillSavingsComboFromHistory } = await import(
      "@/lib/db/helpers/usageSavingsRollup.js"
    );
    insert(adapter);
    adapter.run("DELETE FROM usageRollup");
    backfillSavingsComboFromHistory(adapter);
    expect(lastUsedByDay(adapter)).toEqual(fixture().expected);
  });

  it("migration 021 backfill matches the JS local day of each row", async () => {
    const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
    const { runVersionedMigrations } = await import("@/lib/db/migrate.js");
    const { MIGRATIONS } = await import("@/lib/db/migrations/index.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-021-tz-"));
    try {
      const old = await createSqlJsAdapter(path.join(dir, "pre021.sqlite"));
      runVersionedMigrations(
        old,
        MIGRATIONS.filter((m) => m.version < 21),
      );
      insert(old);
      runVersionedMigrations(old);
      expect(lastUsedByDay(old)).toEqual(fixture().expected);
      old.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("90d / all read only the rollup", () => {
  it("survives DELETE FROM usageHistory with identical output", async () => {
    const day = (n) => {
      const d = new Date(NOW);
      d.setDate(d.getDate() - n);
      return d.getTime();
    };
    await save({
      timestamp: day(1),
      meta: savings({ rtk: method(10, 100) }, 120),
      comboName: "alpha",
    });
    await save({ timestamp: day(45), meta: savings({ pxpipe: method(5, 50) }, 55) });
    await save({
      timestamp: day(120),
      meta: savings({ rtk: method(7, 70) }, 77),
      comboName: "zeta",
    });
    await save({
      timestamp: day(300),
      meta: savings({ headroom: method(9, 90) }, 99),
      comboName: "omega",
    });

    const before = {};
    for (const period of ["90d", "all"]) {
      before[period] = {
        savings: await db.getUsageSavings(null, period, NOW),
        home: await db.getHomeSummary(null, period, NOW),
      };
    }
    adapter.exec("DELETE FROM usageHistory");
    for (const period of ["90d", "all"]) {
      expect(await db.getUsageSavings(null, period, NOW)).toEqual(before[period].savings);
      expect(await db.getHomeSummary(null, period, NOW)).toEqual(before[period].home);
    }
    // The rollup-only reads still hold concrete expectations after the delete.
    expect((await db.getUsageSavings(null, "90d", NOW)).tokensSavedEst).toBe(15);
    expect((await db.getUsageSavings(null, "all", NOW)).tokensSavedEst).toBe(31);
    expect((await db.getHomeSummary(null, "all", NOW)).topCombos.map((c) => c.name)).toEqual([
      "alpha",
      "omega",
      "zeta",
    ]);
  });
});

describe("prunedBeforeTracking (rollup days without lastUsedAt)", () => {
  let t;

  beforeEach(async () => {
    t = await seedTenancy();
  });

  // A pre-migration-021 day whose history was pruned: requests, no lastUsedAt.
  function seedUntracked(dateKey, workspaceId = "") {
    adapter.run(
      `INSERT INTO usageRollup (dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint, requests, tokensIn, tokensOut, tokensCached, cost, lastUsedAt)
       VALUES (?, ?, '', 'local-no-key', 'p', 'm', 'c1', '/v1/chat', 4, 40, 0, 0, 0.1, '')`,
      [dateKey, workspaceId],
    );
  }

  const flag = async (ctx, period) =>
    (await db.getUsageSavings(ctx, period, NOW)).prunedBeforeTracking;

  it("is true for 90d and all when an untracked day falls inside the window", async () => {
    seedUntracked("2026-09-20");
    expect(await flag(null, "30d")).toBe(true);
    expect(await flag(null, "90d")).toBe(true);
    expect(await flag(null, "all")).toBe(true);
  });

  it("is false for a window that excludes the untracked day", async () => {
    seedUntracked("2026-08-01"); // 59 days before 2026-09-29: outside 30d, inside 90d
    expect(await flag(null, "30d")).toBe(false);
    expect(await flag(null, "90d")).toBe(true);
    expect(await flag(null, "all")).toBe(true);
  });

  it("is false for rows written through the normal save path", async () => {
    await save({ timestamp: NOW - 2 * 86_400_000, meta: savings({ rtk: method(10, 100) }, 120) });
    await save({ timestamp: NOW - 40 * 86_400_000, comboName: "alpha" });
    for (const period of ["today", "24h", "7d", "30d", "60d", "90d", "all"]) {
      expect(await flag(null, period)).toBe(false);
    }
  });

  it("is false for history-backed periods even with untracked rollup days", async () => {
    seedUntracked("2026-09-29");
    expect(await flag(null, "today")).toBe(false);
    expect(await flag(null, "24h")).toBe(false);
  });

  it("is scoped to the caller's workspace", async () => {
    seedUntracked("2026-09-20", t.a.personal);
    expect(await flag({ workspaceId: t.a.personal }, "90d")).toBe(true);
    expect(await flag({ workspaceId: t.b.personal }, "90d")).toBe(false);
    expect(await flag({ workspaceId: t.b.personal }, "all")).toBe(false);
  });
});

describe("getHomeSummary prunedBeforeTracking (YAN-1701)", () => {
  let t;

  beforeEach(async () => {
    t = await seedTenancy();
  });

  // A pre-migration-021 day whose history was pruned: requests, no lastUsedAt.
  function seedUntrackedHome(dateKey, workspaceId = "") {
    adapter.run(
      `INSERT INTO usageRollup (dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint, requests, tokensIn, tokensOut, tokensCached, cost, lastUsedAt)
       VALUES (?, ?, '', 'local-no-key', 'p', 'm', 'c1', '/v1/chat', 4, 40, 0, 0, 0.1, '')`,
      [dateKey, workspaceId],
    );
  }

  const summaryFlag = async (ctx, period) =>
    (await db.getHomeSummary(ctx, period, NOW)).prunedBeforeTracking;

  it("is true for a rollup window holding an untracked day", async () => {
    seedUntrackedHome("2026-09-25"); // inside 7d (2026-09-23..29)
    expect(await summaryFlag(null, "7d")).toBe(true);
    expect(await summaryFlag(null, "90d")).toBe(true);
    expect(await summaryFlag(null, "all")).toBe(true);
  });

  it("is false for a window without an untracked day", async () => {
    seedUntrackedHome("2026-08-01"); // 59 days out: inside 90d/all, outside 30d/7d
    expect(await summaryFlag(null, "7d")).toBe(false);
    expect(await summaryFlag(null, "30d")).toBe(false);
    expect(await summaryFlag(null, "90d")).toBe(true);
    // A normally written row never flags.
    await save({ timestamp: NOW - 2 * 86_400_000, meta: savings({ rtk: method(10, 100) }, 120) });
    expect(await summaryFlag(null, "30d")).toBe(false);
  });

  it("is false for the history-backed today/24h windows", async () => {
    seedUntrackedHome("2026-09-29");
    expect(await summaryFlag(null, "today")).toBe(false);
    expect(await summaryFlag(null, "24h")).toBe(false);
  });

  it("is scoped to the caller's workspace", async () => {
    seedUntrackedHome("2026-09-20", t.a.personal);
    expect(await summaryFlag({ workspaceId: t.a.personal }, "90d")).toBe(true);
    expect(await summaryFlag({ workspaceId: t.b.personal }, "90d")).toBe(false);
    expect(await summaryFlag(null, "90d")).toBe(true); // unscoped sees every workspace
  });
});

describe("migration 022 (YAN-1702 untracked-day partial indexes)", () => {
  let dir;
  let db22;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-022-"));
    const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
    db22 = await createSqlJsAdapter(path.join(dir, "pre022.sqlite"));
  });

  afterEach(() => {
    db22.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const indexNames = (target) =>
    target
      .all(`PRAGMA index_list(usageRollup)`)
      .map((i) => i.name)
      .filter((n) => !n.startsWith("sqlite_"));

  it("applies on an existing DB and is idempotent", async () => {
    const { runVersionedMigrations } = await import("@/lib/db/migrate.js");
    const { MIGRATIONS } = await import("@/lib/db/migrations/index.js");
    const m022 = (await import("@/lib/db/migrations/022-usage-untracked-index.js")).default;
    expect(MIGRATIONS.find((m) => m.version === 22)).toBe(m022);

    runVersionedMigrations(
      db22,
      MIGRATIONS.filter((m) => m.version < 22),
    );
    expect(indexNames(db22)).not.toContain("idx_ur_untracked");
    expect(indexNames(db22)).not.toContain("idx_ur_untracked_ws");

    runVersionedMigrations(db22);
    for (const name of ["idx_ur_untracked", "idx_ur_untracked_ws"]) {
      expect(indexNames(db22)).toContain(name);
    }

    // Idempotent: rerunning the migration directly changes nothing.
    const before = [...indexNames(db22)].sort();
    m022.up(db22);
    m022.up(db22);
    expect([...indexNames(db22)].sort()).toEqual(before);
  });

  it("plans the flag probe through idx_ur_untracked* (unscoped and scoped)", async () => {
    const { runVersionedMigrations } = await import("@/lib/db/migrate.js");
    runVersionedMigrations(db22);
    // A spread of tracked rows plus one untracked day; sqlite picks a partial
    // index only when the WHERE matches its predicate.
    for (let d = 1; d <= 14; d++) {
      const day = `2026-01-${String(d).padStart(2, "0")}`;
      for (const ws of ["ws-a", "ws-b"]) {
        db22.run(
          "INSERT INTO usageRollup (dateKey, workspaceId, requests, lastUsedAt) VALUES (?, ?, 5, '2026-01-01T00:00:00Z')",
          [day, ws],
        );
      }
    }
    db22.run(
      "INSERT INTO usageRollup (dateKey, workspaceId, requests, lastUsedAt) VALUES ('2025-12-01', 'ws-b', 7, '')",
    );

    // Capture the real SQL+params hasUntrackedRollupDays emits (no hand copy),
    // then ask sqlite how it would plan that exact statement on the real DB.
    const capture = (ctx, startKey = null, endKey = null) => {
      let captured;
      const spyDb = {
        get(sql, params) {
          captured = [sql, params];
          return undefined;
        },
      };
      hasUntrackedRollupDays(ctx, spyDb, startKey, endKey);
      return captured;
    };
    const planOf = ([sql, params]) =>
      db22
        .all(`EXPLAIN QUERY PLAN ${sql}`, params)
        .map((r) => r.detail)
        .join(" | ");

    // Unscoped window and all-time probes use the dateKey partial index.
    expect(planOf(capture(null, "2026-01-01", "2026-02-01"))).toMatch(/idx_ur_untracked\b(?!_ws)/);
    expect(planOf(capture(null))).toMatch(/idx_ur_untracked\b(?!_ws)/);
    // Workspace-scoped probes use the workspace-leading partial index.
    expect(planOf(capture({ workspaceId: "ws-b" }, "2026-01-01", "2026-02-01"))).toContain(
      "idx_ur_untracked_ws",
    );
    expect(planOf(capture({ workspaceId: "ws-b" }))).toContain("idx_ur_untracked_ws");

    // Sanity: the real probe on the real DB finds only the untracked day.
    expect(hasUntrackedRollupDays(null, db22, "2025-11-01", null)).toBe(true);
    expect(hasUntrackedRollupDays(null, db22, "2025-12-02", null)).toBe(false);
    expect(hasUntrackedRollupDays({ workspaceId: "ws-a" }, db22, "2025-11-01", null)).toBe(false);
    expect(hasUntrackedRollupDays({ workspaceId: "ws-b" }, db22, "2025-11-01", null)).toBe(true);
  });
});
