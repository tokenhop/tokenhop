// YAN-1981 shared scenario: a hashed instance restore with Users & teams off
// replaces workspaces and users; live usage attributed to a workspace/user the
// snapshot restores (same id) must keep it. Run by a native-driver test and a
// sql.js-forced test (each file owns its own vi.mock hoisting).
import { expect } from "vitest";
import * as dbApi from "@/lib/db/index.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";
import { apiKeyPrefix } from "@/shared/utils/apiKey.js";

export const NOW = "2026-10-09T00:00:00.000Z";
export const MASTER = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));
const KID = masterKeyId(MASTER);
const RAW = "th_USAGEATTRRESTORExxxxxxxxxxxxxxxxx";

export async function seedHashedSwitchOffInstance(db) {
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
}

// Live state written after the export: a workspace and user the snapshot does
// not know, and usage on restored, dropped and ownerless attribution.
function seedLiveUsage(db) {
  db.run(
    `INSERT INTO users(id, email, username, displayName, instanceRole, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt)
     VALUES('late', 'late@x.test', 'late', 'Late', 'user', 'active', 'hash', 0, 1, ?, ?)`,
    [NOW, NOW],
  );
  db.run(
    "INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES('ws-late', 'Late', 'shared', 'late', ?, ?)",
    [NOW, NOW],
  );
  const history = [
    [101, "ws", "owner"], // restored workspace + user
    [102, "ws", "late"], // restored workspace, dropped user
    [103, "ws-late", "owner"], // dropped workspace, restored user
    [104, "ws-late", "late"], // both dropped
    [105, null, null], // ownerless: never adopted
  ];
  for (const [id, workspaceId, userId] of history) {
    db.run(
      `INSERT INTO usageHistory(id, timestamp, provider, model, apiKeyId, cost, status, workspaceId, userId)
       VALUES(?, ?, 'openai', 'gpt', 'key', 1.5, 'ok', ?, ?)`,
      [id, NOW, workspaceId, userId],
    );
  }
  for (const [id, workspaceId, userId] of [
    ["rd-kept", "ws", "owner"],
    ["rd-dropped", "ws-late", "late"],
    ["rd-ownerless", null, null],
  ]) {
    db.run(
      `INSERT INTO requestDetails(id, timestamp, provider, model, status, data, workspaceId, userId, apiKeyId)
       VALUES(?, ?, 'openai', 'gpt', 'ok', '{}', ?, ?, 'key')`,
      [id, NOW, workspaceId, userId],
    );
  }
}

export async function expectRestoreKeepsUsageAttribution(db) {
  db.run("DELETE FROM usageHistory");
  db.run("DELETE FROM requestDetails");
  const snapshot = await dbApi.exportDb();
  expect(snapshot.workspaces.map((w) => w.id)).toEqual(["ws"]);
  seedLiveUsage(db);

  await dbApi.importDb(structuredClone(snapshot), { masterKey: MASTER });

  expect(db.all("SELECT id FROM workspaces ORDER BY id")).toEqual([{ id: "ws" }]);
  expect(
    db.all("SELECT id, workspaceId, userId FROM usageHistory ORDER BY id").map((r) => ({ ...r })),
  ).toEqual([
    { id: 101, workspaceId: "ws", userId: "owner" },
    { id: 102, workspaceId: "ws", userId: null },
    { id: 103, workspaceId: null, userId: "owner" },
    { id: 104, workspaceId: null, userId: null },
    { id: 105, workspaceId: null, userId: null },
  ]);
  expect(
    db.all("SELECT id, workspaceId, userId FROM requestDetails ORDER BY id").map((r) => ({ ...r })),
  ).toEqual([
    { id: "rd-dropped", workspaceId: null, userId: null },
    { id: "rd-kept", workspaceId: "ws", userId: "owner" },
    { id: "rd-ownerless", workspaceId: null, userId: null },
  ]);
  // The hold tables never outlive the restore transaction.
  expect(db.all("SELECT name FROM sqlite_temp_master WHERE name LIKE '_usageHold%'")).toEqual([]);
}

// A failed apply after the hold leaves usage attribution and temp tables as
// they were (the hold runs inside the import transaction).
export async function expectFailedApplyRollsBackHold(db) {
  const { holdUsageAttribution } = await import("@/lib/db/helpers/usageAttributionHold.js");
  const before = db.all("SELECT id, workspaceId, userId FROM usageHistory ORDER BY id");
  expect(before.some((r) => r.workspaceId === "ws")).toBe(true);
  expect(() =>
    db.transaction(() => {
      holdUsageAttribution(db, { workspaces: [{ id: "ws" }], users: [{ id: "owner" }] });
      db.run("DELETE FROM workspaces");
      throw new Error("simulated apply failure");
    }),
  ).toThrow("simulated apply failure");
  expect(db.all("SELECT id, workspaceId, userId FROM usageHistory ORDER BY id")).toEqual(before);
  expect(db.all("SELECT name FROM sqlite_temp_master WHERE name LIKE '_usageHold%'")).toEqual([]);
}
