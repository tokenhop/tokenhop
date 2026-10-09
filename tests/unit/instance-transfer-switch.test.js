import { beforeAll, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import * as dbApi from "@/lib/db/index.js";
import { INSTANCE_SNAPSHOT_SECTION_NAMES } from "@/lib/db/helpers/instanceSnapshotTables.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { apiKeyPrefix } from "@/shared/utils/apiKey.js";

let enabled = false;
vi.mock("@/lib/users/featureSwitch.js", () => ({ isMultiUserEnabled: vi.fn(async () => enabled) }));
vi.mock("@/lib/auth/apiKeyPrincipal.js", () => ({ clearApiKeyPrincipalCache: vi.fn() }));

const NOW = "2026-10-09T00:00:00.000Z";
const MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));
const KID = masterKeyId(MASTER);
const RAW = "th_SWITCHTESTGATEWAYKEYxxxxxxxxxxxxx";
let db;

const tableDump = () =>
  JSON.stringify(
    Object.fromEntries(
      ["workspaceSettings", "userPreferences", "budgets", "auditEvents", "invitations", "kv"].map(
        (table) => [table, db.all(`SELECT * FROM ${table} ORDER BY rowid`)],
      ),
    ),
  );

beforeAll(async () => {
  db = await getAdapter();
  db.exec("DROP TABLE IF EXISTS apiKeys");
  db.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    userId TEXT REFERENCES users(id) ON DELETE CASCADE,
    createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
    keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
    machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
    revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
    expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
  db.run(
    `INSERT INTO users(id, email, username, displayName, instanceRole, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt)
     VALUES('owner', 'owner@x.test', 'owner', 'Owner', 'owner', 'active', 'hash', 0, 1, ?, ?)`,
    [NOW, NOW],
  );
  db.run(
    "INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES('ws', 'Default', 'shared', 'owner', ?, ?)",
    [NOW, NOW],
  );
  db.run(
    "INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES('ws', 'owner', 'owner', 'manual', ?)",
    [NOW],
  );
  db.run(
    `INSERT INTO apiKeys(id, workspaceId, userId, createdByUserId, keyHash, hashKid, prefix, name, legacy, isActive, allowedModels, createdAt)
     VALUES('key', 'ws', 'owner', 'owner', ?, ?, ?, 'Key', 0, 1, '[]', ?)`,
    [hashApiKey(RAW, deriveApiKeyHashKey(MASTER)), KID, apiKeyPrefix(RAW), NOW],
  );
  db.run(
    "INSERT INTO _meta(key, value) VALUES('apiKeysHashedVersion', '1'), ('apiKeysHashKid', ?), ('defaultWorkspaceId', 'ws')",
    [KID],
  );
  const { activateCredentialEncryption } = await import("@/lib/db/activateCredentialEncryption.js");
  await activateCredentialEncryption(db, {
    enabled: true,
    beforeServing: true,
    root: { kid: KID, key: MASTER },
  });
  db.run(
    "INSERT INTO workspaceSettings(workspaceId, data, updatedAt) VALUES('ws', '{\"rtkEnabled\":true}', ?)",
    [NOW],
  );
});

describe("instance transfer switch gating", () => {
  it("keeps encrypted export and import on the previous behavior while switched off", async () => {
    enabled = false;
    const snapshot = await dbApi.exportDb();
    expect(snapshot.formatVersion).toBe(3);
    for (const name of ["kv", "metadataCounters", ...INSTANCE_SNAPSHOT_SECTION_NAMES]) {
      expect(snapshot).not.toHaveProperty(name);
    }
    await dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER });
    // Prior hashed restore replaces users/workspaces; existing FK cascades
    // remove their settings. OFF must not run the new retention/restore lane.
    expect(db.all("SELECT * FROM workspaceSettings")).toEqual([]);
    await expect(dbApi.exportDb({ passphrase: "test" })).rejects.toMatchObject({
      code: "TRANSFER_PORTABLE_UNSUPPORTED",
    });
  });

  it("rejects new sections while switched off", async () => {
    enabled = true;
    const snapshot = await dbApi.exportDb();
    enabled = false;
    const before = tableDump();
    await expect(dbApi.importDb(snapshot, { masterKey: MASTER })).rejects.toMatchObject({
      code: "TRANSFER_FORMAT_INVALID",
    });
    expect(tableDump()).toBe(before);
  });
});
