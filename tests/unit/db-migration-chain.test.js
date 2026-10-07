// Verify schema migration chain runs correctly across versions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LEGACY } from "@/shared/brand";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

function resetAdapter() {
  if (!tempDir) return;
  const adapters = globalThis[Symbol.for(`tokenhop.dbAdapters.${process.pid}`)];
  const dataFile = path.join(tempDir, "db", "data.sqlite");
  try {
    adapters?.get(dataFile)?.instance?.close?.();
  } finally {
    adapters?.delete(dataFile);
  }
}

beforeEach(() => {
  resetAdapter();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenhop-mig-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
});

afterEach(() => {
  resetAdapter();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Schema migrations", () => {
  it("fresh DB → applies migrations & stamps schemaVersion", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const db = await getAdapter();
    const row = db.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(row.value, 10)).toBe(latestVersion());

    const tables = db.all(`SELECT name FROM sqlite_master WHERE type='table'`).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "_meta",
        "settings",
        "providerConnections",
        "providerNodes",
        "proxyPools",
        "apiKeys",
        "combos",
        "kv",
        "usageHistory",
        "usageRollup",
        "requestDetails",
      ]),
    );
  });

  it("existing DB at older schemaVersion → re-applies pending migrations on restart", async () => {
    // 1st boot
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      ['{"foo":"bar"}'],
    );
    db.run(`UPDATE _meta SET value = '0' WHERE key = 'schemaVersion'`);

    // 2nd boot: full reset to simulate process restart
    resetAdapter();
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const db2 = await getAdapter2();
    const row = db2.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(row.value, 10)).toBe(latestVersion());

    const settings = db2.get(`SELECT data FROM settings WHERE id=1`);
    // Existing data is kept; migration #3 only adds the pinned SAML issuer.
    expect(JSON.parse(settings.data)).toEqual({ foo: "bar", samlIssuer: LEGACY.samlIssuerDefault });
  });

  it("fresh DB + legacy db.json → imports data automatically", async () => {
    // Simulate user upgrading: place legacy JSON in DATA_DIR before first boot
    const legacy = {
      settings: { foo: "legacy-value" },
      apiKeys: [{ id: "k1", key: "abc", name: "test", createdAt: new Date().toISOString() }],
      modelAliases: { "gpt-4": "gpt-4-turbo" },
    };
    fs.writeFileSync(path.join(tempDir, "db.json"), JSON.stringify(legacy));

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const settings = db.get(`SELECT data FROM settings WHERE id=1`);
    expect(JSON.parse(settings.data)).toEqual({ foo: "legacy-value" });

    const keys = db.all(`SELECT * FROM apiKeys`);
    expect(keys).toHaveLength(1);
    expect(keys[0].key).toBe("abc");

    const aliases = db.all(`SELECT * FROM kv WHERE scope='modelAliases'`);
    expect(aliases).toHaveLength(1);
  });

  it("legacy import: duplicate combo names don't abort, and an aborted import retries (YAN-62)", async () => {
    const dbJson = path.join(tempDir, "db.json");
    const conn = { id: "c1", provider: "openai", authType: "apikey" };
    // Missing combo name → NOT NULL failure → MigrationAborted
    fs.writeFileSync(
      dbJson,
      JSON.stringify({ providerConnections: [conn], combos: [{ id: "x0", models: [] }] }),
    );
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    expect(db.all(`SELECT * FROM providerConnections`)).toHaveLength(0);

    // User fixes db.json (duplicate names are now tolerated) and restarts
    fs.writeFileSync(
      dbJson,
      JSON.stringify({
        providerConnections: [conn],
        combos: [
          { id: "x1", name: "fast", models: [] },
          { id: "x2", name: "fast", models: [] },
        ],
      }),
    );
    resetAdapter();
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const db2 = await getAdapter2();
    expect(db2.all(`SELECT id FROM providerConnections`)).toEqual([{ id: "c1" }]);
    expect(db2.all(`SELECT id FROM combos`)).toEqual([{ id: "x1" }]);
  });

  it("legacy import is skipped when the DB already holds user data (YAN-62)", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run(
      `INSERT INTO combos(id, name, models, createdAt, updatedAt) VALUES('mine', 'mine', '[]', 'x', 'x')`,
    );

    fs.writeFileSync(
      path.join(tempDir, "db.json"),
      JSON.stringify({ combos: [{ id: "legacy", name: "legacy", models: [] }] }),
    );
    resetAdapter();
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const db2 = await getAdapter2();
    expect(db2.all(`SELECT id FROM combos`)).toEqual([{ id: "mine" }]);
  });

  it("migration 011 adds nullable instanceRoleSource idempotently with an idp-only CHECK (YAN-359)", async () => {
    const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
    const m011 = (await import("@/lib/db/migrations/011-sso-role-source.js")).default;
    const db = await createSqlJsAdapter(path.join(tempDir, "pre011.sqlite"));
    db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, instanceRole TEXT NOT NULL)`);
    db.run(`INSERT INTO users(id, instanceRole) VALUES('u0', 'admin')`);
    const cols = () =>
      db.all(`PRAGMA table_info(users)`).filter((c) => c.name === "instanceRoleSource");
    expect(cols()).toHaveLength(0);

    m011.up(db);
    m011.up(db); // idempotent: no duplicate-column error
    expect(cols()).toHaveLength(1);
    expect(cols()[0].notnull).toBe(0);
    expect(db.get(`SELECT instanceRoleSource AS s FROM users WHERE id = 'u0'`).s).toBeNull();

    db.run(`INSERT INTO users(id, instanceRole, instanceRoleSource) VALUES('u1', 'admin', NULL)`);
    db.run(`INSERT INTO users(id, instanceRole, instanceRoleSource) VALUES('u2', 'admin', 'idp')`);
    for (const bad of ["manual", "x"]) {
      expect(() =>
        db.run(`INSERT INTO users(id, instanceRole, instanceRoleSource) VALUES(?, 'admin', ?)`, [
          `bad-${bad}`,
          bad,
        ]),
      ).toThrow(/CHECK/i);
    }
    db.close();
  });

  it("fresh DB schema has users.instanceRoleSource (YAN-359)", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    expect(db.all(`PRAGMA table_info(users)`).map((c) => c.name)).toContain("instanceRoleSource");
  });

  it("migration 013 adds an empty workspaceKeys table idempotently, after 002/003 (YAN-365)", async () => {
    const { MIGRATIONS } = await import("@/lib/db/migrations/index.js");
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions.indexOf(2)).toBeLessThan(versions.indexOf(13));
    expect(versions.indexOf(3)).toBeLessThan(versions.indexOf(13));
    expect(MIGRATIONS.find((m) => m.version === 2).name).toBe("cursor-refresh-backfill");
    expect(MIGRATIONS.find((m) => m.version === 3).name).toBe("pin-saml-issuer");
    expect(MIGRATIONS.find((m) => m.version === 13).name).toBe("workspace-keys");

    const { getAdapter } = await import("@/lib/db/driver.js");
    const m013 = (await import("@/lib/db/migrations/013-workspace-keys.js")).default;
    const db = await getAdapter();
    expect(db.get(`SELECT COUNT(*) AS c FROM workspaceKeys`).c).toBe(0);
    const cols = db.all(`PRAGMA table_info(workspaceKeys)`);
    expect(cols.map((c) => c.name)).toEqual(["workspaceId", "kid", "wrappedDek", "createdAt"]);
    expect(cols.find((c) => c.name === "workspaceId").pk).toBe(1);
    expect(cols.filter((c) => c.notnull === 1).map((c) => c.name)).toEqual(
      expect.arrayContaining(["kid", "wrappedDek", "createdAt"]),
    );
    const fk = db.all(`PRAGMA foreign_key_list(workspaceKeys)`);
    expect(fk).toHaveLength(1);
    expect(fk[0]).toMatchObject({ table: "workspaces", from: "workspaceId", on_delete: "CASCADE" });

    // Idempotent rerun; additive only: no encryption activation, no key
    // generation, no marker, no key rows, no master file with switch off.
    m013.up(db);
    m013.up(db);
    expect(db.get(`SELECT COUNT(*) AS c FROM workspaceKeys`).c).toBe(0);
    for (const key of [
      "credentialsEncryptedVersion",
      "credentialsKekKid",
      "credentialsCleanupPending",
      "credentialsPendingRotation",
      "apiKeyHashKeyWrapped",
    ]) {
      expect(db.get(`SELECT 1 AS x FROM _meta WHERE key = ?`, [key])).toBeUndefined();
    }
    expect(fs.existsSync(path.join(tempDir, "keys"))).toBe(false);
  });

  it("migration 013 on a pre-013 DB creates the table without touching data", async () => {
    const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
    const { runVersionedMigrations } = await import("@/lib/db/migrate.js");
    const { MIGRATIONS } = await import("@/lib/db/migrations/index.js");
    const m013 = (await import("@/lib/db/migrations/013-workspace-keys.js")).default;
    const db = await createSqlJsAdapter(path.join(tempDir, "pre013.sqlite"));
    runVersionedMigrations(
      db,
      MIGRATIONS.filter((m) => m.version < 13),
    );
    db.run(`INSERT INTO settings(id, data) VALUES(1, ?)`, ['{"foo":"bar"}']);
    expect(db.get(`SELECT 1 AS x FROM sqlite_master WHERE name = 'workspaceKeys'`)).toBeUndefined();
    runVersionedMigrations(db);
    expect(
      Number(db.get(`SELECT value FROM _meta WHERE key='schemaVersion'`).value),
    ).toBeGreaterThanOrEqual(13);
    expect(JSON.parse(db.get(`SELECT data FROM settings WHERE id = 1`).data).foo).toBe("bar");
    expect(db.get(`SELECT COUNT(*) AS c FROM workspaceKeys`).c).toBe(0);
    m013.up(db);
    db.close();
  });

  it("migration 014 backfills attribution, drops raw keys and usageDaily, rebuilds the rollup (YAN-370)", async () => {
    const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
    const { runVersionedMigrations } = await import("@/lib/db/migrate.js");
    const { MIGRATIONS } = await import("@/lib/db/migrations/index.js");
    const m014 = (await import("@/lib/db/migrations/014-usage-attribution.js")).default;
    const { createHash } = await import("node:crypto");
    expect(MIGRATIONS.find((m) => m.version === 14).name).toBe("usage-attribution");

    const db = await createSqlJsAdapter(path.join(tempDir, "pre014.sqlite"));
    runVersionedMigrations(
      db,
      MIGRATIONS.filter((m) => m.version < 14),
    );
    const now = "2026-01-01T00:00:00.000Z";
    db.run(`INSERT INTO users(id, instanceRole, createdAt, updatedAt) VALUES('u1','owner',?,?)`, [
      now,
      now,
    ]);
    db.run(
      `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES('w1','W','shared',NULL,?,?)`,
      [now, now],
    );
    const RAW_KNOWN = "sk-legacy-known-raw-secret";
    const RAW_UNKNOWN = "sk-legacy-unknown-raw-secret";
    db.run(`INSERT INTO apiKeys(id, key, name, createdAt) VALUES('k1', ?, 'Known', ?)`, [
      RAW_KNOWN,
      now,
    ]);

    const T = (d, h = 12) => new Date(2026, 0, d, h).toISOString(); // local-day stamps
    const hist = (ts, apiKey, meta, model = "m") =>
      db.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
         VALUES(?, 'p', ?, 'c1', ?, '/v1/x', 10, 5, 0.5, 'ok', '{"cached_tokens":2}', ?)`,
        [ts, model, apiKey, meta == null ? null : JSON.stringify(meta)],
      );
    hist(T(10), RAW_KNOWN, { workspaceId: "w1", userId: "u1", apiKey: RAW_KNOWN });
    hist(T(10), RAW_UNKNOWN, null);
    hist(T(10), "local-no-key", null);
    hist(T(11), null, { workspaceId: "ghost-ws" }); // dangling id → stays NULL (FK-safe)
    db.run(
      `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES('rd1', ?, 'p', 'm', 'c1', 'ok', ?)`,
      [T(10), JSON.stringify({ apiKeyId: "k1", workspaceId: "w1", userId: "u1" })],
    );
    // Day 10: blob == history (3 rows). Day 12: pre-SQLite truncation, blob has
    // 7 requests and history none. Day 11 has no blob.
    const blob = (n) =>
      JSON.stringify({ byModel: { "m|p": { requests: n, rawModel: "m", provider: "p" } } });
    db.run(`INSERT INTO usageDaily(dateKey, data) VALUES('2026-01-10', ?), ('2026-01-12', ?)`, [
      blob(3),
      blob(7),
    ]);
    const counts = (t) => db.get(`SELECT COUNT(*) AS c FROM ${t}`).c;
    const before = { h: counts("usageHistory"), r: counts("requestDetails") };

    runVersionedMigrations(db);

    expect(db.get(`SELECT 1 AS x FROM sqlite_master WHERE name = 'usageDaily'`)).toBeUndefined();
    expect([counts("usageHistory"), counts("requestDetails")]).toEqual([before.h, before.r]);
    const rows = db.all(`SELECT * FROM usageHistory ORDER BY id`);
    expect(rows.every((r) => r.apiKey === null)).toBe(true);
    const pseudo = `historical:${createHash("sha256").update(RAW_UNKNOWN).digest("hex").slice(0, 24)}`;
    expect(rows.map((r) => r.apiKeyId)).toEqual(["k1", pseudo, "local-no-key", "local-no-key"]);
    expect(rows[1].apiKeyId).toMatch(/^historical:[0-9a-f]{24}$/);
    expect(rows.map((r) => [r.workspaceId, r.userId])).toEqual([
      ["w1", "u1"],
      [null, null],
      [null, null],
      [null, null],
    ]);
    expect(db.get(`SELECT apiKeyId, workspaceId, userId FROM requestDetails`)).toEqual({
      apiKeyId: "k1",
      workspaceId: "w1",
      userId: "u1",
    });

    // Rollup: per-day request totals == history group-by; truncated day == blob.
    const perDay = () =>
      Object.fromEntries(
        db
          .all(`SELECT dateKey, SUM(requests) AS n FROM usageRollup GROUP BY dateKey`)
          .map((r) => [r.dateKey, r.n]),
      );
    expect(perDay()).toEqual({ "2026-01-10": 3, "2026-01-11": 1, "2026-01-12": 7 });

    // No raw key anywhere in the usage tables (every column of every row).
    for (const t of ["usageHistory", "requestDetails", "usageRollup"]) {
      const dump = JSON.stringify(db.all(`SELECT * FROM ${t}`));
      expect(dump).not.toContain(RAW_KNOWN);
      expect(dump).not.toContain(RAW_UNKNOWN);
    }

    // Idempotent: a re-run changes nothing.
    const snap = () =>
      JSON.stringify([
        db.all(`SELECT * FROM usageHistory ORDER BY id`),
        db.all(`SELECT * FROM requestDetails ORDER BY id`),
        db.all(`SELECT * FROM usageRollup ORDER BY dateKey, apiKeyId, model`),
      ]);
    const s1 = snap();
    m014.up(db);
    expect(snap()).toBe(s1);
    db.close();
  });

  it("credential encryption state reader: legacy by default, half/corrupt markers throw (YAN-365)", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { readCredentialEncryptionState } = await import("@/lib/db/credentialEncryptionState.js");
    const db = await getAdapter();
    const set = (k, v) =>
      db.run(
        `INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [k, v],
      );
    const del = (k) => db.run(`DELETE FROM _meta WHERE key = ?`, [k]);
    const kid = "0123456789abcdef";
    try {
      expect(readCredentialEncryptionState(db)).toEqual({
        storage: "legacy",
        version: null,
        kekKid: null,
        cleanupPending: false,
        pendingRotation: null,
      });

      // Half marker fails closed.
      set("credentialsEncryptedVersion", "1");
      expect(() => readCredentialEncryptionState(db)).toThrowError(/credentialsKekKid/);
      del("credentialsEncryptedVersion");
      set("credentialsKekKid", kid);
      expect(() => readCredentialEncryptionState(db)).toThrowError(/credentialsEncryptedVersion/);
      del("credentialsKekKid");

      // Corrupt cleanup/rotation partners fail closed.
      set("credentialsCleanupPending", "yes");
      expect(() => readCredentialEncryptionState(db)).toThrowError(/credentialsCleanupPending/);
      del("credentialsCleanupPending");
      set("credentialsPendingRotation", '{"oldKid":"x","newKid":"0123456789abcdef"}');
      expect(() => readCredentialEncryptionState(db)).toThrowError(/oldKid/);
      set("credentialsPendingRotation", "not-json");
      expect(() => readCredentialEncryptionState(db)).toThrowError(/JSON/);
      del("credentialsPendingRotation");

      // Cleanup/rotation state without the marker pair is not legacy.
      set("credentialsCleanupPending", "1");
      expect(() => readCredentialEncryptionState(db)).toThrowError(
        /cleanup\/rotation state without an encryption marker/,
      );
      del("credentialsCleanupPending");
      set("credentialsCleanupPending", "0");
      expect(() => readCredentialEncryptionState(db)).toThrowError(
        /cleanup\/rotation state without an encryption marker/,
      );
      del("credentialsCleanupPending");
      set(
        "credentialsPendingRotation",
        '{"oldKid":"aaaaaaaaaaaaaaaa","newKid":"bbbbbbbbbbbbbbbb"}',
      );
      try {
        readCredentialEncryptionState(db);
        throw new Error("orphan pendingRotation read as coherent");
      } catch (e) {
        expect(e.code).toBe("CREDENTIAL_STATE_INVALID");
        expect(e.message).toMatch(/cleanup\/rotation state without an encryption marker/);
      }
      del("credentialsPendingRotation");

      // Key rows without a coherent marker are not legacy.
      db.run(
        `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES('ws-x','W','shared',NULL,'t','t')`,
      );
      db.run(
        `INSERT INTO workspaceKeys(workspaceId, kid, wrappedDek, createdAt) VALUES('ws-x','dk_x','{}','t')`,
      );
      expect(() => readCredentialEncryptionState(db)).toThrowError(/without an encryption marker/);
      db.run(`DELETE FROM workspaceKeys`);
      db.run(`DELETE FROM workspaces WHERE id = 'ws-x'`);

      // A wrapped hash key without a marker is not legacy.
      set("apiKeyHashKeyWrapped", JSON.stringify({ v: 1, kid, iv: "x", ct: "x", tag: "x" }));
      expect(() => readCredentialEncryptionState(db)).toThrowError(/hash key/);
      del("apiKeyHashKeyWrapped");

      // Complete encrypted marker with cleanup/rotation partners.
      set("credentialsEncryptedVersion", "1");
      set("credentialsKekKid", kid);
      set("apiKeyHashKeyWrapped", "{}");
      set("credentialsCleanupPending", "1");
      set("credentialsPendingRotation", `{"oldKid":"aaaaaaaaaaaaaaaa","newKid":"${kid}"}`);
      expect(readCredentialEncryptionState(db)).toEqual({
        storage: "encrypted",
        version: 1,
        kekKid: kid,
        cleanupPending: true,
        pendingRotation: { oldKid: "aaaaaaaaaaaaaaaa", newKid: kid },
      });
      // A pending rotation whose newKid is not the marker kid is corrupt.
      set(
        "credentialsPendingRotation",
        '{"oldKid":"aaaaaaaaaaaaaaaa","newKid":"bbbbbbbbbbbbbbbb"}',
      );
      try {
        readCredentialEncryptionState(db);
        throw new Error("mismatched newKid read as coherent");
      } catch (e) {
        expect(e.code).toBe("CREDENTIAL_STATE_INVALID");
        expect(e.message).toMatch(/newKid must equal credentialsKekKid/);
      }
      set("credentialsCleanupPending", "0");
      del("credentialsPendingRotation");
      expect(readCredentialEncryptionState(db).cleanupPending).toBe(false);
    } finally {
      for (const k of [
        "credentialsEncryptedVersion",
        "credentialsKekKid",
        "credentialsCleanupPending",
        "credentialsPendingRotation",
        "apiKeyHashKeyWrapped",
      ])
        del(k);
      db.run(`DELETE FROM workspaceKeys`);
      db.run(`DELETE FROM workspaces WHERE id = 'ws-x'`);
    }
  });

  it("runtime credential state reads do not scan credential tables (YAN-365)", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { readCredentialEncryptionState } = await import("@/lib/db/credentialEncryptionState.js");
    const db = await getAdapter();
    const get = vi.spyOn(db, "get");
    const all = vi.spyOn(db, "all");
    try {
      expect(readCredentialEncryptionState(db).storage).toBe("legacy");
      expect(all).not.toHaveBeenCalled();
      expect(
        get.mock.calls.every(
          ([sql]) => !/FROM (providerConnections|providerNodes|settings)\b/i.test(sql),
        ),
      ).toBe(true);
      get.mockClear();
      readCredentialEncryptionState(db, { strict: true });
      expect(all).toHaveBeenCalledTimes(3);
    } finally {
      get.mockRestore();
      all.mockRestore();
    }
  });

  it("legacy sniff covers every row, not just the first 200 (YAN-365)", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { readCredentialEncryptionState } = await import("@/lib/db/credentialEncryptionState.js");
    const db = await getAdapter();
    const now = "2026-01-01T00:00:00.000Z";
    const env = {
      v: 1,
      kid: "dk_x",
      iv: "AAAAAAAAAAAAAAAA",
      ct: "AAAA",
      tag: "AAAAAAAAAAAAAAAAAAAAAA==",
    };
    const insert = (id, data) =>
      db.run(
        `INSERT INTO providerConnections(id, provider, authType, data, createdAt, updatedAt) VALUES(?, 'p', 'apikey', ?, ?, ?)`,
        [id, data, now, now],
      );
    try {
      db.transaction(() => {
        for (let i = 0; i < 300; i++)
          insert(`plain-${i}`, JSON.stringify({ apiKey: `plain-${i}` }));
      });
      expect(readCredentialEncryptionState(db, { strict: true }).storage).toBe("legacy");
      // An envelope-shaped leaf past row 200 still fails closed.
      insert("zz-late", JSON.stringify({ apiKey: env }));
      expect(() => readCredentialEncryptionState(db, { strict: true })).toThrowError(
        /without an encryption marker/,
      );
      db.run(`DELETE FROM providerConnections WHERE id = 'zz-late'`);
      expect(readCredentialEncryptionState(db, { strict: true }).storage).toBe("legacy");
      // Nested provider-data leaf.
      insert("zz-nested", JSON.stringify({ providerSpecificData: { clientSecret: env } }));
      expect(() => readCredentialEncryptionState(db, { strict: true })).toThrowError(
        /without an encryption marker/,
      );
      db.run(`DELETE FROM providerConnections WHERE id = 'zz-nested'`);
      // A key spelled with JSON unicode escapes still reaches the parser.
      insert(
        "zz-escaped",
        '{"apiKey":{"v":1,"kid":"dk_x","\\u0069v":"AAAAAAAAAAAAAAAA","ct":"AAAA","tag":"AAAAAAAAAAAAAAAAAAAAAA=="}}',
      );
      expect(() => readCredentialEncryptionState(db, { strict: true })).toThrowError(
        /without an encryption marker/,
      );
    } finally {
      db.run(`DELETE FROM providerConnections`);
    }
  });

  it("credential storage helpers: row codec, DEK cache liveness, modes (YAN-365)", async () => {
    const crypto = await import("node:crypto");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const storage = await import("@/lib/db/helpers/credentialStorage.js");
    const { masterKeyId } = await import("@/lib/security/masterKey.js");
    const db = await getAdapter();
    const WS = "11111111-1111-4111-8111-111111111111";
    const WS2 = "22222222-2222-4222-8222-222222222222";
    const now = "2026-01-01T00:00:00.000Z";
    for (const id of [WS, WS2]) {
      db.run(
        `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES(?, ?, 'shared', NULL, ?, ?)`,
        [id, id, now, now],
      );
    }
    const key = crypto.randomBytes(32);
    const root = { kid: masterKeyId(key), key };
    const row = { id: "conn-1", workspaceId: WS };
    const plain = {
      accessToken: "SENTINEL-at",
      refreshToken: "SENTINEL-rt",
      note: "kept",
      providerSpecificData: { clientSecret: "SENTINEL-cs", region: "us" },
    };
    const T = "providerConnections";

    // Never-enabled install: bytes unchanged, no key rows, no root needed.
    const legacy = storage.prepareCredentialContext(db, null);
    expect(legacy.encrypted).toBe(false);
    expect(storage.encodeCredentialRowSync(db, { ...row, data: plain }, legacy, { table: T })).toBe(
      JSON.stringify(plain),
    );
    expect(db.get(`SELECT COUNT(*) AS c FROM workspaceKeys`).c).toBe(0);

    // Runtime contexts never mint keys; migration contexts must be internal.
    const encryptedCtx = {
      ...legacy,
      encrypted: true,
      kek: key,
      kekKid: root.kid,
      state: legacy.state,
    };
    expect(() => storage.ensureWorkspaceDekSync(db, WS, encryptedCtx)).toThrowError(
      /workspace key not found/,
    );
    expect(() =>
      storage.encodeCredentialRowSync(db, { ...row, data: plain }, encryptedCtx, {
        table: T,
        mode: "migration",
      }),
    ).toThrowError(/internal/);

    // Trusted migration context creates the DEK; encode encrypts covered leaves only.
    const mig = storage.createMigrationContext(db, root);
    // A failing INSERT (FK to a missing workspace) propagates and leaves no key row.
    expect(() => storage.ensureWorkspaceDekSync(db, "ws-missing", mig)).toThrow();
    expect(db.get(`SELECT COUNT(*) AS c FROM workspaceKeys`).c).toBe(0);
    const a = storage.ensureWorkspaceDekSync(db, WS, mig);
    expect(a.kid).toMatch(/^dk_[0-9a-f]{16}$/);
    expect(a.kid).not.toBe(root.kid);
    const stored = JSON.parse(
      storage.encodeCredentialRowSync(db, { ...row, data: plain }, mig, {
        table: T,
        mode: "migration",
      }),
    );
    for (const f of ["accessToken", "refreshToken"])
      expect(stored[f]).toMatchObject({ v: 1, kid: a.kid });
    expect(stored.providerSpecificData.clientSecret).toMatchObject({ v: 1, kid: a.kid });
    expect(stored.note).toBe("kept");
    expect(stored.providerSpecificData.region).toBe("us");
    expect(JSON.stringify(stored)).not.toContain("SENTINEL");
    const wrapped = db.get(`SELECT wrappedDek FROM workspaceKeys WHERE workspaceId = ?`, [
      WS,
    ]).wrappedDek;
    expect(wrapped).not.toContain(a.dek.toString("base64"));

    // Runtime decode from SQL coordinates; metadata mode never decrypts.
    const rt = { ...mig, allowCreate: false };
    const dbRow = { ...row, data: JSON.stringify(stored) };
    expect(storage.decodeCredentialRowSync(db, dbRow, rt, { table: T })).toMatchObject(plain);
    const meta = storage.decodeCredentialRowSync(db, dbRow, null, { table: T, mode: "metadata" });
    expect(meta).toEqual({
      configured: ["accessToken", "refreshToken", "providerSpecificData.clientSecret"],
      data: { note: "kept", providerSpecificData: { region: "us" } },
    });
    expect(
      storage.decodeCredentialRowSync(
        db,
        { ...dbRow, data: JSON.stringify({ ...stored, refreshToken: { v: 9 } }) },
        null,
        { table: T, mode: "metadata" },
      ).data.note,
    ).toBe("kept");

    // Tamper/swap: same envelope under another row, workspace or table fails uniformly.
    for (const bad of [
      { row: { ...dbRow, id: "conn-2" }, table: T },
      { row: dbRow, table: T, workspaceId: WS2 },
      { row: dbRow, table: "providerNodes" },
    ]) {
      expect(() =>
        storage.decodeCredentialRowSync(db, bad.row, rt, {
          table: bad.table,
          workspaceId: bad.workspaceId,
        }),
      ).toThrowError(/could not be decrypted|key not found/);
    }

    // Runtime rejects caller envelopes and plaintext in established storage; metadata/migration modes are explicit.
    expect(() =>
      storage.encodeCredentialRowSync(
        db,
        { ...row, data: { accessToken: stored.accessToken } },
        rt,
        { table: T },
      ),
    ).toThrowError(/envelope rejected/);
    expect(() =>
      storage.decodeCredentialRowSync(db, { ...row, data: JSON.stringify(plain) }, rt, {
        table: T,
      }),
    ).toThrowError(/plaintext/i);
    expect(() =>
      storage.decodeCredentialRowSync(db, dbRow, rt, { table: T, mode: "bogus" }),
    ).toThrowError(/unknown mode/);
    expect(() =>
      storage.decodeCredentialRowSync(db, dbRow, rt, { table: T, mode: "migration" }),
    ).toThrowError(/internal/);
    expect(() =>
      storage.decodeCredentialRowSync(db, { ...row, data: "not json" }, rt, { table: T }),
    ).toThrowError(/valid JSON/);
    expect(() =>
      storage.encodeCredentialRowSync(
        db,
        { id: "n", workspaceId: null, data: { apiKey: "k" } },
        rt,
        { table: "providerNodes" },
      ),
    ).toThrowError(/without a workspace/);

    // Cache liveness: a deleted/replaced live key row is never served from cache.
    expect(storage.ensureWorkspaceDekSync(db, WS, rt).kid).toBe(a.kid); // warm
    db.run(`DELETE FROM workspaceKeys WHERE workspaceId = ?`, [WS]);
    expect(() => storage.decodeCredentialRowSync(db, dbRow, rt, { table: T })).toThrowError(
      /workspace key not found/,
    );
    storage.clearCredentialCache(db);
    expect(storage.DEK_CACHE_MAX).toBe(128);

    // Metadata/state: legacy state with stored envelopes and no marker is not legacy.
    expect(() => storage.prepareCredentialContext(db, null)).not.toThrow();
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, data, createdAt, updatedAt, workspaceId) VALUES('c-env','p','apikey',?,?,?,?)`,
      [JSON.stringify({ apiKey: stored.accessToken }), now, now, WS],
    );
    // Runtime context is marker-only (no scan); the strict reader catches it.
    expect(() => storage.prepareCredentialContext(db, null)).not.toThrow();
    const { readCredentialEncryptionState } = await import("@/lib/db/credentialEncryptionState.js");
    expect(() => readCredentialEncryptionState(db, { strict: true })).toThrowError(
      /without an encryption marker/,
    );
    db.run(`DELETE FROM providerConnections WHERE id = 'c-env'`);
  });

  it("auto-sync re-creates missing index when DB lacks it", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.exec(`DROP INDEX IF EXISTS idx_pn_type`);
    expect(db.all(`PRAGMA index_list(providerNodes)`).map((i) => i.name)).not.toContain(
      "idx_pn_type",
    );

    resetAdapter();
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const db2 = await getAdapter2();
    const idx = db2.all(`PRAGMA index_list(providerNodes)`).map((i) => i.name);
    expect(idx).toContain("idx_pn_type");
  });
});
