// Shared seeding/dump helpers for the instance-transfer-stream tests (YAN-1013).
// vi.mock calls must stay at the top of each test file; they are not here.
// Call setFixtureDb(adapter) from each file's beforeEach before using DB helpers.
import fs from "node:fs";
import { Readable } from "node:stream";
import { STAGING_DIR } from "@/lib/db/paths.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { apiKeyPrefix } from "@/shared/utils/apiKey.js";

export const NOW = "2026-10-09T00:00:00.000Z";
export const MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));
export const OTHER_MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 11 + 5) % 256));
export const KID = masterKeyId(MASTER);
const HASH_KEY = deriveApiKeyHashKey(MASTER);
export const WS = "ws-default";
const WS2 = "ws-other";
const RAW_H = "th_HASHEDGATEWAYTOKENxxxxxxxxxxxxxxx";
const digest = (raw, key = HASH_KEY) => hashApiKey(raw, key);

let db;

export function setFixtureDb(adapter) {
  db = adapter;
}

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

export function seedHashedInstanceFull() {
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

export async function encryptedSeed() {
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

export const attachedNames = () => db.all("PRAGMA database_list").map((r) => r.name);

export function* chunksOf(buf, size) {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

export function docBytes(doc, { pretty = false } = {}) {
  if (Buffer.isBuffer(doc)) return doc;
  const text = pretty ? JSON.stringify(doc, null, 2).replace(/\n/g, "\r\n") : JSON.stringify(doc);
  return Buffer.from(text, "utf8");
}

/** A request-body-like async iterable of `chunk`-sized Buffers. */
export const bodyOf = (doc, { pretty = false, chunk = 4096 } = {}) =>
  Readable.from(chunksOf(docBytes(doc, { pretty }), chunk));

const dump = (sql) => db.all(sql);
export const fullDump = () =>
  JSON.stringify({
    apiKeys: dump("SELECT * FROM apiKeys ORDER BY id"),
    users: dump("SELECT * FROM users ORDER BY id"),
    workspaces: dump("SELECT * FROM workspaces ORDER BY id"),
    memberships: dump("SELECT * FROM memberships ORDER BY workspaceId, userId"),
    workspaceSettings: dump("SELECT * FROM workspaceSettings ORDER BY workspaceId"),
    userPreferences: dump("SELECT * FROM userPreferences ORDER BY userId"),
    connections: dump("SELECT * FROM providerConnections ORDER BY id"),
    nodes: dump("SELECT * FROM providerNodes ORDER BY id"),
    grants: dump("SELECT * FROM connectionGrants ORDER BY id"),
    budgets: dump("SELECT * FROM budgets ORDER BY id"),
    audit: dump("SELECT * FROM auditEvents ORDER BY id"),
    invitations: dump("SELECT * FROM invitations ORDER BY id"),
    usageHistory: dump("SELECT * FROM usageHistory ORDER BY id"),
    usageRollup: dump("SELECT * FROM usageRollup ORDER BY dateKey, apiKeyId"),
    requestDetails: dump("SELECT * FROM requestDetails ORDER BY id"),
  });

export function clearSections() {
  for (const t of [
    "usageRollup",
    "requestDetails",
    "usageHistory",
    "auditEvents",
    "invitations",
    "budgets",
    "connectionGrants",
    "userPreferences",
    "workspaceSettings",
  ]) {
    db.run(`DELETE FROM ${t}`);
  }
}

export const stagingEntries = () => (fs.existsSync(STAGING_DIR) ? fs.readdirSync(STAGING_DIR) : []);
