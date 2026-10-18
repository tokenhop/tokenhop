// YAN-751 (D6): an instance import never carries device sessions and wipes the
// live ones (tokens minted against the old instance must not survive a
// restore). Real adapter + real isolated DATA_DIR (tests/vitest.config.js).
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import * as dbApi from "@/lib/db/index.js";
import {
  createSessionUnscoped,
  getSessionForValidationUnscoped,
} from "@/lib/db/repos/sessionsRepo.js";
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
const KID = masterKeyId(MASTER);
const HASH_KEY = deriveApiKeyHashKey(MASTER);
const WS = "ws-default";
const RAW_KEY = "th_HASHEDGATEWAYTOKENxxxxxxxxxxxxxxx";

let db;

function seedHashedInstance() {
  db.exec(`DELETE FROM usageRollup; DELETE FROM requestDetails; DELETE FROM usageHistory;
    DELETE FROM auditEvents; DELETE FROM invitations; DELETE FROM budgets;
    DELETE FROM connectionGrants; DELETE FROM userPreferences; DELETE FROM workspaceSettings;
    DELETE FROM providerNodes; DELETE FROM providerConnections; DROP TABLE IF EXISTS apiKeys`);
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
  db.run(
    `INSERT INTO users(id, email, username, displayName, instanceRole, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt, lastLoginAt)
     VALUES('owner', 'owner@x.test', 'owner', 'owner', 'owner', 'active', 'hashedsecret', 0, 1, ?, ?, NULL)`,
    [NOW, NOW],
  );
  db.run(
    `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES(?, ?, 'shared', 'owner', ?, ?)`,
    [WS, WS, NOW, NOW],
  );
  db.run(
    `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?, 'owner', 'owner', 'manual', ?)`,
    [WS, NOW],
  );
  db.run(
    `INSERT INTO apiKeys(id, workspaceId, userId, createdByUserId, keyHash, hashKid, prefix, name, machineId, legacy, isActive, allowedModels, createdAt)
     VALUES('hk-1', ?, 'owner', 'owner', ?, ?, ?, 'Runner', NULL, 0, 1, '[]', ?)`,
    [WS, hashApiKey(RAW_KEY, HASH_KEY), KID, apiKeyPrefix(RAW_KEY), NOW],
  );
  db.run(
    `INSERT INTO _meta(key, value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?), ('defaultWorkspaceId',?)`,
    [KID, WS],
  );
}

const countSessions = () => db.get("SELECT COUNT(*) AS n FROM sessions").n;

async function seedSession(id) {
  await createSessionUnscoped({
    id,
    userId: "owner",
    sv: 1,
    amr: "pwd",
    createdAt: NOW,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
}

beforeEach(async () => {
  db = await getAdapter();
  db.exec("DROP TABLE IF EXISTS gatewayVideoJobs");
  db.exec(`DELETE FROM workspaceKeys; DELETE FROM _meta WHERE key IN
    ('credentialsEncryptedVersion','credentialsKekKid','apiKeyHashKeyWrapped','credentialsCleanupPending','credentialsPendingRotation')`);
  seedHashedInstance();
  db.exec("DELETE FROM sessions");
  globalThis.__tokenhopDeviceSessionCache?.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  assertIsolatedHome();
  fs.rmSync(path.join(process.env.DATA_DIR, "keys"), { recursive: true, force: true });
  assertIsolatedHome();
});

describe("instance import and device sessions (D6)", () => {
  it("does not export sessions", async () => {
    await seedSession("sid-export");
    const snapshot = await dbApi.exportDb();
    expect(snapshot.sessions).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain("sid-export");
  });

  it("wipes every session row and drops the validation cache on import", async () => {
    await seedSession("sid-a");
    await seedSession("sid-b");
    const snapshot = await dbApi.exportDb();
    // Warm the cache: a stale hit would keep the old token valid after import.
    expect(await getSessionForValidationUnscoped("sid-a")).toMatchObject({ userId: "owner" });
    expect(countSessions()).toBe(2);

    await dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER });

    expect(countSessions()).toBe(0);
    expect(await getSessionForValidationUnscoped("sid-a")).toBeNull();
    expect(await getSessionForValidationUnscoped("sid-b")).toBeNull();
  });

  it("keeps the imported users intact while dropping their sessions", async () => {
    await seedSession("sid-a");
    const snapshot = await dbApi.exportDb();
    await dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER });
    expect(db.get("SELECT id FROM users WHERE id = 'owner'")).toMatchObject({ id: "owner" });
    expect(countSessions()).toBe(0);
  });
});
