import { beforeEach, describe, expect, it } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import {
  createProviderConnectionUnscoped,
  deleteProviderConnectionUnscoped,
} from "@/lib/db/index.js";
import {
  _resetQuotaHistoryWriteCache,
  downsampleHistoryPoints,
  getConnectionQuotaHistory,
  listConnectionQuotaHistoryRows,
  loadLatestSnapshotsUnscoped,
  pruneQuotaHistoryUnscoped,
  recordQuotaHistorySamplesUnscoped,
} from "@/lib/db/repos/quotaHistoryRepo.js";
import m025 from "@/lib/db/migrations/025-quota-history.js";
import { resolveQuotaHistoryRetentionDays } from "@/shared/services/quotaHistoryRetention.js";

const BASE = Date.UTC(2026, 10, 20, 12, 0, 0);
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function createConn(provider = "claude", name = "acct") {
  return createProviderConnectionUnscoped({
    provider,
    authType: "oauth",
    name,
    accessToken: "sk-super-secret-access-token",
    refreshToken: "rt-super-secret-refresh-token",
  });
}

beforeEach(async () => {
  _resetQuotaHistoryWriteCache();
  const db = await getAdapter();
  db.run(`DELETE FROM quotaHistory`);
  db.run(`DELETE FROM providerConnections`);
});

describe("quotaHistory schema, migration 025, and FK lifecycle", () => {
  it("applies migration 025 idempotently and enforces usedFraction bounds and FK cascade", async () => {
    const db = await getAdapter();
    // Idempotent rerun
    m025.up(db);
    m025.up(db);

    const cols = db.all(`PRAGMA table_info(quotaHistory)`).map((c) => c.name);
    expect(cols).toEqual([
      "id",
      "connectionId",
      "provider",
      "windowKind",
      "quotaKey",
      "usedFraction",
      "resetsAt",
      "planTier",
      "source",
      "ts",
    ]);

    const conn = await createConn("claude", "fk-test");
    await recordQuotaHistorySamplesUnscoped(
      conn.id,
      "claude",
      [
        {
          windowKind: "5h",
          quotaKey: "session (5h)",
          usedFraction: 0.25,
          resetsAt: BASE + 5 * HOUR,
          ts: BASE,
        },
      ],
      { now: BASE },
    );
    expect(
      db.get(`SELECT COUNT(*) AS c FROM quotaHistory WHERE connectionId = ?`, [conn.id]).c,
    ).toBe(1);

    // Out-of-range usedFraction is rejected by CHECK constraint at SQL level
    expect(() =>
      db.run(
        `INSERT INTO quotaHistory (connectionId, provider, windowKind, quotaKey, usedFraction, resetsAt, source, ts)
         VALUES (?, 'claude', '5h', 'session (5h)', 1.5, 0, 'probe', ?)`,
        [conn.id, BASE + 10 * MIN],
      ),
    ).toThrow(/CHECK/i);

    // Deleting the connection cascades and removes all quotaHistory rows
    await deleteProviderConnectionUnscoped(conn.id);
    expect(
      db.get(`SELECT COUNT(*) AS c FROM quotaHistory WHERE connectionId = ?`, [conn.id]).c,
    ).toBe(0);
  });

  it("never stores secrets even when extra fields are present on sample objects", async () => {
    const db = await getAdapter();
    const conn = await createConn("claude", "no-secrets");
    await recordQuotaHistorySamplesUnscoped(
      conn.id,
      "claude",
      [
        {
          windowKind: "5h",
          quotaKey: "session (5h)",
          usedFraction: 0.4,
          resetsAt: BASE + 4 * HOUR,
          planTier: "pro",
          accessToken: "sk-leaked-secret",
          cookie: "session=leaked-cookie",
          email: "user@example.com",
          ts: BASE,
        },
      ],
      { now: BASE },
    );

    const rows = db.all(`SELECT * FROM quotaHistory WHERE connectionId = ?`, [conn.id]);
    expect(rows).toHaveLength(1);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("sk-leaked-secret");
    expect(serialized).not.toContain("leaked-cookie");
    expect(serialized).not.toContain("user@example.com");
    expect(serialized).not.toContain("sk-super-secret");
  });
});

describe("rate-limiting and sample-on-change", () => {
  it("enforces minSampleIntervalMs, skips unchanged values, and records on change, reset shift, or heartbeat", async () => {
    const conn = await createConn("codex", "rate-limit");
    const reset1 = BASE + 5 * HOUR;

    // 1. First sample always persists
    const r1 = await recordQuotaHistorySamplesUnscoped(
      conn.id,
      "codex",
      [{ windowKind: "5h", quotaKey: "session", usedFraction: 0.1, resetsAt: reset1, ts: BASE }],
      { now: BASE },
    );
    expect(r1).toEqual({ inserted: 1, skipped: 0 });

    // 2. Burst 1 minute later (even with big change) is rate-limited
    const r2 = await recordQuotaHistorySamplesUnscoped(
      conn.id,
      "codex",
      [
        {
          windowKind: "5h",
          quotaKey: "session",
          usedFraction: 0.5,
          resetsAt: reset1,
          ts: BASE + MIN,
        },
      ],
      { now: BASE + MIN },
    );
    expect(r2).toEqual({ inserted: 0, skipped: 1 });

    // 3. After 5 minutes with negligible change (< 0.5% delta) → skipped
    const r3 = await recordQuotaHistorySamplesUnscoped(
      conn.id,
      "codex",
      [
        {
          windowKind: "5h",
          quotaKey: "session",
          usedFraction: 0.102,
          resetsAt: reset1,
          ts: BASE + 5 * MIN,
        },
      ],
      { now: BASE + 5 * MIN },
    );
    expect(r3).toEqual({ inserted: 0, skipped: 1 });

    // 4. After 6 minutes with real change (>= 0.5%) → recorded
    const r4 = await recordQuotaHistorySamplesUnscoped(
      conn.id,
      "codex",
      [
        {
          windowKind: "5h",
          quotaKey: "session",
          usedFraction: 0.25,
          resetsAt: reset1,
          ts: BASE + 6 * MIN,
        },
      ],
      { now: BASE + 6 * MIN },
    );
    expect(r4).toEqual({ inserted: 1, skipped: 0 });

    // 5. Out-of-order older timestamp is ignored
    const r5 = await recordQuotaHistorySamplesUnscoped(
      conn.id,
      "codex",
      [
        {
          windowKind: "5h",
          quotaKey: "session",
          usedFraction: 0.9,
          resetsAt: reset1,
          ts: BASE + 3 * MIN,
        },
      ],
      { now: BASE + 3 * MIN },
    );
    expect(r5).toEqual({ inserted: 0, skipped: 1 });

    // 6. Reset timestamp shift (>= 5m) with unchanged usedFraction after interval → recorded
    const reset2 = reset1 + 5 * HOUR;
    const r6 = await recordQuotaHistorySamplesUnscoped(
      conn.id,
      "codex",
      [
        {
          windowKind: "5h",
          quotaKey: "session",
          usedFraction: 0.25,
          resetsAt: reset2,
          ts: BASE + 12 * MIN,
        },
      ],
      { now: BASE + 12 * MIN },
    );
    expect(r6).toEqual({ inserted: 1, skipped: 0 });

    // 7. Unchanged value after heartbeat interval (6h) → recorded
    const r7 = await recordQuotaHistorySamplesUnscoped(
      conn.id,
      "codex",
      [
        {
          windowKind: "5h",
          quotaKey: "session",
          usedFraction: 0.25,
          resetsAt: reset2,
          ts: BASE + 12 * MIN + 6 * HOUR,
        },
      ],
      { now: BASE + 12 * MIN + 6 * HOUR },
    );
    expect(r7).toEqual({ inserted: 1, skipped: 0 });

    const rows = await listConnectionQuotaHistoryRows(null, conn.id, { now: BASE + 7 * HOUR });
    expect(rows.map((r) => r.usedFraction)).toEqual([0.1, 0.25, 0.25, 0.25]);
  });
});

describe("write gate atomicity and hydration", () => {
  const sample = (ts, used = 0.4) => ({
    windowKind: "5h",
    quotaKey: "session",
    usedFraction: used,
    resetsAt: BASE + 5 * HOUR,
    ts,
  });

  it("admits only one concurrent writer and survives cache eviction/restart", async () => {
    const db = await getAdapter();
    const conn = await createConn("codex", "race");
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        recordQuotaHistorySamplesUnscoped(conn.id, "codex", [sample(BASE)], { now: BASE }),
      ),
    );
    expect(results.reduce((n, r) => n + r.inserted, 0)).toBe(1);

    // Simulated restart / eviction: empty cache must fall back to the persisted latest row.
    _resetQuotaHistoryWriteCache();
    const again = await recordQuotaHistorySamplesUnscoped(conn.id, "codex", [sample(BASE + MIN)], {
      now: BASE + MIN,
    });
    expect(again).toEqual({ inserted: 0, skipped: 1 });
    expect(
      db.get(`SELECT COUNT(*) AS c FROM quotaHistory WHERE connectionId = ?`, [conn.id]).c,
    ).toBe(1);
  });

  it("hydrates newest reading per kind before liveness filter, keeping true timestamps", async () => {
    const db = await getAdapter();
    const conn = await createConn("claude", "hydrate");
    const ins = (kind, used, resetsAt, ts) =>
      db.run(
        `INSERT INTO quotaHistory (connectionId, provider, windowKind, quotaKey, usedFraction, resetsAt, source, ts)
         VALUES (?, 'claude', ?, '', ?, ?, 'probe', ?)`,
        [conn.id, kind, used, resetsAt, ts],
      );
    const NOW = BASE + 10 * HOUR;
    ins("5h", 0.9, NOW + HOUR, NOW - 2 * HOUR); // older, would still be live
    ins("5h", 0.1, NOW - HOUR, NOW - HOUR); // newest, already expired -> window gone
    ins("7d", 0.2, NOW + DAY, NOW - 3 * HOUR);
    ins("7d", 0.3, NOW + DAY, NOW - 30 * MIN);

    const { snapshots } = await loadLatestSnapshotsUnscoped({ now: NOW });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].windows).toEqual([
      {
        kind: "7d",
        usedFraction: 0.3,
        resetsAt: NOW + DAY,
        observedAt: NOW - 30 * MIN,
        source: "probe",
      },
    ]);
    expect(snapshots[0].updatedAt).toBe(NOW - 30 * MIN);
  });
});

describe("hydration tie selection and quotaKey", () => {
  it("picks tightest utilization on tied latest ts and exposes the raw quotaKey", async () => {
    const db = await getAdapter();
    const conn = await createConn("claude", "tie");
    const NOW = BASE + 10 * HOUR;
    const ins = (key, used, resetsAt, ts) =>
      db.run(
        `INSERT INTO quotaHistory (connectionId, provider, windowKind, quotaKey, usedFraction, resetsAt, source, ts)
         VALUES (?, 'claude', '5h', ?, ?, ?, 'probe', ?)`,
        [conn.id, key, used, resetsAt, ts],
      );
    // Same probe timestamp, two quota keys: highest id carries the LOWER utilization.
    ins("session (5h)", 0.8, NOW + HOUR, NOW - MIN);
    ins("other (5h)", 0.2, NOW + HOUR, NOW - MIN);
    // Older, even tighter reading must not win over the latest ts.
    ins("old (5h)", 0.99, NOW + HOUR, NOW - 2 * MIN);

    const { snapshots } = await loadLatestSnapshotsUnscoped({ now: NOW });
    expect(snapshots[0].windows).toEqual([
      {
        kind: "5h",
        usedFraction: 0.8,
        resetsAt: NOW + HOUR,
        observedAt: NOW - MIN,
        source: "probe",
        quotaKey: "session (5h)",
      },
    ]);

    // Blank quotaKey is omitted entirely.
    db.run(`DELETE FROM quotaHistory WHERE connectionId = ?`, [conn.id]);
    ins("", 0.5, NOW + HOUR, NOW - MIN);
    const blank = await loadLatestSnapshotsUnscoped({ now: NOW });
    expect(blank.snapshots[0].windows[0]).not.toHaveProperty("quotaKey");
  });
});

describe("scoped history reads and downsampling", () => {
  it("enforces workspace/user scoping in SQL and fails closed on malformed ctx", async () => {
    const db = await getAdapter();
    const nowIso = new Date(BASE).toISOString();
    db.run(
      `INSERT INTO users (id, email, instanceRole, status, createdAt, updatedAt) VALUES ('u1', 'u1@test.local', 'user', 'active', ?, ?)`,
      [nowIso, nowIso],
    );
    db.run(
      `INSERT INTO users (id, email, instanceRole, status, createdAt, updatedAt) VALUES ('u2', 'u2@test.local', 'user', 'active', ?, ?)`,
      [nowIso, nowIso],
    );
    db.run(
      `INSERT INTO workspaces (id, name, kind, createdAt, updatedAt) VALUES ('ws1', 'WS1', 'shared', ?, ?)`,
      [nowIso, nowIso],
    );
    db.run(
      `INSERT INTO workspaces (id, name, kind, createdAt, updatedAt) VALUES ('ws2', 'WS2', 'shared', ?, ?)`,
      [nowIso, nowIso],
    );
    db.run(
      `INSERT INTO memberships (workspaceId, userId, role, source, createdAt) VALUES ('ws1', 'u1', 'member', 'manual', ?)`,
      [nowIso],
    );
    db.run(
      `INSERT INTO memberships (workspaceId, userId, role, source, createdAt) VALUES ('ws2', 'u2', 'member', 'manual', ?)`,
      [nowIso],
    );

    const conn = await createConn("claude", "scoped-conn");
    db.run(`UPDATE providerConnections SET workspaceId = 'ws1' WHERE id = ?`, [conn.id]);

    await recordQuotaHistorySamplesUnscoped(
      conn.id,
      "claude",
      [
        {
          windowKind: "5h",
          quotaKey: "session (5h)",
          usedFraction: 0.3,
          resetsAt: BASE + 5 * HOUR,
          ts: BASE,
        },
      ],
      { now: BASE },
    );

    // Owner member u1 can read
    const allowed = await getConnectionQuotaHistory({ userId: "u1" }, conn.id, { now: BASE + MIN });
    expect(allowed["session (5h)"]).toEqual([{ ts: BASE, usedPct: 30 }]);

    // Other workspace member u2 gets empty map
    const denied = await getConnectionQuotaHistory({ userId: "u2" }, conn.id, { now: BASE + MIN });
    expect(denied).toEqual({});

    // Malformed ctx (including workspace-only) fails closed
    expect(await getConnectionQuotaHistory({}, conn.id, { now: BASE + MIN })).toEqual({});
    expect(
      await getConnectionQuotaHistory({ workspaceId: "ws1" }, conn.id, { now: BASE + MIN }),
    ).toEqual({});
    expect(await listConnectionQuotaHistoryRows({}, conn.id, { now: BASE + MIN })).toEqual([]);
  });

  it("downsamples dense series while preserving first, peak spikes, and last point", () => {
    const dense = Array.from({ length: 100 }, (_, i) => ({
      ts: BASE + i * 10 * MIN,
      usedPct: i === 42 ? 99.5 : 10,
    }));
    const out = downsampleHistoryPoints(dense, 12);
    expect(out).toHaveLength(12);
    expect(out[0]).toEqual(dense[0]);
    expect(out[out.length - 1]).toEqual(dense[99]);
    expect(out.some((pt) => pt.usedPct === 99.5)).toBe(true);
  });
});

describe("retention pruning in batches", () => {
  it("prunes rows older than retentionDays across multiple batches and keeps newer rows", async () => {
    const db = await getAdapter();
    const conn = await createConn("claude", "prune-test");

    // Insert 7 old rows (65d–71d old) and 3 recent rows (1d–3d old)
    for (let i = 0; i < 7; i++) {
      db.run(
        `INSERT INTO quotaHistory (connectionId, provider, windowKind, quotaKey, usedFraction, resetsAt, source, ts)
         VALUES (?, 'claude', '5h', 'session (5h)', 0.5, 0, 'probe', ?)`,
        [conn.id, BASE - (65 + i) * DAY],
      );
    }
    for (let i = 1; i <= 3; i++) {
      db.run(
        `INSERT INTO quotaHistory (connectionId, provider, windowKind, quotaKey, usedFraction, resetsAt, source, ts)
         VALUES (?, 'claude', '5h', 'session (5h)', 0.2, 0, 'probe', ?)`,
        [conn.id, BASE - i * DAY],
      );
    }

    const res = await pruneQuotaHistoryUnscoped(60, { now: BASE, batchSize: 3 });
    expect(res).toEqual({ deleted: 7, batches: 3 });

    const remaining = db.all(`SELECT ts FROM quotaHistory WHERE connectionId = ? ORDER BY ts ASC`, [
      conn.id,
    ]);
    expect(remaining).toHaveLength(3);
    expect(remaining.every((r) => r.ts >= BASE - 60 * DAY)).toBe(true);
  });

  it("clamps retention days to 30..90 with a 60d default", () => {
    expect(resolveQuotaHistoryRetentionDays(undefined)).toBe(60);
    expect(resolveQuotaHistoryRetentionDays(null)).toBe(60);
    expect(resolveQuotaHistoryRetentionDays("bad")).toBe(60);
    expect(resolveQuotaHistoryRetentionDays(10)).toBe(30);
    expect(resolveQuotaHistoryRetentionDays(45)).toBe(45);
    expect(resolveQuotaHistoryRetentionDays(365)).toBe(90);
  });
});
