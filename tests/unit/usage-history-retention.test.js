// YAN-424: usageHistory retention. Pruning must never change what the rollup
// (stats/charts) or budgets (spentFor via usageBudgetCarry) report, never
// delete the newest row per workspace, never prune days the rollup does not
// cover, and is a no-op at 0. Settings validation covers PATCH + config import
// (both run validateSettingsBody).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import { getChartData, getUsageStats } from "@/lib/db/repos/usageStatsRepo.js";
import { getRollupUsageTotals } from "@/lib/db/repos/usageRollupTotals.js";
import { saveRequestUsageUnscoped } from "@/lib/db/repos/usageRepo.js";
import { localDateKey } from "@/lib/db/repos/usageRollupRepo.js";
import { pruneUsageHistoryUnscoped } from "@/lib/db/repos/usageRetentionRepo.js";
import { spentFor } from "@/sse/services/budgetGuard.js";
import { validateSettingsBody } from "@/app/api/settings/validateSettings.js";
import { readInstanceTableSections } from "@/lib/db/helpers/instanceSnapshotTables.js";
import { seedTenancy } from "../setup/tenancyHarness.js";

const NOW = Date.UTC(2026, 9, 19, 12); // Mon 2026-10-19 12:00Z
const ago = (days, hour = 12) => {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

// Pin a DST zone so local-day expectations never depend on the host zone.
let prevTz;
beforeAll(() => {
  prevTz = process.env.TZ;
  process.env.TZ = "America/New_York";
});
afterAll(() => {
  if (prevTz === undefined) delete process.env.TZ;
  else process.env.TZ = prevTz;
});

let db;
let t;
const histCount = () => db.get(`SELECT COUNT(*) AS n FROM usageHistory`).n;

async function save(timestamp, over = {}) {
  await saveRequestUsageUnscoped({
    provider: "openai",
    model: "gpt-x",
    timestamp,
    tokens: { prompt_tokens: 10, completion_tokens: 5 },
    cost: 0.5,
    endpoint: "/v1/chat/completions",
    ...over,
  });
}

async function seed() {
  const ws = t.shared.id;
  const user = t.a.user.id;
  for (const n of [0, 1, 2, 3, 5, 9, 14, 20, 35, 70, 120, 300]) {
    await save(ago(n, 12), { workspaceId: ws, userId: user, grantId: n % 2 ? "g1" : null });
  }
  // UTC-day edge rows + a failed one (rolled up, not budget-settled) + notional.
  await save(ago(12, 23), { workspaceId: ws, userId: user });
  await save(ago(11, 0), { workspaceId: ws, userId: user });
  await save(ago(15, 12), { workspaceId: ws, userId: user, status: "error" });
  await save(ago(16, 12), { workspaceId: ws, userId: user, meta: { notional: true } });
  // Ownerless group (NULL workspace): only old rows.
  await save(ago(60, 12));
  await save(ago(61, 12));
}

beforeEach(async () => {
  db = await getAdapter();
  t = await seedTenancy();
  db.exec("DELETE FROM usageHistory; DELETE FROM usageRollup; DELETE FROM usageBudgetCarry");
  await seed();
});

const rollupView = async () => ({
  d90: await getRollupUsageTotals(null, "90d"),
  all: await getRollupUsageTotals(null, "all"),
  chart30: (await getChartData(null, "30d")).map((b) => [b.requests, b.cost]),
  chartAll: (await getChartData(null, "all")).map((b) => [b.requests, b.cost]),
});

describe("usageHistory retention", () => {
  it("keeps rollup-backed totals identical and the newest row per workspace group", async () => {
    const before = await rollupView();
    const total = histCount();
    const r = await pruneUsageHistoryUnscoped(7, { now: NOW, batchSize: 3 });
    expect(r.deleted).toBeGreaterThan(0);
    expect(r.batches).toBeGreaterThan(1); // batched
    expect(histCount()).toBe(total - r.deleted);
    expect(await rollupView()).toEqual(before);
    // Newest row of each group survived even though only old rows remain for NULL.
    const orphans = db.all(`SELECT timestamp FROM usageHistory WHERE workspaceId IS NULL`);
    expect(orphans.map((r) => r.timestamp)).toEqual([ago(60, 12)]);
    expect(
      db.get(
        `SELECT COUNT(*) AS n FROM usageHistory WHERE timestamp < ? AND workspaceId IS NOT NULL`,
        [ago(10)],
      ).n,
    ).toBe(0);
    // Everything inside the retention window is intact.
    expect(
      db.get(`SELECT COUNT(*) AS n FROM usageHistory WHERE timestamp >= ?`, [ago(7, 0)]).n,
    ).toBe(5);
  });

  it("with N=2 leaves today/24h stats untouched", async () => {
    const before = [await getUsageStats(null, "today"), await getUsageStats(null, "24h")];
    await pruneUsageHistoryUnscoped(2, { now: NOW });
    const after = [await getUsageStats(null, "today"), await getUsageStats(null, "24h")];
    for (const i of [0, 1]) {
      expect(after[i].totalRequests).toBe(before[i].totalRequests);
      expect(after[i].totalCost).toBe(before[i].totalCost);
    }
  });

  it("deletes nothing for 0 or invalid retention", async () => {
    const total = histCount();
    for (const v of [0, 1, -3, 2.5, NaN, "x", null]) {
      expect((await pruneUsageHistoryUnscoped(v, { now: NOW })).deleted).toBe(0);
    }
    expect(histCount()).toBe(total);
  });

  it("skips a day whose history is not covered by the rollup (legacy)", async () => {
    // Raw legacy row: in usageHistory, never rolled up.
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, 'openai', 'gpt-x', '/v1/chat/completions', 1, 1, 0.1, 'ok', '{}', '{}')`,
      [ago(40, 12)],
    );
    const r = await pruneUsageHistoryUnscoped(7, { now: NOW });
    expect(r.skippedDays).toBe(1);
    expect(
      db.get(`SELECT COUNT(*) AS n FROM usageHistory WHERE timestamp = ?`, [ago(40, 12)]).n,
    ).toBe(1);
    // A rolled-up old day was still pruned.
    expect(
      db.get(`SELECT COUNT(*) AS n FROM usageHistory WHERE timestamp = ?`, [ago(120, 12)]).n,
    ).toBe(0);
  });
});

describe("budget exactness after pruning", () => {
  it("spentFor is identical for every scope and window", async () => {
    const ws = t.shared.id;
    const user = t.a.user.id;
    const budgets = [];
    for (const window of ["day", "week", "month", "total"]) {
      budgets.push({ scopeType: "workspace", scopeId: ws, window });
      budgets.push({ scopeType: "user", scopeId: user, window });
      budgets.push({ scopeType: "membership", scopeId: `${ws}:${user}`, window });
      budgets.push({ scopeType: "grant", scopeId: "g1", window });
    }
    const read = () => budgets.map((b) => spentFor(db, b, NOW));
    const before = read();
    expect(before.find((_, i) => budgets[i].window === "total").requests).toBeGreaterThan(5);
    const r = await pruneUsageHistoryUnscoped(2, { now: NOW, batchSize: 4 });
    expect(r.deleted).toBeGreaterThan(5);
    const after = read();
    for (const [i, b] of after.entries()) {
      expect(b.requests, `${budgets[i].scopeType}/${budgets[i].window}`).toBe(before[i].requests);
      expect(b.tokens).toBe(before[i].tokens);
      expect(b.usd).toBeCloseTo(before[i].usd, 9);
      expect(b.notionalUsd).toBeCloseTo(before[i].notionalUsd, 9);
    }
    // A second run is a no-op.
    expect((await pruneUsageHistoryUnscoped(2, { now: NOW })).deleted).toBe(0);
  });
});

describe("usageHistoryRetentionDays validation", () => {
  it.each([0, 2, 30, 3650])("accepts %s", (v) => {
    expect(validateSettingsBody({ usageHistoryRetentionDays: v })).toBeFalsy();
  });
  it.each([1, -1, 3651, "x", "7", 2.5, null, true])("rejects %j", (v) => {
    expect(validateSettingsBody({ usageHistoryRetentionDays: v })).toMatch(
      /usageHistoryRetentionDays/,
    );
  });
});

describe("retention safety rules", () => {
  const rawRow = (timestamp, over = {}) =>
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, workspaceId, apiKeyId) VALUES(?, 'openai', 'gpt-x', '/v1/chat/completions', NULL, NULL, 0.1, 'ok', '{}', '{}', ?, ?)`,
      [timestamp, over.workspaceId ?? null, over.apiKeyId ?? "local-no-key"],
    );

  it("never deletes rows whose timestamp is not canonical ISO, and counts them", async () => {
    const odd = "2026-01-05 10:00:00"; // sorts inside the old range, not toISOString() shaped
    rawRow(odd);
    const r = await pruneUsageHistoryUnscoped(7, { now: NOW });
    expect(r.nonCanonicalRows).toBeGreaterThanOrEqual(1);
    expect(db.get(`SELECT COUNT(*) AS n FROM usageHistory WHERE timestamp = ?`, [odd]).n).toBe(1);
  });

  it("keeps the newest row of every API key so lastUsed survives", async () => {
    const ws = t.shared.id;
    // Legacy key storage in the test DB cannot attribute keys through the write
    // path, so seed history + rollup together the way a hashed instance would.
    for (const n of [100, 90]) {
      const ts = ago(n, 9);
      rawRow(ts, { workspaceId: ws, apiKeyId: "k-old" });
      db.run(
        `INSERT INTO usageRollup(dateKey, workspaceId, apiKeyId, requests) VALUES(?, ?, 'k-old', 1)`,
        [localDateKey(ts), ws],
      );
    }
    const lastBefore = db.get(
      `SELECT MAX(timestamp) AS ts FROM usageHistory WHERE apiKeyId = 'k-old'`,
    ).ts;
    await pruneUsageHistoryUnscoped(7, { now: NOW });
    const lastAfter = db.get(
      `SELECT MAX(timestamp) AS ts FROM usageHistory WHERE apiKeyId = 'k-old'`,
    ).ts;
    expect(lastAfter).toBe(lastBefore);
    expect(db.get(`SELECT COUNT(*) AS n FROM usageHistory WHERE apiKeyId = 'k-old'`).n).toBe(1);
  });

  it("treats NULL token columns as 0 on both the fold and spentFor sides", async () => {
    const ws = t.shared.id;
    rawRow(ago(30, 12), { workspaceId: ws });
    const rollupBefore = db.get(`SELECT COUNT(*) AS n FROM usageHistory`).n;
    // Roll the raw row up too so the day is eligible.
    db.run(
      `INSERT INTO usageRollup(dateKey, workspaceId, requests) VALUES(?, ?, 1)
       ON CONFLICT(dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint) DO NOTHING`,
      [localDateKey(ago(30, 12)), ws],
    );
    const b = { scopeType: "workspace", scopeId: ws, window: "total" };
    const before = spentFor(db, b, NOW);
    await pruneUsageHistoryUnscoped(7, { now: NOW });
    expect(db.get(`SELECT COUNT(*) AS n FROM usageHistory`).n).toBeLessThan(rollupBefore);
    expect(spentFor(db, b, NOW)).toEqual(before);
  });

  it("rolls the whole batch back when the delete count differs from the selection", async () => {
    const total = histCount();
    const carry = db.get(`SELECT COUNT(*) AS n FROM usageBudgetCarry`).n;
    const realRun = db.run.bind(db);
    const spy = vi.spyOn(db, "run").mockImplementation((sql, params) => {
      const r = realRun(sql, params);
      return /^DELETE FROM usageHistory/.test(sql) ? { ...r, changes: r.changes - 1 } : r;
    });
    await expect(pruneUsageHistoryUnscoped(7, { now: NOW })).rejects.toThrow(/selected rows/);
    spy.mockRestore();
    expect(histCount()).toBe(total);
    expect(db.get(`SELECT COUNT(*) AS n FROM usageBudgetCarry`).n).toBe(carry);
  });
});

describe("carry follows deleted workspaces and users", () => {
  it("merges a deleted workspace's carry into the unknown attribution without breaking the PK", async () => {
    const { deleteWorkspaceUnscoped } = await import("@/lib/db/repos/workspacesRepo.js");
    const ws = t.shared.id;
    const user = t.a.user.id;
    db.run(
      `INSERT INTO usageBudgetCarry(day, workspaceId, userId, apiKeyId, grantId, usd, tokens, requests, notionalUsd) VALUES('2026-10-01', ?, ?, 'k', '', 2, 20, 2, 1), ('2026-10-01', '', ?, 'k', '', 1, 10, 1, 0)`,
      [ws, user, user],
    );
    await deleteWorkspaceUnscoped(db, ws);
    expect(db.all(`SELECT * FROM usageBudgetCarry WHERE workspaceId = ?`, [ws])).toEqual([]);
    expect(
      db.all(
        `SELECT workspaceId, userId, usd, tokens, requests, notionalUsd FROM usageBudgetCarry`,
      ),
    ).toEqual([{ workspaceId: "", userId: user, usd: 3, tokens: 30, requests: 3, notionalUsd: 1 }]);
  });

  it("migration 019 is idempotent", async () => {
    const m019 = (await import("@/lib/db/migrations/019-usage-budget-carry.js")).default;
    db.run(
      `INSERT INTO usageBudgetCarry(day, usd, tokens, requests, notionalUsd) VALUES('2026-10-01', 1, 1, 1, 0)`,
    );
    expect(() => m019.up(db)).not.toThrow();
    expect(() => m019.up(db)).not.toThrow();
    expect(db.get(`SELECT COUNT(*) AS n FROM usageBudgetCarry`).n).toBe(1);
    const idx = db.all(`PRAGMA index_list(usageBudgetCarry)`).map((i) => i.name);
    expect(idx).toEqual(
      expect.arrayContaining([
        "idx_ubc_ws_day",
        "idx_ubc_user_day",
        "idx_ubc_key_day",
        "idx_ubc_grant_day",
      ]),
    );
  });
});

describe("retention follow-ups (PR review)", () => {
  it("keeps the newest row per (workspace, member) so member-scoped last activity survives", async () => {
    const ws = t.shared.id;
    const b = t.b.user.id;
    await save(ago(50, 8), { workspaceId: ws, userId: b });
    await save(ago(40, 8), { workspaceId: ws, userId: b });
    await pruneUsageHistoryUnscoped(7, { now: NOW });
    const rows = db.all(`SELECT timestamp FROM usageHistory WHERE workspaceId = ? AND userId = ?`, [
      ws,
      b,
    ]);
    expect(rows.map((r) => r.timestamp)).toEqual([ago(40, 8)]);
  });

  it("counts non-canonical rows per day without scanning in one query", async () => {
    for (const odd of ["2026-01-05 10:00:00", "2026-03-09 10:00:00", "1999-garbage"]) {
      db.run(
        `INSERT INTO usageHistory(timestamp, provider, model, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, 'openai', 'gpt-x', '/v1/x', 1, 1, 0.1, 'ok', '{}', '{}')`,
        [odd],
      );
    }
    const r = await pruneUsageHistoryUnscoped(7, { now: NOW });
    expect(r.nonCanonicalRows).toBe(3);
  });

  it("remaps retained carry rows of dead workspaces/users to '' and merges by primary key", () => {
    const rows = [
      ["2026-10-01", "w-live", "u-live", 1],
      ["2026-10-01", "w-dead", "u-live", 2],
      ["2026-10-01", "", "u-live", 4],
      ["2026-10-01", "w-dead2", "u-dead", 8],
      ["2026-10-01", "", "", 16],
    ].map(([day, workspaceId, userId, n]) => ({
      day,
      workspaceId,
      userId,
      apiKeyId: "k",
      grantId: "",
      usd: n,
      tokens: n,
      requests: n,
      notionalUsd: n,
    }));
    const fake = { all: (sql) => (/usageBudgetCarry/.test(sql) ? structuredClone(rows) : []) };
    const refs = { workspaces: new Set(["w-live"]), users: new Set(["u-live"]) };
    const out = readInstanceTableSections(fake, {}, refs).usageBudgetCarry;
    const byKey = Object.fromEntries(out.map((r) => [`${r.workspaceId}|${r.userId}`, r]));
    expect(Object.keys(byKey).sort()).toEqual(["w-live|u-live", "|", "|u-live"].sort());
    expect(byKey["|u-live"]).toMatchObject({ usd: 6, tokens: 6, requests: 6, notionalUsd: 6 });
    expect(byKey["|"]).toMatchObject({ usd: 24, requests: 24 });
    expect(byKey["w-live|u-live"].usd).toBe(1);
  });

  it("reports the history row count capped, with an honest flag", async () => {
    const { getUsageHistoryStatsUnscoped } = await import("@/lib/db/repos/usageRetentionRepo.js");
    const total = histCount();
    const exact = await getUsageHistoryStatsUnscoped();
    expect(exact).toMatchObject({ rows: total, capped: false });
    expect(exact.oldest).toBeTruthy();
    expect(await getUsageHistoryStatsUnscoped({ cap: 5 })).toMatchObject({ rows: 5, capped: true });
  });

  it("does not cache a failed stats read in the environment route", async () => {
    vi.resetModules();
    const repo = await import("@/lib/db/repos/usageRetentionRepo.js");
    const spy = vi
      .spyOn(repo, "getUsageHistoryStatsUnscoped")
      .mockRejectedValueOnce(new Error("boom"));
    const { GET } = await import("@/app/api/settings/environment/route.js");
    const first = await (
      await GET(new Request("http://localhost/api/settings/environment"))
    ).json();
    expect(first.usageHistoryRows).toBeNull();
    const second = await (
      await GET(new Request("http://localhost/api/settings/environment"))
    ).json();
    expect(typeof second.usageHistoryRows).toBe("number");
    expect(second.usageHistoryRowsCapped).toBe(false);
    spy.mockRestore();
  });
});
