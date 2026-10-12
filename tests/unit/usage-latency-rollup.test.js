// YAN-771: edit-prediction latency / empty rate for day periods come from
// usageRollup columns (full window, no per-request history load). Covers the
// read path past LATENCY_SAMPLE_CAP, scope isolation, writer, rebuild, the
// 017 upgrade, bootstrap adoption and snapshot parity.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import { getUsageStats } from "@/lib/db/repos/usageStatsRepo.js";
import { saveRequestUsageUnscoped } from "@/lib/db/repos/usageRepo.js";
import { adoptOwnerlessRowsUnscoped } from "@/lib/db/repos/ownership.js";
import {
  cutoffDateKey,
  localDateKey,
  rebuildRollupFromHistoryUnscoped,
} from "@/lib/db/repos/usageRollupRepo.js";
import {
  insertInstanceTableSections,
  validateInstanceTableSections,
} from "@/lib/db/helpers/instanceSnapshotTables.js";
import { LATENCY_BOUNDS } from "@/lib/db/helpers/usageLatencyRollup.js";

const bins = (pairs) => {
  const b = LATENCY_BOUNDS.map(() => 0);
  for (const [i, n] of pairs) b[i] = n;
  return JSON.stringify(b);
};
const dayAgo = (n) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return localDateKey(d);
};

let db;
// Direct rollup rows (no FKs): lets a test hold a window far larger than the sample cap.
function rollup(dateKey, over = {}) {
  const r = {
    workspaceId: "",
    userId: "",
    apiKeyId: "local-no-key",
    provider: "openai",
    model: "fim-m",
    connectionId: "",
    endpoint: "completions",
    requests: 0,
    latencySumMs: 0,
    latencyCount: 0,
    emptyCount: 0,
    latencyRequests: 0,
    latencyHistogram: bins([]),
    ...over,
  };
  db.run(
    `INSERT INTO usageRollup (dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint, requests, latencySumMs, latencyCount, emptyCount, latencyRequests, latencyHistogram)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      dateKey,
      r.workspaceId,
      r.userId,
      r.apiKeyId,
      r.provider,
      r.model,
      r.connectionId,
      r.endpoint,
      r.requests,
      r.latencySumMs,
      r.latencyCount,
      r.emptyCount,
      r.latencyRequests,
      r.latencyHistogram,
    ],
  );
}

beforeEach(async () => {
  db = await getAdapter();
  db.exec("DELETE FROM usageHistory; DELETE FROM usageRollup");
});

describe("day-period latency reads the rollup (YAN-771)", () => {
  it("covers a window far past the sample cap without loading per-request rows", async () => {
    // 30000 samples > LATENCY_SAMPLE_CAP (20000); usageHistory stays empty.
    rollup(dayAgo(1), {
      requests: 15000,
      latencySumMs: 15000 * 3000,
      latencyCount: 15000,
      latencyRequests: 15000,
      latencyHistogram: bins([[6, 15000]]),
    });
    rollup(dayAgo(5), {
      requests: 15000,
      latencySumMs: 15000 * 100,
      latencyCount: 15000,
      emptyCount: 3000,
      latencyRequests: 15000,
      latencyHistogram: bins([[1, 15000]]),
    });
    // Outside 7d (cutoff = today-6) but inside 30d.
    rollup(dayAgo(10), {
      requests: 10,
      latencySumMs: 10 * 60000,
      latencyCount: 10,
      latencyRequests: 10,
      latencyHistogram: bins([[10, 10]]),
    });
    const all = vi.spyOn(db, "all");
    try {
      const s7 = await getUsageStats(null, "7d");
      expect(s7.endpointLatency.completions).toEqual({
        latencyAvgMs: 1550,
        latencyP50Ms: 100,
        emptyRate: 0.1,
        samples: 30000,
      });
      expect(Object.values(s7.byEndpoint)[0]).toMatchObject({
        endpoint: "completions",
        latencyAvgMs: 1550,
        emptyRate: 0.1,
      });
      expect(all.mock.calls.every(([sql]) => !/latencyMs|\$\.empty/.test(sql))).toBe(true);

      const s30 = await getUsageStats(null, "30d");
      expect(s30.endpointLatency.completions.samples).toBe(30010);
      expect(s30.endpointLatency.completions.latencyAvgMs).toBe(
        Math.round((15000 * 3000 + 15000 * 100 + 10 * 60000) / 30010),
      );
    } finally {
      all.mockRestore();
    }
  });

  it("only counts rollup rows of the scoped workspace / user / key", async () => {
    const base = { requests: 4, latencyCount: 4, latencyRequests: 4 };
    rollup(dayAgo(0), {
      ...base,
      workspaceId: "wA",
      userId: "u1",
      apiKeyId: "k1",
      latencySumMs: 400,
      latencyHistogram: bins([[1, 4]]),
    });
    rollup(dayAgo(0), {
      ...base,
      workspaceId: "wA",
      userId: "u2",
      apiKeyId: "k2",
      latencySumMs: 8000,
      latencyHistogram: bins([[5, 4]]),
    });
    rollup(dayAgo(0), {
      ...base,
      workspaceId: "wB",
      userId: "u3",
      apiKeyId: "k3",
      latencySumMs: 160000,
      latencyHistogram: bins([[8, 4]]),
    });
    const avg = async (ctx) =>
      (await getUsageStats(ctx, "7d")).endpointLatency.completions?.latencyAvgMs ?? null;
    expect(await avg({ workspaceId: "wA", userId: "u1" })).toBe(100);
    expect(await avg({ workspaceId: "wA", apiKeyId: "k2" })).toBe(2000);
    expect(await avg({ workspaceId: "wA" })).toBe(1050);
    expect(await avg({ workspaceId: "wB", userId: "u1" })).toBeNull();
    expect(await avg({ workspaceId: "wC" })).toBeNull();
    expect(await avg(null)).toBe(Math.round((400 + 8000 + 160000) / 12));
  });

  it("a corrupt stored histogram cannot break stats: counts/avg survive, bad bins dropped", async () => {
    const bad = ["not json", "{}", '[1,null,"x"]', "[0]", "[1,-2,0,0,0,0,0,0,0,0,0,1]"];
    rollup(dayAgo(0), {
      requests: 2,
      latencySumMs: 200,
      latencyCount: 2,
      latencyRequests: 2,
      latencyHistogram: bins([[1, 2]]),
    });
    for (const [i, h] of bad.entries()) {
      rollup(dayAgo(1), {
        model: `bad${i}`,
        requests: 2,
        latencySumMs: 600,
        latencyCount: 2,
        latencyRequests: 2,
        latencyHistogram: h,
      });
    }
    const stats = await getUsageStats(null, "7d");
    // The valid row alone: p50 interpolates within its (0,100] bin.
    const good = Object.values(stats.byEndpoint).find((r) => r.rawModel === "fim-m");
    expect(good).toMatchObject({ latencyAvgMs: 100, latencyP50Ms: 50 });
    // Mixed window: exact counts/avg preserved; p50 degrades to null (median
    // rank lies beyond the surviving bins) instead of throwing.
    expect(stats.endpointLatency.completions).toEqual({
      latencyAvgMs: Math.round(3200 / 12),
      latencyP50Ms: null,
      emptyRate: 0,
      samples: 12,
    });
    // Each corrupt row on its own: still a valid summary, null p50.
    const broken = Object.values(stats.byEndpoint).find((r) => r.rawModel === "bad0");
    expect(broken).toMatchObject({ latencyAvgMs: 300, latencyP50Ms: null });
  });

  it("writer folds latency, empty and request counts; non-numeric latency is not a sample", async () => {
    const t = new Date().toISOString();
    const save = (meta, endpoint = "completions") =>
      saveRequestUsageUnscoped({
        provider: "openai",
        model: "fim-m",
        endpoint,
        timestamp: t,
        tokens: { prompt_tokens: 1, completion_tokens: 1 },
        status: "ok",
        meta,
      });
    await save({ latencyMs: 100 });
    await save({ latencyMs: 300, empty: true });
    await save({ latencyMs: "bad" });
    await save({ latencyMs: 5000 }, "/v1/chat/completions");
    const row = db.get(`SELECT * FROM usageRollup WHERE endpoint = 'completions'`);
    expect(row).toMatchObject({
      requests: 3,
      latencySumMs: 400,
      latencyCount: 2,
      emptyCount: 1,
      latencyRequests: 3,
    });
    expect(JSON.parse(row.latencyHistogram)).toEqual(
      JSON.parse(
        bins([
          [1, 1],
          [3, 1],
        ]),
      ),
    );
    expect(
      db.get(`SELECT latencyRequests AS n FROM usageRollup WHERE endpoint LIKE '/v1%'`).n,
    ).toBe(0);
  });

  it("rebuild from history yields the same latency columns as the writer", async () => {
    const t = new Date().toISOString();
    for (const [ms, empty] of [
      [100, false],
      [300, true],
    ]) {
      await saveRequestUsageUnscoped({
        provider: "openai",
        model: "fim-m",
        endpoint: "completions",
        timestamp: t,
        tokens: { prompt_tokens: 1, completion_tokens: 1 },
        status: "ok",
        meta: { latencyMs: ms, ...(empty ? { empty: true } : {}) },
      });
    }
    const live = db.get(`SELECT * FROM usageRollup`);
    rebuildRollupFromHistoryUnscoped(db);
    expect(db.all(`SELECT * FROM usageRollup`)).toEqual([live]);
  });
});

describe("migration 017", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-017-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("adds columns, backfills retained history, preserves all other data, and is idempotent", async () => {
    const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
    const { runVersionedMigrations } = await import("@/lib/db/migrate.js");
    const { MIGRATIONS } = await import("@/lib/db/migrations/index.js");
    const m017 = (await import("@/lib/db/migrations/017-usage-latency-rollup.js")).default;
    expect(MIGRATIONS.find((m) => m.version === 17).name).toBe("usage-latency-rollup");

    const old = await createSqlJsAdapter(path.join(dir, "pre017.sqlite"));
    runVersionedMigrations(
      old,
      MIGRATIONS.filter((m) => m.version < 17),
    );
    expect(old.all(`PRAGMA table_info(usageRollup)`).map((c) => c.name)).not.toContain(
      "latencyHistogram",
    );
    const ts = (h) => new Date(2026, 0, 10, h).toISOString();
    const hist = (h, endpoint, meta) =>
      old.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
         VALUES(?, 'p', 'm', 'c1', ?, 10, 5, 0.5, 'ok', '{}', ?)`,
        [ts(h), endpoint, meta == null ? null : JSON.stringify(meta)],
      );
    hist(10, "completions", { latencyMs: 100 });
    hist(11, "completions", { latencyMs: 300, empty: true });
    hist(12, "completions", null);
    hist(13, "/v1/chat", { latencyMs: 9999 });
    const insertRollup = (dateKey, model, endpoint, requests, tokensIn, cost) =>
      old.run(
        `INSERT INTO usageRollup (dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint, requests, tokensIn, tokensOut, tokensCached, cost)
         VALUES (?, '', '', 'local-no-key', 'p', ?, ?, ?, ?, ?, 0, 0, ?)`,
        [dateKey, model, "c1", endpoint, requests, tokensIn, cost],
      );
    insertRollup("2026-01-10", "m", "completions", 3, 30, 1.5);
    insertRollup("2026-01-10", "m", "/v1/chat", 1, 10, 0.5);
    insertRollup("2026-01-02", "m", "completions", 9, 90, 4); // history pruned: no samples to recover
    const before = old.all(
      `SELECT dateKey, model, endpoint, requests, tokensIn, cost FROM usageRollup ORDER BY dateKey, endpoint`,
    );

    runVersionedMigrations(old);
    const rows = old.all(`SELECT * FROM usageRollup ORDER BY dateKey, endpoint`);
    expect(
      rows.map(({ dateKey, model, endpoint, requests, tokensIn, cost }) => ({
        dateKey,
        model,
        endpoint,
        requests,
        tokensIn,
        cost,
      })),
    ).toEqual(before);
    const pick = (date, ep) => rows.find((r) => r.dateKey === date && r.endpoint === ep);
    expect(pick("2026-01-10", "completions")).toMatchObject({
      latencySumMs: 400,
      latencyCount: 2,
      emptyCount: 1,
      latencyRequests: 3,
    });
    expect(JSON.parse(pick("2026-01-10", "completions").latencyHistogram)).toEqual(
      JSON.parse(
        bins([
          [1, 1],
          [3, 1],
        ]),
      ),
    );
    expect(pick("2026-01-10", "/v1/chat")).toMatchObject({ latencyRequests: 0, latencyCount: 0 });
    expect(pick("2026-01-02", "completions")).toMatchObject({
      requests: 9,
      latencyRequests: 0,
      latencyHistogram: bins([]),
    });

    // Rerun (marker present, then marker lost): same bytes, no doubling.
    const snap = () =>
      JSON.stringify(old.all(`SELECT * FROM usageRollup ORDER BY dateKey, endpoint`));
    const s1 = snap();
    m017.up(old);
    expect(snap()).toBe(s1);
    old.run(`DELETE FROM _meta WHERE key = 'usageLatencyBackfilled'`);
    m017.up(old);
    expect(snap()).toBe(s1);

    // Rebuild agrees with the upgrade for the history-backed group.
    const migrated = pick("2026-01-10", "completions");
    rebuildRollupFromHistoryUnscoped(old);
    const rebuilt = old
      .all(`SELECT * FROM usageRollup`)
      .find((r) => r.dateKey === "2026-01-10" && r.endpoint === "completions");
    expect(rebuilt).toMatchObject({
      latencySumMs: migrated.latencySumMs,
      latencyCount: migrated.latencyCount,
      emptyCount: migrated.emptyCount,
      latencyRequests: migrated.latencyRequests,
      latencyHistogram: migrated.latencyHistogram,
    });
    old.close();
  });
});

describe("bootstrap adoption merges latency columns", () => {
  it("sums counters and histogram bins when the owner row already exists", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    db.run(
      `INSERT INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES('own', 'owner', 'active', ?, ?)`,
      [now, now],
    );
    db.run(
      `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES('wd', 'D', 'shared', 'own', ?, ?)`,
      [now, now],
    );
    db.run(
      `INSERT INTO _meta(key, value) VALUES('defaultWorkspaceId', 'wd') ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    try {
      rollup("2026-01-10", {
        requests: 2,
        latencySumMs: 150,
        latencyCount: 2,
        latencyRequests: 2,
        latencyHistogram: bins([[1, 2]]),
      });
      rollup("2026-01-10", {
        workspaceId: "wd",
        userId: "own",
        requests: 2,
        latencySumMs: 300,
        latencyCount: 2,
        emptyCount: 1,
        latencyRequests: 2,
        latencyHistogram: bins([
          [1, 1],
          [2, 1],
        ]),
      });
      db.transaction(() => adoptOwnerlessRowsUnscoped(db));
      const rows = db.all(`SELECT * FROM usageRollup`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        workspaceId: "wd",
        userId: "own",
        requests: 4,
        latencySumMs: 450,
        latencyCount: 4,
        emptyCount: 1,
        latencyRequests: 4,
      });
      expect(JSON.parse(rows[0].latencyHistogram)).toEqual(
        JSON.parse(
          bins([
            [1, 3],
            [2, 1],
          ]),
        ),
      );
    } finally {
      db.exec(`DELETE FROM _meta WHERE key = 'defaultWorkspaceId'`);
      db.exec(`DELETE FROM workspaces WHERE id = 'wd'; DELETE FROM users WHERE id = 'own'`);
    }
  });
});

describe("snapshot sections carry the latency columns", () => {
  const refs = { users: new Set(), workspaces: new Set(), connectionsById: new Set() };
  const oldRow = {
    dateKey: "2026-01-10",
    workspaceId: "",
    userId: "",
    apiKeyId: "local-no-key",
    provider: "p",
    model: "m",
    connectionId: "",
    endpoint: "completions",
    requests: 3,
    tokensIn: 1,
    tokensOut: 1,
    tokensCached: 0,
    cost: 0.1,
  };

  it("imports pre-017 rows with defaults and round-trips new columns exactly", () => {
    validateInstanceTableSections({ usageRollup: [oldRow] }, refs);
    db.run(`DELETE FROM usageRollup`);
    const full = {
      ...oldRow,
      model: "m2",
      latencySumMs: 400,
      latencyCount: 2,
      emptyCount: 1,
      latencyRequests: 3,
      latencyHistogram: bins([
        [1, 1],
        [3, 1],
      ]),
    };
    insertInstanceTableSections(db, { usageRollup: [oldRow, full] });
    const rows = db.all(`SELECT * FROM usageRollup ORDER BY model`);
    expect(rows[0]).toMatchObject({ latencyRequests: 0, latencyHistogram: bins([]) });
    expect(rows[1]).toMatchObject(full);
  });

  it("rejects malformed or inconsistent latency columns", () => {
    for (const bad of [
      { latencyHistogram: "[1,2]" },
      { latencyHistogram: "nope" },
      { latencyCount: -1 },
      { latencySumMs: "9" },
      { latencyCount: 2, latencyRequests: 2, latencyHistogram: bins([[1, 1]]) },
      { latencyCount: 3, latencyRequests: 2, latencyHistogram: bins([[1, 3]]) },
      { latencyCount: 2, latencyRequests: 2 }, // histogram required when latencyCount > 0
      { emptyCount: 3, latencyRequests: 2 },
      { emptyCount: 1 }, // latencyRequests defaults to 0
    ]) {
      expect(() =>
        validateInstanceTableSections({ usageRollup: [{ ...oldRow, ...bad }] }, refs),
      ).toThrow(/usageRollup/);
    }
  });
});

// cutoff helper sanity (kept: pins the 7d window the read path relies on)
it("cutoffDateKey(7) is today-6", () => {
  expect(cutoffDateKey(7)).toBe(dayAgo(6));
});
