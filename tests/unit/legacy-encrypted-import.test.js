import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import * as dbApi from "@/lib/db/index.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { apiKeyPrefix } from "@/shared/utils/apiKey.js";
import { assertIsolatedHome } from "../helpers/isolatedHome.js";
vi.mock("@/lib/auth/apiKeyPrincipal.js", () => ({ clearApiKeyPrincipalCache: vi.fn() }));
const multiUserState = vi.hoisted(() => ({ on: true }));
vi.mock("@/lib/users/featureSwitch.js", async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, isMultiUserEnabled: async () => multiUserState.on };
});
const NOW = "2026-10-09T00:00:00.000Z";
const MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));
const OTHER_MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 11 + 5) % 256));
const KID = masterKeyId(MASTER);
const OTHER_KID = masterKeyId(OTHER_MASTER);
const HASH_KEY = deriveApiKeyHashKey(MASTER);
const WS = "ws-default";
const WS2 = "ws-other";
const RAW_H = "th_HASHEDGATEWAYTOKENxxxxxxxxxxxxxxx";
const digest = (raw, key = HASH_KEY) => hashApiKey(raw, key);
const transferError = (code) => expect.objectContaining({ code });

let db;
function rebuildApiKeysHashed() {
  db.exec(`DROP TABLE IF EXISTS apiKeys`);
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    userId TEXT REFERENCES users(id) ON DELETE CASCADE,
    createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
    keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
    machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
    revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
    expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
}

function seedHashedInstanceFull() {
  db.exec(`DELETE FROM usageRollup`);
  db.exec(`DELETE FROM requestDetails`);
  db.exec(`DELETE FROM usageHistory`);
  db.exec(`DELETE FROM auditEvents`);
  db.exec(`DELETE FROM invitations`);
  db.exec(`DELETE FROM budgets`);
  db.exec(`DELETE FROM connectionGrants`);
  db.exec(`DELETE FROM userPreferences`);
  db.exec(`DELETE FROM workspaceSettings`);
  db.exec(`DELETE FROM providerNodes`);
  db.exec(`DELETE FROM providerConnections`);
  rebuildApiKeysHashed();
  db.exec(
    `DELETE FROM memberships; DELETE FROM identities; DELETE FROM workspaces; DELETE FROM users;
     DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid','defaultWorkspaceId')`,
  );
  for (const id of ["owner", "member1"]) {
    db.run(
      `INSERT INTO users(id, email, username, displayName, instanceRole, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt, lastLoginAt)
       VALUES(?, ?, ?, ?, ?, 'active', ?, 0, 1, ?, ?, NULL)`,
      [id, `${id}@x.test`, id, id, id === "owner" ? "owner" : "user", "hashedsecret", NOW, NOW],
    );
  }
  for (const [id, kind, by] of [
    [WS, "shared", "owner"],
    [WS2, "shared", "owner"],
  ]) {
    db.run(
      `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES(?,?,?,?,?,?)`,
      [id, id, kind, by, NOW, NOW],
    );
    db.run(
      `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?,?,?,?,?)`,
      [id, "owner", "owner", "manual", NOW],
    );
  }
  db.run(
    `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?, 'member1', 'member', 'manual', ?)`,
    [WS, NOW],
  );
  for (const ws of [WS, WS2]) {
    db.run(`INSERT INTO workspaceSettings(workspaceId, data, updatedAt) VALUES(?, ?, ?)`, [
      ws,
      JSON.stringify({ themeOverride: ws }),
      NOW,
    ]);
  }
  for (const user of ["owner", "member1"]) {
    db.run(`INSERT INTO userPreferences(userId, data, updatedAt) VALUES(?, ?, ?)`, [
      user,
      JSON.stringify({ theme: "dark" }),
      NOW,
    ]);
  }
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, workspaceId, createdByUserId)
     VALUES('conn-1', 'openai', 'api_key', 'Main', NULL, 1, 1, ?, ?, ?, ?, 'owner')`,
    [JSON.stringify({ accessToken: "sk-upstream-cred" }), NOW, NOW, WS],
  );
  db.run(
    `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt, workspaceId, createdByUserId)
     VALUES('node-1', 'relay', 'N1', ?, ?, ?, ?, 'owner')`,
    [JSON.stringify({}), NOW, NOW, WS],
  );
  db.run(
    `INSERT INTO connectionGrants(id, connectionId, workspaceId, userId, allowedModels, rpm, tpm, budgetId, createdByUserId, tosAcknowledgedAt, createdAt, revokedAt)
     VALUES('grant-1', 'conn-1', ?, NULL, ?, 60, 1000, NULL, 'owner', NULL, ?, NULL)`,
    [WS2, JSON.stringify(["gpt-4o"]), Date.parse(NOW)],
  );
  db.run(
    `INSERT INTO budgets(id, workspaceId, scopeType, scopeId, window, limitUsd, limitTokens, limitRequests, softLimitPct, resetAt, createdByUserId, createdAt)
     VALUES('budget-ws', ?, 'workspace', ?, 'day', 10, NULL, NULL, NULL, NULL, 'owner', ?)`,
    [WS, WS, NOW],
  );
  db.run(
    `INSERT INTO budgets(id, workspaceId, scopeType, scopeId, window, limitUsd, limitTokens, limitRequests, softLimitPct, resetAt, createdByUserId, createdAt)
     VALUES('budget-user', NULL, 'user', 'owner', 'month', 5, NULL, NULL, 80, NULL, 'owner', ?)`,
    [NOW],
  );
  db.run(
    `INSERT INTO budgets(id, workspaceId, scopeType, scopeId, window, limitUsd, limitTokens, limitRequests, softLimitPct, resetAt, createdByUserId, createdAt)
     VALUES('budget-grant', ?, 'grant', 'grant-1', 'day', NULL, 1000, NULL, NULL, NULL, 'owner', ?)`,
    [WS, NOW],
  );
  db.run(
    `INSERT INTO auditEvents(id, ts, actorUserId, actorApiKeyId, via, ip, workspaceId, action, targetType, targetId, before, after, result)
     VALUES('audit-1', ?, 'owner', NULL, 'ui', '127.0.0.1', ?, 'workspace.create', 'workspace', ?, NULL, ?, 'ok')`,
    [NOW, WS, WS2, JSON.stringify({ name: WS2 })],
  );
  db.run(
    `INSERT INTO invitations(id, workspaceId, role, email, tokenHash, createdByUserId, createdAt, expiresAt, consumedAt, consumedByUserId, revokedAt)
     VALUES('invite-1', ?, 'member', ?, ?, 'owner', ?, ?, NULL, NULL, NULL)`,
    [WS, "guest@x.test", "0".repeat(64), NOW, NOW],
  );
  db.run(
    `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, workspaceId, userId, apiKeyId, grantId)
     VALUES(?, 'openai', 'gpt-4o', 'conn-1', NULL, '/v1/chat', 10, 20, 0.01, 'ok', ?, ?, ?, 'owner', 'hk-1', 'grant-1')`,
    [NOW, JSON.stringify({}), JSON.stringify({}), WS],
  );
  db.run(
    `INSERT INTO usageRollup(dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint, requests, tokensIn, tokensOut, tokensCached, cost)
     VALUES('2026-10-09', ?, 'owner', 'hk-1', 'openai', 'gpt-4o', 'conn-1', '/v1/chat', 1, 10, 20, 0, 0.01)`,
    [WS],
  );
  db.run(
    `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data, workspaceId, userId, apiKeyId, grantId)
     VALUES('rd-1', ?, 'openai', 'gpt-4o', 'conn-1', 'ok', ?, ?, 'owner', 'hk-1', 'grant-1')`,
    [NOW, JSON.stringify({ model: "gpt-4o" }), WS],
  );
  db.run(
    `INSERT INTO apiKeys(id, workspaceId, userId, createdByUserId, keyHash, hashKid, prefix, name, machineId, legacy, isActive, allowedModels, createdAt)
     VALUES('hk-1', ?, 'member1', 'owner', ?, ?, ?, 'Runner', NULL, 0, 1, ?, ?)`,
    [WS, digest(RAW_H), KID, apiKeyPrefix(RAW_H), JSON.stringify(["gpt-4o"]), NOW],
  );
  db.run(
    `INSERT INTO _meta(key, value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?), ('defaultWorkspaceId',?)`,
    [KID, WS],
  );
}

async function encryptedSeed() {
  seedHashedInstanceFull();
  const { activateCredentialEncryption } = await import(
    "../../src/lib/db/activateCredentialEncryption.js"
  );
  await activateCredentialEncryption(db, {
    enabled: true,
    beforeServing: true,
    root: { kid: KID, key: MASTER },
  });
}

const legacyPayload = () => ({
  settings: { oidcClientSecret: "legacy-oidc-secret" },
  providerConnections: [
    { id: "legacy-conn", provider: "openai", apiKey: "legacy-provider-secret" },
  ],
  providerNodes: [{ id: "legacy-node", name: "Legacy", apiKey: "legacy-node-secret" }],
  apiKeys: [{ id: "legacy-key", key: "legacy-client-key" }],
  combos: [{ id: "legacy-combo", name: "Legacy", models: [] }],
});

const dump = (sql) => db.all(sql);
const snapshotDb = () =>
  JSON.stringify({
    settings: dump("SELECT * FROM settings ORDER BY id"),
    connections: dump("SELECT * FROM providerConnections ORDER BY id"),
    nodes: dump("SELECT * FROM providerNodes ORDER BY id"),
    pools: dump("SELECT * FROM proxyPools ORDER BY id"),
    keys: dump("SELECT * FROM apiKeys ORDER BY id"),
    combos: dump("SELECT * FROM combos ORDER BY id"),
    kv: dump("SELECT scope, key, value FROM kv ORDER BY scope, key"),
    users: dump("SELECT * FROM users ORDER BY id"),
    identities: dump("SELECT * FROM identities ORDER BY id"),
    workspaces: dump("SELECT * FROM workspaces ORDER BY id"),
    memberships: dump("SELECT * FROM memberships ORDER BY workspaceId, userId"),
    meta: dump("SELECT key, value FROM _meta ORDER BY key"),
  });

beforeEach(async () => {
  db = await getAdapter();
  db.exec("DROP TABLE IF EXISTS gatewayVideoJobs");
  db.exec("DROP TRIGGER IF EXISTS legacy_import_fail");
  db.exec(`DELETE FROM workspaceKeys; DELETE FROM _meta WHERE key IN
    ('credentialsEncryptedVersion','credentialsKekKid','apiKeyHashKeyWrapped','credentialsCleanupPending','credentialsPendingRotation')`);
  db.exec(`DELETE FROM settings; DELETE FROM combos; DELETE FROM proxyPools`);
  db.exec(
    `DELETE FROM kv WHERE scope IN ('modelAliases', 'disabledModels', 'customModels', 'mitmAlias', 'cliToolSettings', 'cliToolPresets', 'pricing')`,
  );
  vi.clearAllMocks();
  multiUserState.on = true;
  await encryptedSeed();
});

afterEach(() => {
  assertIsolatedHome();
  const keysDir = path.join(process.env.DATA_DIR, "keys");
  fs.rmSync(keysDir, { recursive: true, force: true });
  assertIsolatedHome();
});
describe("legacy import on encrypted destination", () => {
  it("rejects a wrong master with zero mutation", async () => {
    const before = snapshotDb();
    await expect(dbApi.importDb(legacyPayload(), { masterKey: OTHER_MASTER })).rejects.toThrow(
      transferError("TRANSFER_ROOT_MISMATCH"),
    );
    expect(snapshotDb()).toBe(before);
  });

  it("rejects a legacy payload while the switch is off with zero mutation", async () => {
    multiUserState.on = false;
    const before = snapshotDb();
    await expect(dbApi.importDb(legacyPayload(), { masterKey: MASTER })).rejects.toThrow(
      transferError("TRANSFER_FORMAT_INVALID"),
    );
    expect(snapshotDb()).toBe(before);
  });

  it("refuses while a rotation is pending with zero mutation", async () => {
    const row = db.get(`SELECT value FROM _meta WHERE key = 'credentialsPendingRotation'`);
    db.run(`INSERT INTO _meta(key, value) VALUES('credentialsPendingRotation', ?)`, [
      JSON.stringify({ oldKid: OTHER_KID, newKid: KID }),
    ]);
    try {
      const before = snapshotDb();
      await expect(dbApi.importDb(legacyPayload(), { masterKey: MASTER })).rejects.toThrow(
        transferError("TRANSFER_ROTATION_IN_FLIGHT"),
      );
      expect(snapshotDb()).toBe(before);
    } finally {
      if (row === undefined) db.run(`DELETE FROM _meta WHERE key = 'credentialsPendingRotation'`);
      else
        db.run(`UPDATE _meta SET value = ? WHERE key = 'credentialsPendingRotation'`, [row.value]);
    }
  });

  it("fails closed on a corrupt marker with zero mutation", async () => {
    const row = db.get(`SELECT value FROM _meta WHERE key = 'credentialsKekKid'`);
    db.run(`UPDATE _meta SET value = 'bogus' WHERE key = 'credentialsKekKid'`);
    try {
      const before = snapshotDb();
      await expect(dbApi.importDb(legacyPayload(), { masterKey: MASTER })).rejects.toThrow(
        transferError("TRANSFER_FORMAT_INVALID"),
      );
      expect(snapshotDb()).toBe(before);
    } finally {
      db.run(`UPDATE _meta SET value = ? WHERE key = 'credentialsKekKid'`, [row.value]);
    }
  });

  it("rolls back the wipe when a late write fails", async () => {
    const before = snapshotDb();
    db.exec(
      `CREATE TEMP TRIGGER legacy_import_fail BEFORE INSERT ON providerConnections
       BEGIN SELECT RAISE(ABORT, 'late-boom'); END`,
    );
    try {
      await expect(dbApi.importDb(legacyPayload(), { masterKey: MASTER })).rejects.toThrow(
        /late-boom/,
      );
      expect(snapshotDb()).toBe(before);
    } finally {
      db.exec("DROP TRIGGER IF EXISTS legacy_import_fail");
    }
  });

  it("imports a legacy snapshot into encrypted Default without writing plaintext", async () => {
    const beforeUsers = db.all("SELECT * FROM users ORDER BY id");
    const payload = legacyPayload();
    await dbApi.importDb(payload, { masterKey: MASTER });
    expect(db.all("SELECT * FROM users ORDER BY id")).toEqual(beforeUsers);
    const stored = db.get("SELECT * FROM providerConnections WHERE id = 'legacy-conn'");
    expect(stored.workspaceId).toBe(WS);
    expect(stored.data).not.toContain("legacy-provider-secret");
    expect(db.get("SELECT data FROM settings WHERE id = 1").data).not.toContain(
      "legacy-oidc-secret",
    );
    const { decodeCredentialRowSync, prepareCredentialContext } = await import(
      "@/lib/db/helpers/credentialStorage.js"
    );
    const ctx = prepareCredentialContext(db, { kid: KID, key: MASTER });
    expect(
      decodeCredentialRowSync(db, stored, ctx, { table: "providerConnections", mode: "runtime" })
        .apiKey,
    ).toBe("legacy-provider-secret");
    expect(db.get("SELECT keyHash FROM apiKeys WHERE id = 'legacy-key'").keyHash).toBe(
      digest("legacy-client-key"),
    );
    expect(db.get("SELECT workspaceId FROM combos WHERE id = 'legacy-combo'").workspaceId).toBe(WS);
  });
});
