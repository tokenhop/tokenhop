// YAN-363 instance transfer: legacy roundtrip parity, format v2 hashed
// snapshots, root-proof preflight, legacy→hashed conversion, raw-leak and
// rollback safety. Real adapter + real isolated temp DATA_DIR
// (tests/vitest.config.js). No migration/runtime activation performed here.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import * as dbApi from "@/lib/db/index.js";
import { readApiKeyStorageState } from "@/lib/db/apiKeyState.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { apiKeyPrefix } from "@/shared/utils/apiKey.js";

vi.mock("@/lib/auth/apiKeyPrincipal.js", () => ({
  clearApiKeyPrincipalCache: vi.fn(),
}));

// These YAN-365 fixtures assert the pre-Users & teams compatibility contract.
vi.mock("@/lib/users/featureSwitch.js", () => ({ isMultiUserEnabled: vi.fn(async () => false) }));

const { clearApiKeyPrincipalCache } = await import("@/lib/auth/apiKeyPrincipal.js");

const NOW = "2026-10-03T00:00:00.000Z";
const MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));
const OTHER_MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 11 + 5) % 256));
const KID = masterKeyId(MASTER);
const HASH_KEY = deriveApiKeyHashKey(MASTER);
const WS = "ws-default";
const RAW_H = "th_HASHEDGATEWAYTOKENxxxxxxxxxxxxxxx"; // hashed-instance key
const RAW_L = "th_LEGACYPLAINTEXTTOKENxxxxxxxxxxxxxxx"; // legacy snapshot key
const digest = (raw, key = HASH_KEY) => hashApiKey(raw, key);

let db;
const all = (sql) => db.all(sql);
const one = (sql) => db.get(sql);
const tableDump = () =>
  JSON.stringify({
    apiKeys: all("SELECT * FROM apiKeys"),
    users: all("SELECT * FROM users"),
    identities: all("SELECT * FROM identities"),
    workspaces: all("SELECT * FROM workspaces"),
    memberships: all("SELECT * FROM memberships"),
    connections: all("SELECT * FROM providerConnections"),
    kv: all("SELECT * FROM kv WHERE scope = 'cliToolPresets'"),
    meta: all("SELECT * FROM _meta"),
  });
const transferError = (code) => expect.objectContaining({ code });

function seedLegacyInstance() {
  db.exec(`DROP TABLE IF EXISTS apiKeys`);
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT,
    isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)`);
  db.run(`DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')`);
  db.run(`INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?,?,?,?,?,?)`, [
    "legacy-1",
    RAW_L,
    "Legacy runner",
    "machine-1",
    1,
    NOW,
  ]);
}

function seedHashedInstance() {
  db.exec(`DROP TABLE IF EXISTS apiKeys`);
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    userId TEXT REFERENCES users(id) ON DELETE CASCADE,
    createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
    keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
    machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
    revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
    expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
  db.exec(
    `DELETE FROM memberships; DELETE FROM identities; DELETE FROM workspaces; DELETE FROM users;
     DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid','defaultWorkspaceId')`,
  );
  for (const id of ["owner", "member1"]) {
    db.run(
      `INSERT INTO users(id, email, username, displayName, instanceRole, status, passwordHash, sessionVersion, createdAt, updatedAt, lastLoginAt)
       VALUES(?, ?, ?, ?, ?, 'active', ?, 1, ?, ?, NULL)`,
      [id, `${id}@x.test`, id, id, id === "owner" ? "owner" : "user", "hashedsecret", NOW, NOW],
    );
  }
  db.run(
    `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES(?, 'Default', 'shared', 'owner', ?, ?)`,
    [WS, NOW, NOW],
  );
  db.run(
    `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?, 'owner', 'owner', 'manual', ?)`,
    [WS, NOW],
  );
  db.run(
    `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?, 'member1', 'member', 'manual', ?)`,
    [WS, NOW],
  );
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, workspaceId, createdByUserId)
     VALUES('conn-1', 'openai', 'api_key', 'Main', NULL, 1, 1, ?, ?, ?, ?, 'owner')`,
    [JSON.stringify({ accessToken: "sk-upstream-cred" }), NOW, NOW, WS],
  );
  db.run(
    `INSERT INTO apiKeys(id, workspaceId, userId, createdByUserId, keyHash, hashKid, prefix, name, machineId, legacy, isActive, allowedModels, createdAt)
     VALUES('hk-1', ?, 'member1', 'owner', ?, ?, ?, 'Runner', NULL, 0, 1, ?, ?)`,
    [WS, digest(RAW_H), KID, apiKeyPrefix(RAW_H), JSON.stringify(["gpt-4o"]), NOW],
  );
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES('cliToolPresets','apiKeys',?) ON CONFLICT(scope,key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify([{ name: "CI", apiKeyId: "hk-1" }])],
  );
  db.run(
    `INSERT INTO _meta(key, value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?), ('defaultWorkspaceId',?)`,
    [KID, WS],
  );
}

beforeEach(async () => {
  db = await getAdapter();
  db.exec("DROP TABLE IF EXISTS gatewayVideoJobs");
  db.exec(`DELETE FROM kv WHERE scope = 'cliToolPresets'`);
  vi.clearAllMocks();
});

describe("legacy instance transfer (existing shape intact)", () => {
  beforeEach(seedLegacyInstance);

  it("exports the exact legacy snapshot shape and roundtrips raw keys", async () => {
    const snapshot = await dbApi.exportDb();
    expect(snapshot.formatVersion).toBeUndefined();
    expect(snapshot.apiKeyStorage).toBeUndefined();
    expect(snapshot.users).toBeUndefined();
    expect(snapshot.apiKeys).toEqual([
      expect.objectContaining({ id: "legacy-1", key: RAW_L, isActive: true }),
    ]);
    expect(one(`SELECT key FROM apiKeys WHERE id = 'legacy-1'`).key).toBe(RAW_L);

    db.run(`DELETE FROM apiKeys`);
    await dbApi.importDb(structuredClone(snapshot));
    expect(one(`SELECT key FROM apiKeys WHERE id = 'legacy-1'`).key).toBe(RAW_L);
    expect(await dbApi.validateApiKey(RAW_L)).toBe(true);
    expect(readApiKeyStorageState(db).storage).toBe("legacy");
  });

  it("ignores an imported mitmInternalVerifier and preserves the live local one", async () => {
    const LOCAL = "a".repeat(64);
    const FOREIGN = "b".repeat(64);
    const { stringifyJson } = await import("@/lib/db/helpers/jsonCol.js");
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson({ requireLogin: true, mitmInternalVerifier: LOCAL })],
    );
    const snapshot = await dbApi.exportDb();
    expect(snapshot.settings).not.toHaveProperty("mitmInternalVerifier");
    snapshot.settings = { ...(snapshot.settings ?? {}), mitmInternalVerifier: FOREIGN };
    await dbApi.importDb(structuredClone(snapshot));
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    expect(JSON.parse(row.data).mitmInternalVerifier).toBe(LOCAL);
    expect(JSON.parse(row.data).requireLogin).toBe(true);
  });

  it("drops an imported verifier when no live local one exists", async () => {
    const { stringifyJson } = await import("@/lib/db/helpers/jsonCol.js");
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson({ requireLogin: true })],
    );
    const snapshot = await dbApi.exportDb();
    snapshot.settings = { ...(snapshot.settings ?? {}), mitmInternalVerifier: "c".repeat(64) };
    await dbApi.importDb(structuredClone(snapshot));
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    expect(JSON.parse(row.data)).not.toHaveProperty("mitmInternalVerifier");
    expect(JSON.parse(row.data).requireLogin).toBe(true);
  });
});

describe("hashed instance transfer (format v2)", () => {
  beforeEach(seedHashedInstance);

  it("exports key metadata only — no raw key, no master material", async () => {
    const snapshot = await dbApi.exportDb();
    expect(snapshot.formatVersion).toBe(2);
    expect(snapshot.apiKeyStorage).toEqual({ storage: "hashed", version: 1, hashKid: KID });
    expect(snapshot.apiKeys).toEqual([
      expect.objectContaining({
        id: "hk-1",
        workspaceId: WS,
        userId: "member1",
        keyHash: digest(RAW_H),
        hashKid: KID,
        prefix: apiKeyPrefix(RAW_H),
        legacy: 0,
        isActive: 1,
        allowedModels: ["gpt-4o"],
      }),
    ]);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(RAW_H);
    expect(serialized).not.toContain(MASTER.toString("base64"));
    expect(serialized).not.toContain(MASTER.toString("hex"));
    expect(snapshot.users).toEqual([
      expect.objectContaining({ id: "owner" }),
      expect.objectContaining({ id: "member1" }),
    ]);
    expect(snapshot.workspaces).toEqual([expect.objectContaining({ id: WS, kind: "shared" })]);
    expect(snapshot.memberships).toHaveLength(2);
    expect(snapshot.tenancy).toEqual({ defaultWorkspaceId: WS });
    expect(snapshot.providerConnections[0]).toMatchObject({
      workspaceId: WS,
      createdByUserId: "owner",
    });
  });

  it("same-master roundtrip restores the full snapshot", async () => {
    const snapshot = await dbApi.exportDb();
    db.run(`DELETE FROM apiKeys`);
    db.run(`DELETE FROM memberships WHERE userId = 'member1'`);
    db.run(
      `INSERT INTO apiKeys(id, workspaceId, userId, keyHash, hashKid, prefix, legacy, isActive, createdAt)
            VALUES('intruder', ?, NULL, ?, ?, 'x', 0, 1, ?)`,
      [WS, "0".repeat(64), KID, NOW],
    );

    await dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER });

    const restored = await dbApi.exportDb();
    expect(restored.apiKeys).toEqual(snapshot.apiKeys);
    expect(restored.users).toEqual(snapshot.users);
    expect(restored.workspaces).toEqual(snapshot.workspaces);
    expect(restored.memberships).toEqual(snapshot.memberships);
    expect(restored.tenancy).toEqual(snapshot.tenancy);
    expect(restored.providerConnections).toEqual(snapshot.providerConnections);
    expect(restored.apiKeyStorage).toEqual(snapshot.apiKeyStorage);
    const { getEligibleApiKeySync } = await import("@/lib/db/repos/apiKeysRepo.js");
    expect(getEligibleApiKeySync(db, "hk-1", { keyHash: digest(RAW_H), now: NOW })).toMatchObject({
      id: "hk-1",
      workspaceId: WS,
    });
    expect(clearApiKeyPrincipalCache).toHaveBeenCalled();
  });

  it("v2 restore keeps the live local verifier and ignores an imported one", async () => {
    const LOCAL = "d".repeat(64);
    const FOREIGN = "e".repeat(64);
    const { stringifyJson } = await import("@/lib/db/helpers/jsonCol.js");
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson({ requireLogin: true, mitmInternalVerifier: LOCAL })],
    );
    const snapshot = await dbApi.exportDb();
    expect(snapshot.settings).not.toHaveProperty("mitmInternalVerifier");
    snapshot.settings = { ...(snapshot.settings ?? {}), mitmInternalVerifier: FOREIGN };
    await dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER });
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    expect(JSON.parse(row.data).mitmInternalVerifier).toBe(LOCAL);
    expect(JSON.parse(row.data).requireLogin).toBe(true);
  });

  it("wrong master fails preflight with zero mutation", async () => {
    const before = tableDump();
    const snapshot = await dbApi.exportDb();
    await expect(dbApi.importDb(snapshot, { masterKey: OTHER_MASTER })).rejects.toThrow(
      transferError("TRANSFER_ROOT_MISMATCH"),
    );
    expect(tableDump()).toBe(before);
  });

  it("missing master fails preflight with zero mutation", async () => {
    const before = tableDump();
    const snapshot = await dbApi.exportDb();
    await expect(dbApi.importDb(snapshot)).rejects.toThrow(
      transferError("TRANSFER_MASTER_REQUIRED"),
    );
    await expect(
      dbApi.importDb({ apiKeys: [{ id: "x", key: RAW_L, createdAt: NOW }] }),
    ).rejects.toThrow(transferError("TRANSFER_MASTER_REQUIRED"));
    expect(tableDump()).toBe(before);
  });

  it("loads the trusted master from env when no option is supplied", async () => {
    vi.stubEnv("TOKENHOP_MASTER_KEY", MASTER.toString("base64"));
    try {
      const snapshot = await dbApi.exportDb();
      db.run(`DELETE FROM apiKeys`);
      await dbApi.importDb(structuredClone(snapshot));
      expect(one(`SELECT COUNT(*) AS n FROM apiKeys`).n).toBe(1);

      // Legacy payload into the same hashed instance also roots via the loader.
      await dbApi.importDb({
        apiKeys: [{ id: "legacy-env", key: RAW_L, isActive: true, createdAt: NOW }],
      });
      expect(one(`SELECT keyHash FROM apiKeys WHERE id = 'legacy-env'`).keyHash).toBe(
        digest(RAW_L),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("wrong trusted master fails with zero mutation", async () => {
    vi.stubEnv("TOKENHOP_MASTER_KEY", OTHER_MASTER.toString("base64"));
    try {
      const before = tableDump();
      await expect(dbApi.importDb(await dbApi.exportDb())).rejects.toThrow(
        transferError("TRANSFER_ROOT_MISMATCH"),
      );
      expect(tableDump()).toBe(before);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses master material inside the payload body", async () => {
    const snapshot = await dbApi.exportDb();
    snapshot.masterKey = MASTER.toString("base64");
    const before = tableDump();
    await expect(dbApi.importDb(snapshot, { masterKey: MASTER })).rejects.toThrow(
      transferError("TRANSFER_STATE_INVALID"),
    );
    expect(tableDump()).toBe(before);
  });

  it("enforces typed shape checks for every generic section", async () => {
    const cases = [
      [(s) => (s.apiKeys[0].budgetId = "b"), "TRANSFER_STATE_INVALID"],
      [(s) => (s.apiKeys[0].hashKid = "f".repeat(16)), "TRANSFER_STATE_INVALID"],
      [(s) => (s.apiKeys[0].createdAt = "yesterday"), "TRANSFER_STATE_INVALID"],
      [(s) => (s.apiKeys[0].allowedModels = "gpt"), "TRANSFER_STATE_INVALID"],
      [(s) => (s.apiKeyStorage.version = 2), "TRANSFER_STATE_INVALID"],
      [(s) => (s.formatVersion = 3), "TRANSFER_STATE_INVALID"],
      [(s) => (s.apiKeyStorage.storage = "legacy"), "TRANSFER_STATE_INVALID"],
      [(s) => (s.memberships[0].role = "superuser"), "TRANSFER_STATE_INVALID"],
      [
        (s) =>
          s.identities.push({
            id: "id-1",
            userId: "owner",
            provider: "password",
            issuer: "",
            subject: null,
            createdAt: NOW,
          }),
        "TRANSFER_STATE_INVALID",
      ],
      [(s) => (s.users[1].email = s.users[0].email), "TRANSFER_STATE_INVALID"],
      [(s) => (s.providerConnections[0] = 42), "TRANSFER_STATE_INVALID"],
    ];
    for (const [mutate, code] of cases) {
      const snapshot = await dbApi.exportDb();
      mutate(snapshot);
      const before = tableDump();
      await expect(dbApi.importDb(snapshot, { masterKey: MASTER })).rejects.toThrow(
        transferError(code),
      );
      expect(tableDump()).toBe(before);
    }
  });

  it("rejects hashed snapshots into legacy instances (typed precondition)", async () => {
    const snapshot = await dbApi.exportDb();
    const before = tableDump();
    seedLegacyInstance();
    await expect(dbApi.importDb(snapshot, { masterKey: MASTER })).rejects.toThrow(
      transferError("TRANSFER_INSTANCE_MODE_UNSUPPORTED"),
    );
    expect(one(`SELECT key FROM apiKeys WHERE id = 'legacy-1'`).key).toBe(RAW_L);
    expect(before).toBeTruthy();
  });

  it("rolls back the whole apply when a mid-transaction write fails", async () => {
    const snapshot = await dbApi.exportDb();
    const before = tableDump();
    db.exec(
      `CREATE TRIGGER block_transfer BEFORE INSERT ON memberships BEGIN SELECT RAISE(ABORT, 'transfer blocked'); END`,
    );
    try {
      await expect(dbApi.importDb(snapshot, { masterKey: MASTER })).rejects.toThrow(
        "transfer blocked",
      );
      expect(tableDump()).toBe(before);
    } finally {
      db.exec(`DROP TRIGGER block_transfer`);
    }
  });

  it("fails preflight on dangling tenancy.defaultWorkspaceId", async () => {
    const snapshot = await dbApi.exportDb();
    snapshot.tenancy.defaultWorkspaceId = "ghost-ws";
    const before = tableDump();
    await expect(dbApi.importDb(snapshot, { masterKey: MASTER })).rejects.toThrow(
      transferError("TRANSFER_REF_INVALID"),
    );
    expect(tableDump()).toBe(before);
  });

  it("fails preflight on duplicate apiKey id", async () => {
    const snapshot = await dbApi.exportDb();
    snapshot.apiKeys.push(structuredClone(snapshot.apiKeys[0]));
    const before = tableDump();
    await expect(dbApi.importDb(snapshot, { masterKey: MASTER })).rejects.toThrow(
      transferError("TRANSFER_STATE_INVALID"),
    );
    expect(tableDump()).toBe(before);
  });

  it("roundtrips live video jobs with full provenance", async () => {
    db.exec(
      `CREATE TABLE gatewayVideoJobs(workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, jobId TEXT NOT NULL, provider TEXT NOT NULL, connectionId TEXT NOT NULL, modelId TEXT NOT NULL, createdAt TEXT NOT NULL, PRIMARY KEY (workspaceId, provider, jobId))`,
    );
    try {
      db.run(
        `INSERT INTO gatewayVideoJobs VALUES(?, 'job-1', 'openai', 'conn-1', 'openai/gpt-4o', ?)`,
        [WS, NOW],
      );
      db.run(
        `INSERT INTO gatewayVideoJobs VALUES(?, 'job-2', 'openai', 'conn-1', 'openai/sora', ?)`,
        [WS, NOW],
      );
      const snapshot = await dbApi.exportDb();
      expect(snapshot.gatewayVideoJobs).toHaveLength(2);

      db.run(`DELETE FROM gatewayVideoJobs`);
      await dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER });
      expect(one(`SELECT COUNT(*) AS n FROM gatewayVideoJobs`).n).toBe(2);
      expect(one(`SELECT * FROM gatewayVideoJobs WHERE jobId = 'job-1'`)).toEqual({
        workspaceId: WS,
        jobId: "job-1",
        provider: "openai",
        connectionId: "conn-1",
        modelId: "openai/gpt-4o",
        createdAt: NOW,
      });
    } finally {
      db.exec(`DROP TABLE gatewayVideoJobs`);
    }
  });

  it("older-v2 snapshot without gatewayVideoJobs retains compatible live bindings", async () => {
    db.exec(
      `CREATE TABLE gatewayVideoJobs(workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, jobId TEXT NOT NULL, provider TEXT NOT NULL, connectionId TEXT NOT NULL, modelId TEXT NOT NULL, createdAt TEXT NOT NULL, PRIMARY KEY (workspaceId, provider, jobId))`,
    );
    try {
      db.run(
        `INSERT INTO gatewayVideoJobs VALUES(?, 'job-1', 'openai', 'conn-1', 'openai/gpt-4o', ?)`,
        [WS, NOW],
      );
      db.run(
        `INSERT INTO gatewayVideoJobs VALUES(?, 'job-2', 'openai', 'conn-1', 'openai/sora', ?)`,
        [WS, NOW],
      );
      const snapshot = await dbApi.exportDb();
      expect(snapshot.gatewayVideoJobs).toHaveLength(2);
      // Older-v2 shape: the section is entirely absent (no own property).
      delete snapshot.gatewayVideoJobs;
      expect(Object.hasOwn(snapshot, "gatewayVideoJobs")).toBe(false);

      await dbApi.importDb(snapshot, { masterKey: MASTER });

      expect(one(`SELECT COUNT(*) AS n FROM gatewayVideoJobs`).n).toBe(2);
      expect(one(`SELECT * FROM gatewayVideoJobs WHERE jobId = 'job-1'`)).toEqual({
        workspaceId: WS,
        jobId: "job-1",
        provider: "openai",
        connectionId: "conn-1",
        modelId: "openai/gpt-4o",
        createdAt: NOW,
      });
      expect(one(`SELECT * FROM gatewayVideoJobs WHERE jobId = 'job-2'`).modelId).toBe(
        "openai/sora",
      );
    } finally {
      db.exec(`DROP TABLE gatewayVideoJobs`);
    }
  });

  it("older-v2 snapshot with incompatible live bindings rejects before any mutation", async () => {
    const snapshot = await dbApi.exportDb();
    expect(snapshot.gatewayVideoJobs).toEqual([]);
    delete snapshot.gatewayVideoJobs;
    db.exec(
      `CREATE TABLE gatewayVideoJobs(workspaceId TEXT NOT NULL, jobId TEXT NOT NULL, provider TEXT NOT NULL, connectionId TEXT NOT NULL, modelId TEXT NOT NULL, createdAt TEXT NOT NULL, PRIMARY KEY (workspaceId, provider, jobId))`,
    );
    try {
      // Live row points at a connection the incoming snapshot does not carry.
      db.run(
        `INSERT INTO gatewayVideoJobs VALUES(?, 'job-1', 'openai', 'gone-conn', 'openai/gpt-4o', ?)`,
        [WS, NOW],
      );
      const before = tableDump();
      await expect(dbApi.importDb(snapshot, { masterKey: MASTER })).rejects.toThrow(
        transferError("TRANSFER_REF_INVALID"),
      );
      expect(tableDump()).toBe(before);
      expect(one(`SELECT COUNT(*) AS n FROM gatewayVideoJobs`).n).toBe(1);
      expect(one(`SELECT connectionId FROM gatewayVideoJobs`).connectionId).toBe("gone-conn");
    } finally {
      db.exec(`DROP TABLE gatewayVideoJobs`);
    }
  });

  it("explicit empty gatewayVideoJobs array is an authoritative clear", async () => {
    db.exec(
      `CREATE TABLE gatewayVideoJobs(workspaceId TEXT NOT NULL, jobId TEXT NOT NULL, provider TEXT NOT NULL, connectionId TEXT NOT NULL, modelId TEXT NOT NULL, createdAt TEXT NOT NULL, PRIMARY KEY (workspaceId, provider, jobId))`,
    );
    try {
      db.run(
        `INSERT INTO gatewayVideoJobs VALUES(?, 'job-1', 'openai', 'conn-1', 'openai/gpt-4o', ?)`,
        [WS, NOW],
      );
      const snapshot = await dbApi.exportDb();
      expect(snapshot.gatewayVideoJobs).toHaveLength(1);
      // Explicit [] (own property present) clears the live bindings.
      snapshot.gatewayVideoJobs = [];

      await dbApi.importDb(snapshot, { masterKey: MASTER });

      expect(one(`SELECT COUNT(*) AS n FROM gatewayVideoJobs`).n).toBe(0);
    } finally {
      db.exec(`DROP TABLE gatewayVideoJobs`);
    }
  });

  it.each([null, {}, "not-an-array", 42])(
    "rejects own-present gatewayVideoJobs=%j before mutation, retaining live bindings",
    async (value) => {
      db.exec(
        `CREATE TABLE gatewayVideoJobs(workspaceId TEXT NOT NULL, jobId TEXT NOT NULL, provider TEXT NOT NULL, connectionId TEXT NOT NULL, modelId TEXT NOT NULL, createdAt TEXT NOT NULL, PRIMARY KEY (workspaceId, provider, jobId))`,
      );
      try {
        db.run(
          `INSERT INTO gatewayVideoJobs VALUES(?, 'job-1', 'openai', 'conn-1', 'openai/gpt-4o', ?)`,
          [WS, NOW],
        );
        const snapshot = await dbApi.exportDb();
        snapshot.gatewayVideoJobs = value;
        expect(Object.hasOwn(snapshot, "gatewayVideoJobs")).toBe(true);
        const before = tableDump();
        const jobsBefore = all("SELECT * FROM gatewayVideoJobs");

        await expect(dbApi.importDb(snapshot, { masterKey: MASTER })).rejects.toThrow(
          transferError("TRANSFER_STATE_INVALID"),
        );

        expect(tableDump()).toBe(before);
        expect(all("SELECT * FROM gatewayVideoJobs")).toEqual(jobsBefore);
      } finally {
        db.exec(`DROP TABLE gatewayVideoJobs`);
      }
    },
  );

  it("fails preflight on snapshot job dangling refs before mutation", async () => {
    const snapshot = await dbApi.exportDb();
    snapshot.gatewayVideoJobs = [
      {
        workspaceId: WS,
        jobId: "job-1",
        provider: "openai",
        connectionId: "conn-1",
        modelId: "openai/gpt-4o",
        createdAt: NOW,
      },
    ];
    snapshot.gatewayVideoJobs[0].workspaceId = "ghost-ws";
    const before = tableDump();
    await expect(dbApi.importDb(snapshot, { masterKey: MASTER })).rejects.toThrow(
      transferError("TRANSFER_REF_INVALID"),
    );
    expect(tableDump()).toBe(before);

    const other = structuredClone(snapshot);
    other.gatewayVideoJobs[0].connectionId = "ghost-conn";
    await expect(dbApi.importDb(other, { masterKey: MASTER })).rejects.toThrow(
      transferError("TRANSFER_REF_INVALID"),
    );
    expect(tableDump()).toBe(before);
  });

  it("fails preflight on live job dangling refs before mutation", async () => {
    db.exec(
      `CREATE TABLE gatewayVideoJobs(workspaceId TEXT NOT NULL, jobId TEXT NOT NULL, provider TEXT NOT NULL, connectionId TEXT NOT NULL, modelId TEXT NOT NULL, createdAt TEXT NOT NULL, PRIMARY KEY (workspaceId, provider, jobId))`,
    );
    try {
      db.run(
        `INSERT INTO gatewayVideoJobs VALUES(?, 'job-1', 'openai', 'gone-conn', 'openai/gpt-4o', ?)`,
        [WS, NOW],
      );
      const before = tableDump();
      await expect(
        dbApi.importDb(
          { apiKeys: [{ id: "legacy-9", key: RAW_L, isActive: true, createdAt: NOW }] },
          { masterKey: MASTER },
        ),
      ).rejects.toThrow(transferError("TRANSFER_REF_INVALID"));
      expect(tableDump()).toBe(before);
      expect(one(`SELECT COUNT(*) AS n FROM gatewayVideoJobs`).n).toBe(1);
    } finally {
      db.exec(`DROP TABLE gatewayVideoJobs`);
    }
  });

  it("fails preflight on malformed references before any mutation", async () => {
    const snapshot = await dbApi.exportDb();
    snapshot.apiKeys[0].workspaceId = "ghost-ws";
    const before = tableDump();
    await expect(dbApi.importDb(snapshot, { masterKey: MASTER })).rejects.toThrow(
      transferError("TRANSFER_REF_INVALID"),
    );
    expect(tableDump()).toBe(before);

    snapshot.apiKeys[0].workspaceId = WS;
    snapshot.memberships.push({ workspaceId: WS, userId: "ghost", role: "member", createdAt: NOW });
    await expect(dbApi.importDb(snapshot, { masterKey: MASTER })).rejects.toThrow(
      transferError("TRANSFER_REF_INVALID"),
    );
    expect(tableDump()).toBe(before);
  });

  it("fails preflight on raw leaks in key rows and presets", async () => {
    const snapshot = await dbApi.exportDb();
    const before = tableDump();
    snapshot.apiKeys[0].key = RAW_H;
    await expect(dbApi.importDb(snapshot, { masterKey: MASTER })).rejects.toThrow(
      transferError("TRANSFER_RAW_LEAK"),
    );
    expect(tableDump()).toBe(before);

    delete snapshot.apiKeys[0].key;
    snapshot.cliToolPresets.apiKeys.push({ name: "Evil", key: RAW_H });
    await expect(dbApi.importDb(snapshot, { masterKey: MASTER })).rejects.toThrow(
      transferError("TRANSFER_RAW_LEAK"),
    );
    expect(tableDump()).toBe(before);
  });

  it("rolls back job replacement when a later write fails", async () => {
    db.exec(
      `CREATE TABLE gatewayVideoJobs(workspaceId TEXT NOT NULL, jobId TEXT NOT NULL, provider TEXT NOT NULL, connectionId TEXT NOT NULL, modelId TEXT NOT NULL, createdAt TEXT NOT NULL, PRIMARY KEY (workspaceId, provider, jobId))`,
    );
    try {
      db.run(
        `INSERT INTO gatewayVideoJobs VALUES(?, 'job-1', 'openai', 'conn-1', 'openai/gpt-4o', ?)`,
        [WS, NOW],
      );
      const snapshot = await dbApi.exportDb();
      snapshot.combos = [{ id: "blocked", name: "Blocked", models: [] }];
      const frozen = tableDump();
      db.exec(
        `CREATE TRIGGER block_apply BEFORE INSERT ON combos BEGIN SELECT RAISE(ABORT, 'apply blocked'); END`,
      );
      try {
        await expect(dbApi.importDb(snapshot, { masterKey: MASTER })).rejects.toThrow(
          "apply blocked",
        );
        expect(tableDump()).toBe(frozen);
      } finally {
        db.exec(`DROP TRIGGER block_apply`);
      }
    } finally {
      db.exec(`DROP TABLE gatewayVideoJobs`);
    }
  });
});

// YAN-700: the hashed apply lane must replace the same scope as legacy imports.
it("hashed snapshots round-trip disabled models and clear missing legacy sections", async () => {
  seedHashedInstance();
  db.run("DELETE FROM kv WHERE scope = 'disabledModels'");
  await dbApi.disableModelsUnscoped("openai", ["gpt-4o"]);
  const snapshot = await dbApi.exportDb();
  expect(snapshot.disabledModels).toEqual({ openai: ["gpt-4o"] });
  await dbApi.disableModelsUnscoped("stale", ["old"]);
  await dbApi.importDb(snapshot, { masterKey: MASTER });
  expect(await dbApi.getDisabledModelsUnscoped()).toEqual(snapshot.disabledModels);
  delete snapshot.disabledModels;
  // Simulate an older hashed snapshot: no full raw-KV section either.
  delete snapshot.kv;
  await dbApi.importDb(snapshot, { masterKey: MASTER });
  expect(await dbApi.getDisabledModelsUnscoped()).toEqual({});
});

describe("legacy snapshot into hashed instance (compatibility import)", () => {
  beforeEach(seedHashedInstance);

  const legacyPayload = () => ({
    apiKeys: [
      { id: "legacy-1", key: RAW_L, name: "Legacy runner", isActive: true, createdAt: NOW },
      {
        id: "legacy-2",
        key: "th_SECONDPLAINTEXTTOKENxxxxxxxxxxxxxx",
        isActive: false,
        createdAt: NOW,
      },
    ],
    cliToolPresets: { apiKeys: [{ name: "CI", key: RAW_L, extra: "kept" }] },
    providerConnections: [
      {
        id: "conn-legacy",
        provider: "openai",
        authType: "api_key",
        name: "Imported",
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  });

  it("hashes keys into Default, converts presets, never stores plaintext", async () => {
    await dbApi.importDb(legacyPayload(), { masterKey: MASTER });

    const row = one(`SELECT * FROM apiKeys WHERE id = 'legacy-1'`);
    expect(row).toMatchObject({
      workspaceId: WS,
      keyHash: digest(RAW_L),
      hashKid: KID,
      prefix: apiKeyPrefix(RAW_L),
      legacy: 1,
      isActive: 1,
    });
    expect(one(`SELECT isActive FROM apiKeys WHERE id = 'legacy-2'`).isActive).toBe(0);
    expect(one(`SELECT COUNT(*) AS n FROM apiKeys WHERE id = 'hk-1'`).n).toBe(0);
    const dump = tableDump();
    expect(dump).not.toContain(RAW_L);
    expect(dump).not.toContain("th_SECONDPLAINTEXTTOKENxxxxxxxxxxxxxx");
    expect(
      JSON.parse(
        one(`SELECT value FROM kv WHERE scope = 'cliToolPresets' AND key = 'apiKeys'`).value,
      ),
    ).toEqual([{ name: "CI", apiKeyId: "legacy-1", extra: "kept" }]);
    expect(
      one(`SELECT workspaceId, createdByUserId FROM providerConnections WHERE id = 'conn-legacy'`),
    ).toMatchObject({ workspaceId: WS, createdByUserId: "owner" });
    expect(readApiKeyStorageState(db)).toEqual({ storage: "hashed", version: 1, hashKid: KID });
    const { getEligibleApiKeySync } = await import("@/lib/db/repos/apiKeysRepo.js");
    expect(
      getEligibleApiKeySync(db, "legacy-1", { keyHash: digest(RAW_L), now: NOW }),
    ).toMatchObject({ id: "legacy-1" });
    expect(clearApiKeyPrincipalCache).toHaveBeenCalled();
  });

  it("wrong master fails preflight with zero mutation", async () => {
    const before = tableDump();
    await expect(dbApi.importDb(legacyPayload(), { masterKey: OTHER_MASTER })).rejects.toThrow(
      transferError("TRANSFER_ROOT_MISMATCH"),
    );
    expect(tableDump()).toBe(before);
  });

  it("ambiguous preset stops before mutation without leaking the raw", async () => {
    const payload = legacyPayload();
    payload.cliToolPresets.apiKeys.push({ name: "Vendor", key: "sk-external-credential-01" });
    const before = tableDump();
    const attempt = dbApi.importDb(payload, { masterKey: MASTER });
    await expect(attempt).rejects.toThrow(transferError("TRANSFER_AMBIGUOUS_PRESET"));
    await expect(attempt).rejects.toThrow(/Vendor/);
    await expect(attempt).rejects.not.toThrow(/sk-external-credential-01/);
    expect(tableDump()).toBe(before);
  });

  it("rejects malformed legacy rows before mutation", async () => {
    const before = tableDump();
    const payload = legacyPayload();
    payload.apiKeys[1].key = ""; // missing raw key
    await expect(dbApi.importDb(payload, { masterKey: MASTER })).rejects.toThrow(
      transferError("TRANSFER_STATE_INVALID"),
    );
    const dup = legacyPayload();
    dup.apiKeys[1].key = RAW_L; // duplicate raw
    await expect(dbApi.importDb(dup, { masterKey: MASTER })).rejects.toThrow(
      transferError("TRANSFER_STATE_INVALID"),
    );
    expect(tableDump()).toBe(before);
  });
});

// ─── YAN-365 (task 2.4, T lane): format v3 encrypted transfer (C9) ───────────
// Authored red in B2; O turns green in B5. v3 exports raw ciphertext + wraps
// (never decrypting repos); same-root restore is exact; wrong root / plaintext
// / malformed graphs reject with zero mutation and NO backup dir (D8).
describe("encrypted instance transfer (format v3, YAN-365)", () => {
  const FIXED_WS = "ws-default";
  const SENT = "sk-sent-transfer-3601";
  const loadActivate = () => import("../../src/lib/db/activateCredentialEncryption.js");

  async function encryptedInstance() {
    // Instance isolation: this file shares one adapter across describes, so
    // any leftover credential marker/DEK rows from an earlier v3 test would
    // make seedHashedInstance's plaintext rows live under established
    // encryption (PLAINTEXT_REJECTED on the activation pass).
    db.exec(`DELETE FROM workspaceKeys; DELETE FROM _meta WHERE key IN
      ('credentialsEncryptedVersion','credentialsKekKid','apiKeyHashKeyWrapped','credentialsCleanupPending','credentialsPendingRotation')`);
    seedHashedInstance();
    db.run(`UPDATE providerConnections SET data = ? WHERE id = 'conn-1'`, [
      JSON.stringify({ accessToken: SENT }),
    ]);
    const { activateCredentialEncryption } = await loadActivate();
    await activateCredentialEncryption(db, {
      enabled: true,
      beforeServing: true,
      root: { kid: KID, key: MASTER },
    });
  }

  const backupDirsExist = async () => {
    const fsmod = await import("node:fs");
    const { BACKUPS_DIR } = await import("../../src/lib/db/paths.js");
    return fsmod.existsSync(BACKUPS_DIR)
      ? fsmod.readdirSync(BACKUPS_DIR).filter((n) => n.startsWith("pre-import-"))
      : [];
  };

  it("exports v3 raw ciphertext + wraps + marker; no plaintext sentinel, no master material", async () => {
    await encryptedInstance();
    const snapshot = await dbApi.exportDb();
    expect(snapshot.formatVersion).toBe(3);
    expect(snapshot.credentialEncryption).toMatchObject({ version: 1, kekKid: KID });
    expect(typeof snapshot.credentialEncryption.apiKeyHashKeyWrapped).toBe("string");
    expect(Array.isArray(snapshot.workspaceKeys)).toBe(true);
    expect(snapshot.workspaceKeys.map((r) => r.workspaceId)).toContain(FIXED_WS);
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain(SENT);
    expect(text).not.toContain(MASTER.toString("base64"));
    expect(text).not.toContain(MASTER.toString("hex"));
  });

  it("same-root roundtrip restores exact IDs, envelope bytes, DEK wraps and key hashes", async () => {
    await encryptedInstance();
    const snapshot = await dbApi.exportDb();
    const beforeConn = one(`SELECT data FROM providerConnections WHERE id = 'conn-1'`).data;
    const beforeKeys = all(`SELECT * FROM workspaceKeys ORDER BY workspaceId`);
    const beforeHash = one(`SELECT keyHash, hashKid FROM apiKeys WHERE id = 'hk-1'`);
    db.run(`UPDATE providerConnections SET data = '{}' WHERE id = 'conn-1'`);
    await dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER });
    expect(one(`SELECT data FROM providerConnections WHERE id = 'conn-1'`).data).toBe(beforeConn);
    expect(all(`SELECT * FROM workspaceKeys ORDER BY workspaceId`)).toEqual(beforeKeys);
    expect(one(`SELECT keyHash, hashKid FROM apiKeys WHERE id = 'hk-1'`)).toEqual(beforeHash);
  });

  it("post-KEK-rotation v3 export restores under the rotated root (hash proof via unwrap)", async () => {
    await encryptedInstance();
    const NEW_MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 23 + 9) % 256));
    const { rotateKek } = await import("../../src/lib/security/keyRotation.js");
    // Explicit-root path (no key file in the isolated fixture): same rotation
    // transaction, publication left to the caller.
    await rotateKek(db, {
      newRoot: { kid: masterKeyId(NEW_MASTER), key: NEW_MASTER },
      root: { kid: KID, key: MASTER },
      fileManaged: false,
    });
    const snapshot = await dbApi.exportDb();
    expect(snapshot.credentialEncryption.kekKid).toBe(masterKeyId(NEW_MASTER));
    // Hash identity stays frozen at the original kid (D6), root identity moved.
    expect(one(`SELECT hashKid FROM apiKeys WHERE id = 'hk-1'`).hashKid).toBe(KID);
    await dbApi.importDb(structuredClone(snapshot), { masterKey: NEW_MASTER });
    expect(one(`SELECT hashKid FROM apiKeys WHERE id = 'hk-1'`).hashKid).toBe(KID);
  });

  it("wrong root rejects before backup/wipe: zero mutation and no pre-import dir", async () => {
    await encryptedInstance();
    const snapshot = await dbApi.exportDb();
    const before = tableDump();
    const dirsBefore = await backupDirsExist();
    await expect(
      dbApi.importDb(structuredClone(snapshot), { masterKey: OTHER_MASTER }),
    ).rejects.toThrow(transferError("TRANSFER_ROOT_MISMATCH"));
    expect(tableDump()).toBe(before);
    expect(await backupDirsExist()).toEqual(dirsBefore);
  });

  it("legacy v1/v2 plaintext payload on an encrypted instance rejects with zero mutation and no backup", async () => {
    await encryptedInstance();
    const before = tableDump();
    const dirsBefore = await backupDirsExist();
    await expect(
      dbApi.importDb(
        { apiKeys: [{ id: "l1", key: RAW_L, isActive: true, createdAt: NOW }] },
        { masterKey: MASTER },
      ),
    ).rejects.toThrow(expect.objectContaining({ code: expect.stringMatching(/^TRANSFER_/) }));
    expect(tableDump()).toBe(before);
    expect(await backupDirsExist()).toEqual(dirsBefore);
  });

  it("malformed v3 graph (orphan DEK, tampered envelope, duplicate key row) rejects before mutation/backup", async () => {
    await encryptedInstance();
    const good = await dbApi.exportDb();
    const before = tableDump();
    const dirsBefore = await backupDirsExist();

    const orphan = structuredClone(good);
    orphan.workspaceKeys.push({
      workspaceId: "ws-ghost",
      kid: "dk_0123456789abcdef",
      wrappedDek: "{}",
      createdAt: NOW,
    });
    await expect(dbApi.importDb(orphan, { masterKey: MASTER })).rejects.toThrow(
      expect.objectContaining({ code: expect.stringMatching(/^TRANSFER_/) }),
    );

    const dup = structuredClone(good);
    dup.workspaceKeys.push({ ...dup.workspaceKeys[0] });
    await expect(dbApi.importDb(dup, { masterKey: MASTER })).rejects.toThrow(
      expect.objectContaining({ code: expect.stringMatching(/^TRANSFER_/) }),
    );

    const tampered = structuredClone(good);
    tampered.providerConnections[0].data = JSON.stringify({
      accessToken: {
        v: 1,
        kid: "dk_0123456789abcdef",
        iv: "AAAAAAAAAAAAAAAA",
        ct: "AAAA",
        tag: "AAAAAAAAAAAAAAAAAAAAAA==",
      },
    });
    await expect(dbApi.importDb(tampered, { masterKey: MASTER })).rejects.toThrow(
      expect.objectContaining({ code: expect.stringMatching(/^TRANSFER_/) }),
    );

    expect(tableDump()).toBe(before);
    expect(await backupDirsExist()).toEqual(dirsBefore);
  });

  it("v3 restore cannot activate encryption on a never-enabled instance", async () => {
    await encryptedInstance();
    const snapshot = await dbApi.exportDb();
    // Reset to a never-enabled hashed instance: strip marker, wraps, envelopes.
    db.exec(`DELETE FROM workspaceKeys; DELETE FROM _meta WHERE key IN
      ('credentialsEncryptedVersion','credentialsKekKid','apiKeyHashKeyWrapped','credentialsCleanupPending')`);
    db.run(`UPDATE providerConnections SET data = '{}'`);
    const before = tableDump();
    await expect(dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER })).rejects.toThrow(
      expect.objectContaining({ code: expect.stringMatching(/^TRANSFER_/) }),
    );
    expect(tableDump()).toBe(before);
  });

  it("v2 unencrypted semantics stay unchanged for never-enabled instances", async () => {
    seedHashedInstance();
    const snapshot = await dbApi.exportDb();
    expect(snapshot.formatVersion).toBe(2);
    expect(snapshot.credentialEncryption).toBeUndefined();
    expect(snapshot.workspaceKeys).toBeUndefined();
  });

  it("plaintext restore bypass: v1/v2 payloads smuggling a credentialEncryption section reject with zero mutation and no backup", async () => {
    await encryptedInstance();
    const before = tableDump();
    const dirsBefore = await backupDirsExist();
    const plain = { apiKeys: [{ id: "l1", key: RAW_L, isActive: true, createdAt: NOW }] };
    const smuggles = [
      { ...plain, formatVersion: 1, credentialEncryption: {} },
      { ...plain, formatVersion: 1, credentialEncryption: null },
      { ...plain, credentialEncryption: {} }, // formatVersion omitted ⇒ 1
      { ...plain, formatVersion: 2, credentialEncryption: {} },
    ];
    for (const payload of smuggles) {
      await expect(dbApi.importDb(structuredClone(payload), { masterKey: MASTER })).rejects.toThrow(
        expect.objectContaining({ code: expect.stringMatching(/^TRANSFER_/) }),
      );
      expect(tableDump()).toBe(before);
      expect(await backupDirsExist()).toEqual(dirsBefore);
    }
    // The stored credential marker is untouched (encryption not stripped).
    expect(one(`SELECT value FROM _meta WHERE key = 'credentialsEncryptedVersion'`).value).toBe(
      "1",
    );
  });

  it("preflight itself rejects a v1 payload that carries credentialEncryption/workspaceKeys", async () => {
    const { preflightGatewayKeyImport } = await import("@/lib/db/helpers/gatewayKeyTransfer.js");
    seedHashedInstance();
    const { gatewayKeyStorageSnapshot } = await import("@/lib/db/helpers/gatewayKeyTransfer.js");
    const instance = gatewayKeyStorageSnapshot(db);
    for (const extra of [
      { credentialEncryption: {} },
      { credentialEncryption: null },
      { workspaceKeys: [] },
    ]) {
      expect(() =>
        preflightGatewayKeyImport(
          { formatVersion: 1, apiKeys: [], ...extra },
          { instance, db, masterKey: MASTER },
        ),
      ).toThrow(expect.objectContaining({ code: "TRANSFER_STATE_INVALID" }));
    }
  });

  it("credential state changing between preflight and apply aborts TRANSFER_STATE_CHANGED with zero mutation", async () => {
    await encryptedInstance();
    const snapshot = await dbApi.exportDb();
    snapshot.apiKeys[0].name = "Must not land";
    const before = tableDump();
    const realKid = one(`SELECT value FROM _meta WHERE key = 'credentialsKekKid'`).value;
    // A rotation commits in the async window between preflight and the
    // destructive transaction. The import's outer transaction call is the
    // first statement after the backup+verify step, so flip the live KEK kid
    // exactly there — after everything was proven, before anything is written.
    const realTx = db.transaction.bind(db);
    let flipped = false;
    db.transaction = (fn) => {
      if (!flipped) {
        flipped = true;
        realTx(() => {
          db.run(`UPDATE _meta SET value = ? WHERE key = 'credentialsKekKid'`, ["f".repeat(16)]);
        });
      }
      return realTx(fn);
    };
    try {
      await expect(
        dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER }),
      ).rejects.toThrow(expect.objectContaining({ code: "TRANSFER_STATE_CHANGED" }));
    } finally {
      db.transaction = realTx;
      db.run(`UPDATE _meta SET value = ? WHERE key = 'credentialsKekKid'`, [realKid]);
    }
    expect(flipped).toBe(true);
    expect(one(`SELECT name FROM apiKeys WHERE id = 'hk-1'`).name).not.toBe("Must not land");
    expect(tableDump()).toBe(before);
  });
});

// ─── B5: durability proof before success; poison on uncertain persistence ──
// These two MUST run LAST in this file: the injected flush failure poisons
// the shared adapter terminally (no un-poison until restart) by design.
describe("import durability gate (YAN-365 B5)", () => {
  // Earlier v3 describes leave established encryption on the shared adapter;
  // these durability cases exercise plain hashed storage.
  beforeEach(() => {
    db.exec(`DELETE FROM workspaceKeys; DELETE FROM _meta WHERE key IN
      ('credentialsEncryptedVersion','credentialsKekKid','apiKeyHashKeyWrapped','credentialsCleanupPending','credentialsPendingRotation')`);
  });

  it("native adapters prove durability via checked FULL checkpoint, not flushSync", async () => {
    seedHashedInstance();
    const snapshot = await dbApi.exportDb();
    snapshot.apiKeys[0].name = "Durable import";
    expect(db.driver === "sql.js" ? typeof db.flushSync === "function" : !("flushSync" in db)).toBe(
      true,
    );
    const result = await dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER });
    expect(result.apiKeys[0].name).toBe("Durable import");
    expect(one(`SELECT name FROM apiKeys WHERE id = 'hk-1'`).name).toBe("Durable import");
  });

  it("injected persistence failure rejects, poisons terminally, never reports success", async () => {
    seedHashedInstance();
    const snapshot = await dbApi.exportDb();
    snapshot.apiKeys[0].name = "Uncertain commit";
    if (db.driver === "sql.js") {
      const real = db.flushSync;
      db.flushSync = () => {
        throw new Error("disk full");
      };
      try {
        await expect(
          dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER }),
        ).rejects.toThrow("disk full");
      } finally {
        db.flushSync = real;
      }
    } else {
      // Native commit path: checked FULL checkpoint reports busy → the commit
      // is unproven. (Blanket fs sabotage would also break the pre-import
      // backup, which is NOT the step under test.)
      const real = db.get;
      let seenFlushProbe = false;
      db.get = (sql, ...rest) => {
        if (typeof sql === "string" && sql.includes("wal_checkpoint")) {
          seenFlushProbe = true;
          return { busy: 1, log: 0, checkpointed: 0 }; // unproven durability
        }
        return real.call(db, sql, ...rest);
      };
      try {
        await expect(
          dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER }),
        ).rejects.toMatchObject({ code: "IMPORT_FLUSH_FAILED" });
      } finally {
        db.get = real;
      }
      expect(seenFlushProbe).toBe(true);
    }
    // The commit DID happen in memory/WAL (never claimed rolled back)...
    expect(one(`SELECT name FROM apiKeys WHERE id = 'hk-1'`).name).toBe("Uncertain commit");
    // ...but the adapter is terminally poisoned: no credential use, no raw writes,
    // and no success was returned for the import.
    const maint = await import("../../src/lib/db/credentialMaintenance.js");
    expect(maint.isCredentialMaintenancePoisoned(db)).toBe(true);
    expect(() =>
      db.run(
        `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES('poison-x','x',NULL,'[]',?,?)`,
        [NOW, NOW],
      ),
    ).toThrow(expect.objectContaining({ code: "CREDENTIAL_MAINTENANCE_POISONED" }));
    expect(() => maint.assertCredentialOperationAllowed(db)).toThrow(
      expect.objectContaining({ code: "CREDENTIAL_MAINTENANCE_POISONED" }),
    );
    // No success was returned: exportDb (the success payload) never ran for
    // the failed import — the only observable exit was the rejection above.
    expect(maint.isCredentialMaintenancePoisoned(db)).toBe(true);
  });
});
