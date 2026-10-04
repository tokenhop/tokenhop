// YAN-363: hashGatewayKeysSync — atomic legacy→hashed key+usage migration core.
// Real adapter + real isolated temp DATA_DIR (tests/vitest.config.js), legacy
// fixture, sentinel scans. No runtime activation is performed by these tests.
import { beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { getAdapter } from "@/lib/db/driver.js";
import { hashGatewayKeysSync } from "@/lib/db/migrations/hashGatewayKeys.js";
import { readApiKeyStorageState } from "@/lib/db/apiKeyState.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { apiKeyPrefix } from "@/shared/utils/apiKey.js";

const NOW = "2026-10-03T00:00:00.000Z";
const WS = "default-ws";
const MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));
const KID = masterKeyId(MASTER);
const HASH_KEY = deriveApiKeyHashKey(MASTER);
const RAW_A = "th_0123456789ABCDEFGHIJKLMNOPQRSTUV"; // key-1 (known)
const RAW_B = "sk-machineid12345678-abc123-0f1e2d3c"; // key-2 (known, paused)
const RAW_U = "th_UNKNOWNGATEWAYTOKENxxxxxxxxxxxxxx"; // no key row → pseudonym
const RAW_GHOST = "th_AMBIGUOUSPRESETTOKENzzzzzzzzzzzz"; // preset, unknown by default
const EXTERNAL = "sk-proj-externalvendorcredential01"; // vetted external credential
const SENTINEL = "local-no-key";

const digest = (raw) => hashApiKey(raw, HASH_KEY);
const pseudonym = (raw) =>
  `historical:${createHmac("sha256", HASH_KEY).update("tokenhop/usage-key-id/v1\0", "utf8").update(raw, "utf8").digest("hex")}`;

let db;
let backup;

const dayFixture = () => ({
  byProvider: { openai: { requests: 3, cost: 1.5 } },
  byModel: { "gpt-4o": { requests: 3, cost: 1.5 } },
  byAccount: { "conn|gpt-4o|openai": { requests: 3, cost: 1.5, meta: { connectionId: "conn" } } },
  byEndpoint: { "Unknown|gpt-4o|openai": { requests: 3, cost: 1.5 } },
  byApiKey: {
    [`${RAW_A}|gpt-4o|openai`]: {
      requests: 2,
      promptTokens: 100,
      completionTokens: 40,
      cachedTokens: 0,
      cost: 1.0,
      meta: { rawModel: "gpt-4o", provider: "openai", apiKey: RAW_A },
    },
    [`${RAW_U}|gpt-4o|openai`]: {
      requests: 1,
      promptTokens: 50,
      completionTokens: 10,
      cachedTokens: 0,
      cost: 0.5,
      meta: { rawModel: "gpt-4o", provider: "openai", apiKey: RAW_U },
    },
    [`${SENTINEL}|gpt-4o|openai`]: {
      requests: 4,
      promptTokens: 20,
      completionTokens: 20,
      cachedTokens: 0,
      cost: 2.0,
      meta: { rawModel: "gpt-4o", provider: "openai", apiKey: SENTINEL },
    },
  },
});

function seedLegacy() {
  db.exec(`DROP TABLE IF EXISTS apiKeys`);
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT,
    isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)`);
  db.run(`DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')`);
  db.exec(
    `DELETE FROM usageHistory; DELETE FROM usageDaily; DELETE FROM kv WHERE scope = 'cliToolPresets'`,
  );
  db.run(`DELETE FROM workspaces WHERE id = ?`, [WS]);
  db.run(
    `INSERT INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES(?, ?, 'shared', ?, ?)`,
    [WS, WS, NOW, NOW],
  );
  db.run(`INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?,?,?,?,?,?)`, [
    "key-1",
    RAW_A,
    "Runner",
    "machine-1",
    1,
    NOW,
  ]);
  db.run(`INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?,?,?,?,?,?)`, [
    "key-2",
    RAW_B,
    "Paused",
    null,
    0,
    NOW,
  ]);
  db.run(`INSERT INTO usageHistory(timestamp, provider, model, apiKey, meta) VALUES(?,?,?,?,?)`, [
    NOW,
    "openai",
    "gpt-4o",
    RAW_A,
    JSON.stringify({ rawModel: "gpt-4o", provider: "openai", apiKey: RAW_A }),
  ]);
  db.run(`INSERT INTO usageHistory(timestamp, provider, model, apiKey, meta) VALUES(?,?,?,?,?)`, [
    NOW,
    "openai",
    "gpt-4o",
    RAW_B,
    null,
  ]);
  db.run(`INSERT INTO usageHistory(timestamp, provider, model, apiKey) VALUES(?,?,?,?)`, [
    NOW,
    "openai",
    "gpt-4o",
    RAW_U,
  ]);
  db.run(`INSERT INTO usageHistory(timestamp, provider, model, apiKey) VALUES(?,?,?,?)`, [
    NOW,
    "openai",
    "gpt-4o",
    null,
  ]);
  db.run(`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?)`, [
    "2026-10-02",
    JSON.stringify(dayFixture()),
  ]);
}

const setPresets = (items) =>
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES('cliToolPresets','apiKeys',?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify(items)],
  );

const run = (over = {}) =>
  hashGatewayKeysSync(db, {
    masterKey: MASTER,
    expectedKid: KID,
    defaultWorkspaceId: WS,
    backup,
    ...over,
  });

beforeEach(async () => {
  db = await getAdapter();
  seedLegacy();
  backup = { completed: true, db };
});

describe("hashGatewayKeysSync", () => {
  it("keeps raw/id collisions distinct and original client tokens eligible", async () => {
    const { getEligibleApiKeySync } = await import("@/lib/db/repos/apiKeysRepo.js");
    db.run("INSERT INTO usageHistory(timestamp, apiKey) VALUES (?, 'key-1')", [NOW]);
    run();
    expect(db.all("SELECT apiKey FROM usageHistory ORDER BY id").at(-1).apiKey).toBe(
      pseudonym("key-1"),
    );
    expect(getEligibleApiKeySync(db, "key-1", { keyHash: digest(RAW_A), now: NOW })).toMatchObject({
      id: "key-1",
      userId: null,
    });
    expect(getEligibleApiKeySync(db, "key-2", { keyHash: digest(RAW_B), now: NOW })).toBeNull();
    db.run("UPDATE apiKeys SET hashKid = ? WHERE id = 'key-1'", ["f".repeat(16)]);
    expect(() => run()).toThrow(expect.objectContaining({ code: "API_KEY_STATE_INVALID" }));
  });

  it("stops incoming key FKs before cascade or schema mutation", () => {
    db.exec("CREATE TABLE keyHistoryGuard(keyId TEXT REFERENCES apiKeys(id) ON DELETE CASCADE)");
    try {
      db.run("INSERT INTO keyHistoryGuard VALUES ('key-1')");
      expect(() => run()).toThrow(
        expect.objectContaining({ code: "API_KEY_MIGRATION_FK_UNSUPPORTED" }),
      );
      expect(db.get("SELECT COUNT(*) AS n FROM keyHistoryGuard").n).toBe(1);
      expect(db.get("SELECT key FROM apiKeys WHERE id = 'key-1'").key).toBe(RAW_A);
    } finally {
      db.exec("DROP TABLE keyHistoryGuard");
    }
  });

  it("rolls back keys, usage and presets when final marker write fails", () => {
    setPresets([{ name: "CI", key: RAW_A, extra: "preserved" }]);
    db.exec(
      "CREATE TRIGGER block_key_marker BEFORE INSERT ON _meta WHEN NEW.key = 'apiKeysHashKid' BEGIN SELECT RAISE(ABORT, 'marker blocked'); END",
    );
    try {
      expect(() => run()).toThrow("marker blocked");
      expect(db.get("SELECT key FROM apiKeys WHERE id = 'key-1'").key).toBe(RAW_A);
      expect(db.get("SELECT apiKey FROM usageHistory ORDER BY id LIMIT 1").apiKey).toBe(RAW_A);
      expect(db.get("SELECT value FROM kv WHERE scope = 'cliToolPresets'").value).toContain(RAW_A);
      expect(readApiKeyStorageState(db).storage).toBe("legacy");
    } finally {
      db.exec("DROP TRIGGER block_key_marker");
    }
  });
  it("atomically reshapes keys and converts usage with stable identity", () => {
    setPresets([
      { name: "CI", key: RAW_A },
      { name: "Vendor", key: EXTERNAL },
    ]);
    const result = run({ classifyPreset: () => "external" });
    expect(result).toMatchObject({
      alreadyMigrated: false,
      hashKid: KID,
      keysMigrated: 2,
      usageHistoryRowsUpdated: 4,
      usageDailyDaysUpdated: 1,
      presetsConverted: 1,
      presetsPreserved: 1,
    });

    // Hashed rows: stable id/name/machineId/status, legacy service keys of WS.
    const cols = db.all(`PRAGMA table_info(apiKeys)`).map((c) => c.name);
    expect(cols).toContain("keyHash");
    expect(cols).not.toContain("key");
    expect(db.get(`SELECT * FROM apiKeys WHERE id = 'key-1'`)).toMatchObject({
      workspaceId: WS,
      userId: null,
      createdByUserId: null,
      keyHash: digest(RAW_A),
      hashKid: KID,
      prefix: apiKeyPrefix(RAW_A),
      name: "Runner",
      machineId: "machine-1",
      legacy: 1,
      isActive: 1,
      revokedAt: null,
      allowedModels: "[]",
      allowedCombos: "[]",
      expiresAt: null,
      lastUsedAt: null,
      createdAt: NOW,
    });
    expect(db.get(`SELECT keyHash, isActive FROM apiKeys WHERE id = 'key-2'`)).toMatchObject({
      keyHash: digest(RAW_B),
      isActive: 0,
    });
    expect(readApiKeyStorageState(db)).toEqual({ storage: "hashed", version: 1, hashKid: KID });
    expect(db.all(`PRAGMA foreign_key_check`)).toEqual([]);

    // usageHistory: ids and keyed pseudonyms; null stays null.
    const history = db.all(`SELECT apiKey, meta FROM usageHistory ORDER BY rowid`);
    expect(history.map((r) => r.apiKey)).toEqual(["key-1", "key-2", pseudonym(RAW_U), null]);
    expect(JSON.parse(history[0].meta).apiKey).toBe("key-1");

    // usageDaily: rekeyed dict + meta.apiKey converted, counters preserved.
    const day = JSON.parse(db.get(`SELECT data FROM usageDaily WHERE dateKey = '2026-10-02'`).data);
    expect(Object.keys(day.byApiKey).sort()).toEqual(
      [
        "key-1|gpt-4o|openai",
        `${pseudonym(RAW_U)}|gpt-4o|openai`,
        `${SENTINEL}|gpt-4o|openai`,
      ].sort(),
    );
    expect(day.byApiKey["key-1|gpt-4o|openai"]).toMatchObject({
      requests: 2,
      cost: 1.0,
      meta: { rawModel: "gpt-4o", provider: "openai", apiKey: "key-1" },
    });
    const totals = (d) =>
      Object.values(d.byApiKey).reduce(
        (acc, b) => ({ requests: acc.requests + b.requests, cost: acc.cost + b.cost }),
        { requests: 0, cost: 0 },
      );
    expect(totals(day)).toEqual(totals(dayFixture()));

    // Presets: recognized local token → { apiKeyId } metadata (no raw key);
    // vetted external credential preserved byte-for-byte.
    const presets = JSON.parse(
      db.get(`SELECT value FROM kv WHERE scope='cliToolPresets' AND key='apiKeys'`).value,
    );
    expect(presets).toContainEqual({ name: "CI", apiKeyId: "key-1" });
    expect(presets).toContainEqual({ name: "Vendor", key: EXTERNAL });

    // Sentinel: no raw gateway token survives anywhere reachable.
    for (const raw of [RAW_A, RAW_B, RAW_U]) {
      expect(JSON.stringify(db.all(`SELECT * FROM apiKeys`))).not.toContain(raw);
      expect(JSON.stringify(db.all(`SELECT * FROM usageHistory`))).not.toContain(raw);
      expect(JSON.stringify(db.all(`SELECT * FROM usageDaily`))).not.toContain(raw);
      expect(JSON.stringify(db.all(`SELECT * FROM kv`))).not.toContain(raw);
    }
  });

  it("aborts before mutation on bad master, wrong hash key, or missing backup attestation", () => {
    const pristine = () => {
      expect(db.all(`PRAGMA table_info(apiKeys)`).map((c) => c.name)).toContain("key");
      expect(db.get(`SELECT key FROM apiKeys WHERE id='key-1'`).key).toBe(RAW_A);
      expect(readApiKeyStorageState(db)).toEqual({
        storage: "legacy",
        version: null,
        hashKid: null,
      });
    };
    for (const [over, code] of [
      [{ masterKey: Buffer.alloc(16) }, "API_KEY_MIGRATION_MASTER_KEY_INVALID"],
      [{ masterKey: null }, "API_KEY_MIGRATION_MASTER_KEY_INVALID"],
      [{ hashKey: Buffer.alloc(32) }, "API_KEY_MIGRATION_KID_MISMATCH"],
      [{ expectedKid: "f".repeat(16) }, "API_KEY_MIGRATION_KID_MISMATCH"],
      [{ backup: undefined }, "API_KEY_MIGRATION_BACKUP_REQUIRED"],
      [{ backup: { completed: true } }, "API_KEY_MIGRATION_BACKUP_REQUIRED"],
      [{ backup: { completed: false, db } }, "API_KEY_MIGRATION_BACKUP_REQUIRED"],
      [{ defaultWorkspaceId: "missing-ws" }, "API_KEY_MIGRATION_WORKSPACE_MISSING"],
    ]) {
      expect(() => run(over)).toThrow(expect.objectContaining({ code }));
      pristine();
    }
    // A different adapter is not a valid attestation for this db.
    expect(() =>
      hashGatewayKeysSync(db, {
        masterKey: MASTER,
        expectedKid: KID,
        defaultWorkspaceId: WS,
        backup: { completed: true, db: { get: () => ({}) } },
      }),
    ).toThrow(expect.objectContaining({ code: "API_KEY_MIGRATION_BACKUP_REQUIRED" }));
    pristine();
  });

  it("stops on ambiguous preset provenance with a secret-free error and no mutation", () => {
    setPresets([
      { name: "CI", key: RAW_A },
      { name: "Ghost", key: RAW_GHOST },
    ]);
    const err = (() => {
      try {
        run();
      } catch (e) {
        return e;
      }
    })();
    expect(err).toMatchObject({ code: "API_KEY_MIGRATION_AMBIGUOUS_PRESET" });
    expect(err.message).toContain("index 1");
    expect(err.message).not.toContain(RAW_GHOST);
    expect(err.message).not.toContain("Ghost"); // secret-free: names withheld too
    expect(db.all(`PRAGMA table_info(apiKeys)`).map((c) => c.name)).toContain("key");
    expect(db.get(`SELECT key FROM apiKeys WHERE id='key-1'`).key).toBe(RAW_A);
    expect(readApiKeyStorageState(db)).toEqual({ storage: "legacy", version: null, hashKid: null });
    expect(db.get(`SELECT value FROM kv WHERE scope='cliToolPresets'`).value).toContain(RAW_A);

    // A throwing/lying classifier is still a stop, never a silent conversion.
    expect(() =>
      run({
        classifyPreset: () => {
          throw new Error(RAW_GHOST);
        },
      }),
    ).toThrow(expect.objectContaining({ code: "API_KEY_MIGRATION_AMBIGUOUS_PRESET" }));
    pristineCheck();
    function pristineCheck() {
      expect(readApiKeyStorageState(db)).toEqual({
        storage: "legacy",
        version: null,
        hashKid: null,
      });
    }

    // Vetted external classification preserves the credential byte-for-byte.
    const result = run({ classifyPreset: () => "external" });
    expect(result.presetsPreserved).toBe(1);
    expect(
      JSON.parse(
        db.get(`SELECT value FROM kv WHERE scope='cliToolPresets' AND key='apiKeys'`).value,
      ),
    ).toContainEqual({ name: "Ghost", key: RAW_GHOST });
  });

  it("rolls back fully when a step fails midway", () => {
    const before = {
      keys: db.all(`SELECT * FROM apiKeys ORDER BY id`),
      daily: db.get(`SELECT data FROM usageDaily WHERE dateKey='2026-10-02'`).data,
      history: db.all(`SELECT rowid, apiKey, meta FROM usageHistory ORDER BY rowid`),
    };
    db.exec(
      `CREATE TRIGGER block_history_update BEFORE UPDATE ON usageHistory BEGIN SELECT RAISE(ABORT, 'blocked'); END`,
    );
    expect(() => run()).toThrow("blocked");
    db.exec(`DROP TRIGGER block_history_update`);
    expect(
      db.get(`SELECT 1 AS x FROM sqlite_master WHERE name = 'apiKeys_hash_stage'`),
    ).toBeUndefined();
    expect(db.all(`SELECT * FROM apiKeys ORDER BY id`)).toEqual(before.keys);
    expect(db.get(`SELECT data FROM usageDaily WHERE dateKey='2026-10-02'`).data).toBe(
      before.daily,
    );
    expect(db.all(`SELECT rowid, apiKey, meta FROM usageHistory ORDER BY rowid`)).toEqual(
      before.history,
    );
    expect(readApiKeyStorageState(db)).toEqual({ storage: "legacy", version: null, hashKid: null });
    expect(db.all(`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it("reentry is idempotent: validates kid/state, never rehashes or re-converts", () => {
    setPresets([{ name: "CI", key: RAW_A }]);
    expect(run()).toMatchObject({ alreadyMigrated: false, presetsConverted: 1 });
    const after = {
      keys: db.all(`SELECT id, keyHash FROM apiKeys ORDER BY id`),
      history: db.all(`SELECT apiKey, meta FROM usageHistory ORDER BY rowid`),
      daily: db.get(`SELECT data FROM usageDaily WHERE dateKey='2026-10-02'`).data,
      presets: db.get(`SELECT value FROM kv WHERE scope='cliToolPresets'`).value,
    };
    // A preset still holding an unknown raw is NOT ambiguous on hashed reentry.
    setPresets([{ name: "Late", key: RAW_GHOST }]);
    expect(run()).toEqual({ alreadyMigrated: true, hashKid: KID });
    // Wrong master on hashed reentry aborts without mutation.
    const otherMaster = Buffer.alloc(32, 9);
    expect(() =>
      hashGatewayKeysSync(db, {
        masterKey: otherMaster,
        expectedKid: masterKeyId(otherMaster),
        defaultWorkspaceId: WS,
        backup,
      }),
    ).toThrow(expect.objectContaining({ code: "API_KEY_MIGRATION_KID_MISMATCH" }));
    expect(db.all(`SELECT id, keyHash FROM apiKeys ORDER BY id`)).toEqual(after.keys);
    expect(db.all(`SELECT apiKey, meta FROM usageHistory ORDER BY rowid`)).toEqual(after.history);
    expect(db.get(`SELECT data FROM usageDaily WHERE dateKey='2026-10-02'`).data).toBe(after.daily);
    expect(db.get(`SELECT value FROM kv WHERE scope='cliToolPresets'`).value).toContain("Late");
  });

  it("fail closed on malformed payloads that could hide raw values", () => {
    db.run(`UPDATE usageDaily SET data = 'not-json' WHERE dateKey = '2026-10-02'`);
    expect(() => run()).toThrow(
      expect.objectContaining({ code: "API_KEY_MIGRATION_JSON_INVALID" }),
    );
    expect(db.all(`PRAGMA table_info(apiKeys)`).map((c) => c.name)).toContain("key");
    db.run(`UPDATE usageDaily SET data = ? WHERE dateKey = '2026-10-02'`, [
      JSON.stringify(dayFixture()),
    ]);
    db.run(`INSERT INTO usageHistory(timestamp, apiKey, meta) VALUES(?, ?, ?)`, [
      NOW,
      null,
      '{"apiKey":broken',
    ]);
    expect(() => run()).toThrow(
      expect.objectContaining({ code: "API_KEY_MIGRATION_JSON_INVALID" }),
    );
    expect(readApiKeyStorageState(db)).toEqual({ storage: "legacy", version: null, hashKid: null });
    db.run(`DELETE FROM usageHistory WHERE meta = '{"apiKey":broken'`);
    setPresets("not-an-array");
    expect(() => run()).toThrow(
      expect.objectContaining({ code: "API_KEY_MIGRATION_PRESET_INVALID" }),
    );
    expect(readApiKeyStorageState(db)).toEqual({ storage: "legacy", version: null, hashKid: null });
  });
});
