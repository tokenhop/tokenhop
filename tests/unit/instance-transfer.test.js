// YAN-375 complete-table snapshot parity: every section the hashed snapshot
// carries beyond the identity graph — workspaceSettings, userPreferences,
// connectionGrants, budgets, auditEvents, invitations, usageHistory,
// usageRollup, requestDetails — must round-trip byte-exact through exportDb /
// importDb on both the encrypted (v3) and plain-hashed (v2) paths, and a bad
// FK row must abort preflight with zero mutation. Real adapter + real
// isolated DATA_DIR (tests/vitest.config.js).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import * as dbApi from "@/lib/db/index.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { apiKeyPrefix } from "@/shared/utils/apiKey.js";
import { assertIsolatedHome } from "../helpers/isolatedHome.js";

vi.mock("@/lib/users/featureSwitch.js", () => ({
  isMultiUserEnabled: vi.fn(async () => true),
}));

vi.mock("@/lib/auth/apiKeyPrincipal.js", () => ({
  clearApiKeyPrincipalCache: vi.fn(),
}));

const NOW = "2026-10-09T00:00:00.000Z";
const MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));
const OTHER_MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 11 + 5) % 256));
const KID = masterKeyId(MASTER);
const HASH_KEY = deriveApiKeyHashKey(MASTER);
const WS = "ws-default";
const WS2 = "ws-other";
const RAW_H = "th_HASHEDGATEWAYTOKENxxxxxxxxxxxxxxx";
const digest = (raw, key = HASH_KEY) => hashApiKey(raw, key);
const transferError = (code) => expect.objectContaining({ code });

let db;

const dump = (sql) => db.all(sql);
const fullDump = () =>
  JSON.stringify({
    apiKeys: dump("SELECT * FROM apiKeys ORDER BY id"),
    users: dump("SELECT * FROM users ORDER BY id"),
    identities: dump("SELECT * FROM identities ORDER BY id"),
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

beforeEach(async () => {
  db = await getAdapter();
  db.exec("DROP TABLE IF EXISTS gatewayVideoJobs");
  db.exec(`DELETE FROM workspaceKeys; DELETE FROM _meta WHERE key IN
    ('credentialsEncryptedVersion','credentialsKekKid','apiKeyHashKeyWrapped','credentialsCleanupPending','credentialsPendingRotation')`);
  vi.clearAllMocks();
});

afterEach(() => {
  assertIsolatedHome();
  const keysDir = path.join(process.env.DATA_DIR, "keys");
  fs.rmSync(keysDir, { recursive: true, force: true });
  assertIsolatedHome();
});

describe("instance full-table sections (encrypted v3)", () => {
  beforeEach(encryptedSeed);

  it("round-trips every table section byte-exact", async () => {
    const snapshot = await dbApi.exportDb();
    for (const section of [
      "workspaceSettings",
      "userPreferences",
      "connectionGrants",
      "budgets",
      "auditEvents",
      "invitations",
      "usageHistory",
      "usageRollup",
      "requestDetails",
    ]) {
      expect(Array.isArray(snapshot[section])).toBe(true);
      expect(snapshot[section].length).toBeGreaterThan(0);
    }
    const snapSettings = snapshot.workspaceSettings.find((r) => r.workspaceId === WS);
    expect(snapSettings).toMatchObject({ workspaceId: WS });
    // Connection credentials stay encrypted envelopes: no plaintext token.
    expect(JSON.stringify(snapshot.providerConnections)).not.toContain("sk-upstream-cred");
    expect(snapshot.connectionGrants[0]).toMatchObject({ id: "grant-1", workspaceId: WS2 });

    // Wipe everything the apply deletes, then restore.
    db.run(`DELETE FROM usageRollup`);
    db.run(`DELETE FROM requestDetails`);
    db.run(`DELETE FROM usageHistory`);
    db.run(`DELETE FROM auditEvents`);
    db.run(`DELETE FROM invitations`);
    db.run(`DELETE FROM budgets`);
    db.run(`DELETE FROM connectionGrants`);
    db.run(`DELETE FROM userPreferences`);
    db.run(`DELETE FROM workspaceSettings`);
    db.run(
      `INSERT INTO auditEvents(id, ts, actorUserId, actorApiKeyId, via, ip, workspaceId, action, targetType, targetId, before, after, result)
       VALUES('intruder', ?, NULL, NULL, NULL, NULL, NULL, 'x.poke', NULL, NULL, NULL, NULL, 'ok')`,
      [NOW],
    );

    await dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER });

    const restored = await dbApi.exportDb();
    for (const section of [
      "workspaceSettings",
      "userPreferences",
      "connectionGrants",
      "budgets",
      "auditEvents",
      "invitations",
      "usageHistory",
      "usageRollup",
      "requestDetails",
    ]) {
      expect(restored[section]).toEqual(snapshot[section]);
    }
    expect(dump("SELECT id FROM auditEvents ORDER BY id").map((r) => r.id)).toEqual(["audit-1"]);
    expect(dump("SELECT id FROM budgets ORDER BY id").map((r) => r.id)).toEqual([
      "budget-grant",
      "budget-user",
      "budget-ws",
    ]);
    // Ciphertext rows still authenticate under the same root after restore.
    const { decodeCredentialRowSync, prepareCredentialContext } = await import(
      "@/lib/db/helpers/credentialStorage.js"
    );
    const ctx = prepareCredentialContext(db, { kid: KID, key: MASTER });
    const conn = db.get(`SELECT * FROM providerConnections WHERE id = 'conn-1'`);
    expect(
      decodeCredentialRowSync(db, conn, ctx, { table: "providerConnections", mode: "runtime" })
        .accessToken,
    ).toBeDefined();
  });

  it("restores a portable snapshot under a different KEK without changing client keys", async () => {
    const { makeInstancePortable } = await import("@/lib/db/helpers/instancePortable.js");
    const { encryptBytes, buildDekWrapAad, buildHashKeyWrapAad } = await import(
      "@/lib/security/envelope.js"
    );
    const { prepareCredentialContext, decodeCredentialRowSync } = await import(
      "@/lib/db/helpers/credentialStorage.js"
    );
    const { resolveApiKeyHashKeySync } = await import("@/lib/security/apiKeyHashKey.js");
    const source = await dbApi.exportDb();
    const portable = await makeInstancePortable(source, {
      passphrase: "portable",
      masterKey: MASTER,
    });
    const targetKid = masterKeyId(OTHER_MASTER);
    const targetHash = deriveApiKeyHashKey(OTHER_MASTER);
    const targetWorkspaceKeys = source.workspaceKeys.map((row) => ({ ...row }));
    for (const row of targetWorkspaceKeys) {
      // Keep destination's existing graph valid while swapping to a distinct KEK.
      const { decryptBytes } = await import("@/lib/security/envelope.js");
      const dek = decryptBytes(
        MASTER,
        JSON.parse(row.wrappedDek),
        buildDekWrapAad(row.workspaceId, row.kid),
      );
      row.wrappedDek = JSON.stringify(
        encryptBytes(OTHER_MASTER, targetKid, dek, buildDekWrapAad(row.workspaceId, row.kid)),
      );
      dek.fill(0);
      db.run("UPDATE workspaceKeys SET wrappedDek = ? WHERE workspaceId = ?", [
        row.wrappedDek,
        row.workspaceId,
      ]);
    }
    db.run("UPDATE _meta SET value = ? WHERE key = 'credentialsKekKid'", [targetKid]);
    db.run("UPDATE _meta SET value = ? WHERE key = 'apiKeysHashKid'", [targetKid]);
    db.run("UPDATE apiKeys SET hashKid = ?", [targetKid]);
    db.run("UPDATE _meta SET value = ? WHERE key = 'apiKeyHashKeyWrapped'", [
      JSON.stringify(
        encryptBytes(OTHER_MASTER, targetKid, targetHash, buildHashKeyWrapAad(WS, targetKid)),
      ),
    ]);
    const before = fullDump();
    await expect(
      dbApi.importDb(portable, { masterKey: OTHER_MASTER, passphrase: "wrong" }),
    ).rejects.toMatchObject({
      code: "INSTANCE_PORTABLE_INVALID",
    });
    expect(fullDump()).toBe(before);
    await dbApi.importDb(portable, { masterKey: OTHER_MASTER, passphrase: "portable" });
    const adopted = resolveApiKeyHashKeySync(db, { kid: targetKid, key: OTHER_MASTER });
    expect(hashApiKey(RAW_H, adopted.hashKey)).toBe(
      db.get("SELECT keyHash FROM apiKeys WHERE id = 'hk-1'").keyHash,
    );
    adopted.hashKey.fill(0);
    targetHash.fill(0);
    const ctx = prepareCredentialContext(db, { kid: targetKid, key: OTHER_MASTER });
    expect(
      decodeCredentialRowSync(
        db,
        db.get("SELECT * FROM providerConnections WHERE id = 'conn-1'"),
        ctx,
        {
          table: "providerConnections",
          mode: "runtime",
        },
      ).accessToken,
    ).toBe("sk-upstream-cred");
  });

  it("restores user-data lifetime counters", async () => {
    db.run(
      "INSERT OR REPLACE INTO _meta(key, value) VALUES('savingsTokensLifetime', '123'), ('totalRequestsLifetime', '45')",
    );
    const snapshot = await dbApi.exportDb();
    db.run(
      "UPDATE _meta SET value = '999' WHERE key IN ('savingsTokensLifetime', 'totalRequestsLifetime')",
    );
    await dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER });
    expect(
      db.all(
        "SELECT key, value FROM _meta WHERE key IN ('savingsTokensLifetime', 'totalRequestsLifetime') ORDER BY key",
      ),
    ).toEqual([
      { key: "savingsTokensLifetime", value: "123" },
      { key: "totalRequestsLifetime", value: "45" },
    ]);
  });

  it("preserves every KV scope and workspace-scoped key byte-for-byte", async () => {
    for (const [scope, key, value] of [
      ["modelAliases", `ws:${WS}/default-alias`, '"openai/gpt-4o"'],
      ["modelAliases", `ws:${WS2}/other-alias`, '"anthropic/claude"'],
      ["customModels", `ws:${WS2}/openai|custom|llm`, '{"id":"custom"}'],
      ["disabledModels", `ws:${WS2}/openai`, '["gpt-4o-mini"]'],
      ["gemini_thought_signatures", "cache-key", '{"signature":"kept"}'],
    ]) {
      db.run("INSERT OR REPLACE INTO kv(scope, key, value) VALUES(?, ?, ?)", [scope, key, value]);
    }
    const before = db.all("SELECT scope, key, value FROM kv ORDER BY scope, key");
    const snapshot = await dbApi.exportDb();
    await dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER });
    expect(db.all("SELECT scope, key, value FROM kv ORDER BY scope, key")).toEqual(before);
  });

  it("preserves same-name combos in separate workspaces, ownership and sort order", async () => {
    for (const [id, workspaceId, sortOrder] of [
      ["combo-a", WS, 2],
      ["combo-b", WS2, 4],
    ]) {
      db.run(
        `INSERT INTO combos(id, name, models, workspaceId, createdByUserId, sortOrder, createdAt, updatedAt)
        VALUES(?, 'Same name', '[]', ?, 'owner', ?, ?, ?)`,
        [id, workspaceId, sortOrder, NOW, NOW],
      );
    }
    const before = db.all("SELECT * FROM combos ORDER BY id");
    const snapshot = await dbApi.exportDb();
    await dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER });
    expect(db.all("SELECT * FROM combos ORDER BY id")).toEqual(before);
  });

  it("preserves usage rollups with empty unknown-attribution dimensions", async () => {
    db.run("INSERT INTO usageRollup(dateKey) VALUES(?)", ["2026-10-10"]);
    const snapshot = await dbApi.exportDb();
    expect(snapshot.usageRollup.find((row) => row.dateKey === "2026-10-10")).toMatchObject({
      workspaceId: "",
      userId: "",
      connectionId: "",
      endpoint: "",
    });
    await dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER });
    expect((await dbApi.exportDb()).usageRollup).toEqual(snapshot.usageRollup);
  });

  it("refuses differing users unless the instance owner forces replacement", async () => {
    const snapshot = await dbApi.exportDb();
    snapshot.users = structuredClone(snapshot.users);
    snapshot.users.find((user) => user.id === "member1").email = "replacement@x.test";
    const before = fullDump();
    await expect(
      dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER }),
    ).rejects.toMatchObject({
      code: "IMPORT_USER_MISMATCH",
      diff: expect.objectContaining({
        onlyInBackup: expect.any(Array),
        onlyInInstance: expect.any(Array),
      }),
    });
    await expect(
      dbApi.importDb(structuredClone(snapshot), {
        masterKey: MASTER,
        force: true,
        actor: { instanceRole: "admin" },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fullDump()).toBe(before);
    await dbApi.importDb(structuredClone(snapshot), {
      masterKey: MASTER,
      force: true,
      actor: { instanceRole: "owner" },
    });
    expect(db.get("SELECT email FROM users WHERE id = 'member1'").email).toBe("replacement@x.test");
  });

  it("rejects a combo owned by an unknown workspace before mutation", async () => {
    db.run(
      `INSERT INTO combos(id, name, models, workspaceId, createdByUserId, createdAt, updatedAt)
      VALUES('combo-ref', 'Ref', '[]', ?, 'owner', ?, ?)`,
      [WS, NOW, NOW],
    );
    const snapshot = await dbApi.exportDb();
    snapshot.combos.find((combo) => combo.id === "combo-ref").workspaceId = "ghost-ws";
    const before = fullDump();
    await expect(dbApi.importDb(snapshot, { masterKey: MASTER })).rejects.toThrow(
      transferError("TRANSFER_REF_INVALID"),
    );
    expect(fullDump()).toBe(before);
  });

  it("rolls back the whole import when a grant references an unknown connection", async () => {
    const snapshot = await dbApi.exportDb();
    snapshot.connectionGrants = structuredClone(snapshot.connectionGrants);
    snapshot.connectionGrants.push({
      id: "grant-evil",
      connectionId: "ghost-conn",
      workspaceId: WS,
      userId: null,
      allowedModels: null,
      rpm: null,
      tpm: null,
      budgetId: null,
      createdByUserId: null,
      tosAcknowledgedAt: null,
      createdAt: Date.parse(NOW),
      revokedAt: null,
    });
    const before = fullDump();
    await expect(dbApi.importDb(snapshot, { masterKey: MASTER })).rejects.toThrow(
      transferError("TRANSFER_REF_INVALID"),
    );
    expect(fullDump()).toBe(before);
  });

  it("explicit [] clears a section; an absent section retains live rows", async () => {
    const snapshot = await dbApi.exportDb();
    snapshot.auditEvents = [];
    await dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER });
    expect(dump("SELECT COUNT(*) AS n FROM auditEvents")[0].n).toBe(0);

    // Re-add a live audit row not present in the incoming snapshot.
    db.run(
      `INSERT INTO auditEvents(id, ts, actorUserId, actorApiKeyId, via, ip, workspaceId, action, targetType, targetId, before, after, result)
       VALUES('audit-live', ?, 'owner', NULL, 'ui', NULL, ?, 'live.poke', NULL, NULL, NULL, NULL, 'ok')`,
      [NOW, WS],
    );
    const slim = structuredClone(snapshot);
    delete slim.auditEvents;
    await dbApi.importDb(slim, { masterKey: MASTER });
    expect(dump("SELECT id FROM auditEvents ORDER BY id").map((r) => r.id)).toEqual(["audit-live"]);
  });

  it("rejects unknown fields and bad budget scope before mutation", async () => {
    const first = await dbApi.exportDb();
    first.budgets[0].mystery = "x";
    const before = fullDump();
    await expect(dbApi.importDb(first, { masterKey: MASTER })).rejects.toThrow(
      transferError("TRANSFER_STATE_INVALID"),
    );
    expect(fullDump()).toBe(before);

    const second = structuredClone(await dbApi.exportDb());
    second.budgets[0].scopeType = "planetary";
    await expect(dbApi.importDb(second, { masterKey: MASTER })).rejects.toThrow(
      transferError("TRANSFER_STATE_INVALID"),
    );
    expect(fullDump()).toBe(before);
  });
});

describe("instance full-table sections (plain hashed v2)", () => {
  beforeEach(seedHashedInstanceFull);

  it("round-trips preferences, grants, budgets, usage, audit, invitations and requestDetails", async () => {
    const snapshot = await dbApi.exportDb();
    for (const section of [
      "workspaceSettings",
      "userPreferences",
      "connectionGrants",
      "budgets",
      "auditEvents",
      "invitations",
      "usageHistory",
      "usageRollup",
      "requestDetails",
    ]) {
      expect(Array.isArray(snapshot[section])).toBe(true);
      expect(snapshot[section].length).toBeGreaterThan(0);
    }
    db.run(`DELETE FROM usageRollup`);
    db.run(`DELETE FROM requestDetails`);
    db.run(`DELETE FROM usageHistory`);
    db.run(`DELETE FROM auditEvents`);
    db.run(`DELETE FROM invitations`);
    db.run(`DELETE FROM budgets`);
    db.run(`DELETE FROM connectionGrants`);
    db.run(`DELETE FROM userPreferences`);
    db.run(`DELETE FROM workspaceSettings`);

    await dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER });

    const restored = await dbApi.exportDb();
    for (const section of [
      "workspaceSettings",
      "userPreferences",
      "connectionGrants",
      "budgets",
      "auditEvents",
      "invitations",
      "usageHistory",
      "usageRollup",
      "requestDetails",
    ]) {
      expect(restored[section]).toEqual(snapshot[section]);
    }
    expect(dump("SELECT keyHash FROM apiKeys WHERE id = 'hk-1'")[0].keyHash).toBe(digest(RAW_H));
  });

  it("wrong master fails preflight on a full snapshot with zero mutation", async () => {
    const snapshot = await dbApi.exportDb();
    const before = fullDump();
    await expect(dbApi.importDb(snapshot, { masterKey: OTHER_MASTER })).rejects.toThrow(
      transferError("TRANSFER_ROOT_MISMATCH"),
    );
    expect(fullDump()).toBe(before);
  });
});

// Environment sanity: the Vitest config under test must isolate HOME so a
// here-doc run of this file can never touch real files.
it("runs under an isolated HOME", async () => {
  const home = os.homedir();
  expect(home).not.toBe("/root");
  expect(String(process.env.HOME ?? home)).not.toBe("/root");
});
