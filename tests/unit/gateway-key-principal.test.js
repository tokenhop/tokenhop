import crypto from "node:crypto";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import { insertHashedApiKeySync, revokeUserApiKeysSync } from "@/lib/db/repos/apiKeysRepo.js";
import { updateUserUnscoped } from "@/lib/db/repos/usersRepo.js";
import { removeMembership } from "@/lib/db/repos/membershipsRepo.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { resolveApiKey, clearApiKeyPrincipalCache } from "@/lib/auth/apiKeyPrincipal.js";

const NOW = "2026-10-03T00:00:00.000Z";
const MASTER = crypto.randomBytes(32);
const KID = masterKeyId(MASTER);
const HASH_KEY = deriveApiKeyHashKey(MASTER);
const USER_TOKEN = `th_${"A".repeat(32)}`; // new-format key shape
const LEGACY_TOKEN = "sk-th-legacy"; // legacy key bytes, accepted by hash
const digest = (raw) => hashApiKey(raw, HASH_KEY);

let db;
const row = (patch = {}) => ({
  id: "key",
  workspaceId: "w",
  userId: "u",
  createdByUserId: "u",
  keyHash: digest(USER_TOKEN),
  hashKid: KID,
  prefix: "th_AAAA…AAAA",
  name: "Runner",
  machineId: null,
  legacy: 0,
  isActive: 1,
  revokedAt: null,
  allowedModels: ["openai/gpt-4o"],
  allowedCombos: ["combo-1"],
  expiresAt: null,
  lastUsedAt: null,
  createdAt: NOW,
  ...patch,
});
const ctx = { userId: "manager", instanceRole: "user" };

beforeEach(async () => {
  process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
  clearApiKeyPrincipalCache();
  db = await getAdapter();
  db.exec("DROP TABLE apiKeys");
  // Direct hashed fixture only: no migration or crypto activation.
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    userId TEXT REFERENCES users(id) ON DELETE CASCADE,
    createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
    keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
    machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
    revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
    expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
  db.exec(
    "DELETE FROM memberships; DELETE FROM workspaces; DELETE FROM users; DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')",
  );
  for (const id of ["u", "manager"])
    db.run(
      "INSERT INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES (?, 'user', 'active', ?, ?)",
      [id, NOW, NOW],
    );
  for (const id of ["w", "other"]) {
    db.run(
      "INSERT INTO workspaces(id,name,kind,createdAt,updatedAt) VALUES (?, ?, 'shared', ?, ?)",
      [id, id, NOW, NOW],
    );
    for (const userId of ["u", "manager"])
      db.run("INSERT INTO memberships(workspaceId,userId,role,createdAt) VALUES (?, ?, ?, ?)", [
        id,
        userId,
        userId === "manager" ? "manager" : "member",
        NOW,
      ]);
  }
  db.run("INSERT INTO _meta(key,value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)", [
    KID,
  ]);
});

afterEach(() => {
  delete process.env.TOKENHOP_MASTER_KEY;
});

describe("resolveApiKey", () => {
  it("resolves a valid hashed key to a frozen gateway-only principal", async () => {
    insertHashedApiKeySync(db, row());
    const principal = await resolveApiKey(USER_TOKEN);
    expect(principal).toEqual({
      workspaceId: "w",
      userId: "u",
      apiKeyId: "key",
      scopes: { allowedModels: ["openai/gpt-4o"], allowedCombos: ["combo-1"] },
      via: "apiKey",
    });
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(principal.scopes)).toBe(true);
    // Gateway-only: no dashboard/session authority fields, no raw/hash material.
    for (const forbidden of [
      "instanceRole",
      "workspaceRoles",
      "key",
      "keyHash",
      "hashKid",
      "prefix",
    ]) {
      expect(principal).not.toHaveProperty(forbidden);
    }
    expect(JSON.stringify(principal)).not.toContain(USER_TOKEN);
    // Empty-array scopes: still a concrete principal, never owner/dashboard authority.
    insertHashedApiKeySync(
      db,
      row({ id: "bare", keyHash: digest(LEGACY_TOKEN), allowedModels: [], allowedCombos: [] }),
    );
    expect(await resolveApiKey(LEGACY_TOKEN)).toMatchObject({
      apiKeyId: "bare",
      scopes: { allowedModels: [], allowedCombos: [] },
      via: "apiKey",
    });
  });

  it("accepts previously stored legacy key bytes through the HMAC path", async () => {
    insertHashedApiKeySync(db, row({ legacy: 1, keyHash: digest(LEGACY_TOKEN) }));
    expect((await resolveApiKey(LEGACY_TOKEN))?.apiKeyId).toBe("key");
  });

  it("resolves service keys with null user, independent of creator churn", async () => {
    insertHashedApiKeySync(db, row({ id: "svc", userId: null, keyHash: digest(LEGACY_TOKEN) }));
    db.run("UPDATE users SET status = 'disabled' WHERE id = 'u'");
    const principal = await resolveApiKey(LEGACY_TOKEN);
    expect(principal).toMatchObject({ apiKeyId: "svc", userId: null, via: "apiKey" });
  });

  it("returns null for legacy storage (existing auth untouched)", async () => {
    insertHashedApiKeySync(db, row());
    db.run("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
    await expect(resolveApiKey(USER_TOKEN)).resolves.toBeNull();
  });

  it("returns null for missing, inactive, and unknown keys", async () => {
    insertHashedApiKeySync(db, row());
    db.run("UPDATE apiKeys SET isActive = 0");
    await expect(resolveApiKey(USER_TOKEN)).resolves.toBeNull();
    db.run("UPDATE apiKeys SET isActive = 1");
    await expect(resolveApiKey(`th_${"B".repeat(32)}`)).resolves.toBeNull();
  });

  it("rejects malformed tokens before hashing without fallback", async () => {
    for (const bad of [null, undefined, "", 42, {}, [], "x".repeat(5000)]) {
      await expect(resolveApiKey(bad)).resolves.toBeNull();
    }
    await expect(resolveApiKey("x".repeat(4096))).resolves.toBeNull();
  });

  it("warm cache still fails revoked, disabled, left, and expired keys live", async () => {
    insertHashedApiKeySync(db, row());
    insertHashedApiKeySync(
      db,
      row({ id: "other", workspaceId: "other", keyHash: digest(LEGACY_TOKEN) }),
    );
    // Prime the digest->id cache for both keys.
    await resolveApiKey(USER_TOKEN);
    await resolveApiKey(LEGACY_TOKEN);

    revokeUserApiKeysSync(db, "u", { workspaceId: "w", now: NOW });
    await expect(resolveApiKey(USER_TOKEN)).resolves.toBeNull();

    await updateUserUnscoped("u", { status: "disabled" });
    await expect(resolveApiKey(LEGACY_TOKEN)).resolves.toBeNull();
    await updateUserUnscoped("u", { status: "active" });
    await expect(resolveApiKey(LEGACY_TOKEN)).resolves.toBeNull(); // tombstone permanent

    await removeMembership(ctx, "other", "u");
    await expect(resolveApiKey(LEGACY_TOKEN)).resolves.toBeNull();

    db.run("UPDATE apiKeys SET revokedAt = NULL, expiresAt = ?", [NOW]);
    await expect(resolveApiKey(LEGACY_TOKEN)).resolves.toBeNull(); // expiry at equality
  });

  it("propagates master and storage-state errors, never falls back", async () => {
    insertHashedApiKeySync(db, row());
    // Wrong root for the durable kid.
    process.env.TOKENHOP_MASTER_KEY = crypto.randomBytes(32).toString("base64");
    await expect(resolveApiKey(USER_TOKEN)).rejects.toThrow(/master key id mismatch/);
    // Missing root entirely (env cleared, no keys dir in isolated DATA_DIR).
    delete process.env.TOKENHOP_MASTER_KEY;
    await expect(resolveApiKey(USER_TOKEN)).rejects.toThrow();
    // Partial/malformed marker.
    db.run("DELETE FROM _meta WHERE key = 'apiKeysHashKid'");
    await expect(resolveApiKey(USER_TOKEN)).rejects.toThrow(
      expect.objectContaining({ code: "API_KEY_STATE_INVALID" }),
    );
  });
});
