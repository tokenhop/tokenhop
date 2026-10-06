// User-lifecycle × hashed gateway keys (real DB, no mocks):
// 1) disable bumps sessionVersion, tombstones the user's hashed keys
//    everywhere, service keys untouched; re-enable never resurrects a tombstone.
// 2) delete drops the personal workspace's connections and keys, cascades the
//    user's shared-workspace key, and keeps the shared connection (creator
//    nulled) plus the shared service key (userId null, creator nulled).
import { beforeEach, describe, expect, it } from "vitest";
import * as keys from "@/lib/db/repos/apiKeysRepo.js";
import { getAdapter } from "@/lib/db/driver.js";
import {
  createUserUnscoped,
  updateUserUnscoped,
  deleteUserUnscoped,
} from "@/lib/db/repos/usersRepo.js";
import { HASHED_API_KEYS_TABLE, buildCreateTableSql } from "@/lib/db/schema.js";

const NOW = "2026-10-06T00:00:00.000Z";
const KID = "0123456789abcdef";
let db;
let owner;
let target;
let bystander;
let sharedId;

const keyRow = (patch = {}) => ({
  id: "key",
  workspaceId: "w",
  userId: target.id,
  createdByUserId: target.id,
  keyHash: "a".repeat(64),
  hashKid: KID,
  prefix: "th_1234…5678",
  name: "Runner",
  machineId: null,
  legacy: 0,
  isActive: 1,
  revokedAt: null,
  allowedModels: [],
  allowedCombos: [],
  expiresAt: null,
  lastUsedAt: null,
  createdAt: NOW,
  ...patch,
});

beforeEach(async () => {
  db = await getAdapter();
  db.exec("DROP TABLE apiKeys");
  db.exec(buildCreateTableSql("apiKeys", HASHED_API_KEYS_TABLE));
  db.run("DELETE FROM providerConnections");
  for (const t of ["memberships", "identities", "workspaces", "users"]) db.run(`DELETE FROM ${t}`);
  db.run("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
  db.run(
    "INSERT INTO _meta(key, value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)",
    [KID],
  );

  owner = await createUserUnscoped({ email: "owner@x.io", instanceRole: "owner" });
  target = await createUserUnscoped({ email: "target@x.io", instanceRole: "user" });
  bystander = await createUserUnscoped({ email: "other@x.io", instanceRole: "user" });

  db.run(
    `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES(?, 'Team', 'shared', ?, ?, ?)`,
    ["ws-shared", owner.id, NOW, NOW],
  );
  for (const [userId, role] of [
    [owner.id, "owner"],
    [target.id, "member"],
    [bystander.id, "manager"], // keeps disable/delete legal (never last manager)
  ])
    db.run(
      `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?, ?, ?, 'manual', ?)`,
      ["ws-shared", userId, role, NOW],
    );
  sharedId = "ws-shared";

  const conn = (id, workspaceId, createdByUserId) =>
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, isActive, data, createdAt, updatedAt, workspaceId, createdByUserId)
       VALUES(?, 'anthropic', 'oauth', ?, 1, '{}', ?, ?, ?, ?)`,
      [id, id, NOW, NOW, workspaceId, createdByUserId],
    );
  conn("conn-personal", target.personalWorkspaceId, target.id);
  conn("conn-shared", sharedId, target.id);
});

describe("disable user revokes hashed keys; enable never resurrects", () => {
  it("bumps sessionVersion, tombstones owned keys in every workspace, keeps service keys", async () => {
    keys.insertHashedApiKeySync(
      db,
      keyRow({ id: "k-personal", workspaceId: target.personalWorkspaceId }),
    );
    keys.insertHashedApiKeySync(
      db,
      keyRow({ id: "k-shared", workspaceId: sharedId, keyHash: "b".repeat(64) }),
    );
    keys.insertHashedApiKeySync(
      db,
      keyRow({ id: "k-service", workspaceId: sharedId, userId: null, keyHash: "c".repeat(64) }),
    );
    keys.insertHashedApiKeySync(
      db,
      keyRow({
        id: "k-bystander",
        workspaceId: sharedId,
        userId: bystander.id,
        createdByUserId: bystander.id,
        keyHash: "d".repeat(64),
      }),
    );

    const before = db.get(`SELECT sessionVersion AS sv FROM users WHERE id = ?`, [target.id]).sv;
    await updateUserUnscoped(target.id, { status: "disabled" });
    const after = db.get(`SELECT sessionVersion AS sv, status FROM users WHERE id = ?`, [
      target.id,
    ]);
    expect(after.status).toBe("disabled");
    expect(after.sv).toBe(before + 1);

    const revoked = (id) => db.get(`SELECT revokedAt FROM apiKeys WHERE id = ?`, [id]).revokedAt;
    expect(revoked("k-personal")).toBeTruthy();
    expect(revoked("k-shared")).toBe(revoked("k-personal")); // same tx clock
    expect(revoked("k-service")).toBeNull(); // service keys outlive user churn
    expect(revoked("k-bystander")).toBeNull(); // other users untouched

    // Eligibility is dead on the exact live-hash path even with the user active again.
    const tombstone = revoked("k-personal");
    await updateUserUnscoped(target.id, { status: "active" });
    expect(db.get(`SELECT status FROM users WHERE id = ?`, [target.id]).status).toBe("active");
    expect(db.get(`SELECT sessionVersion AS sv FROM users WHERE id = ?`, [target.id]).sv).toBe(
      after.sv + 1,
    );
    // Hostile manual unpause must not resurrect the tombstone.
    db.run(`UPDATE apiKeys SET isActive = 1`);
    expect(revoked("k-personal")).toBe(tombstone);
    expect(revoked("k-shared")).toBe(tombstone);
    expect(
      keys.getEligibleApiKeySync(db, "k-personal", { keyHash: "a".repeat(64), now: NOW }),
    ).toBeNull();
    expect(
      keys.getEligibleApiKeySync(db, "k-shared", { keyHash: "b".repeat(64), now: NOW }),
    ).toBeNull();
    expect(
      keys.getEligibleApiKeySync(db, "k-service", { keyHash: "c".repeat(64), now: NOW }),
    ).not.toBeNull();
    expect(
      keys.getEligibleApiKeySync(db, "k-bystander", { keyHash: "d".repeat(64), now: NOW }),
    ).not.toBeNull();
  });
});

describe("delete user cascades personal + user keys, preserves shared provenance", () => {
  it("drops personal workspace connection+key, nulls shared creators, service key survives", async () => {
    keys.insertHashedApiKeySync(
      db,
      keyRow({ id: "k-personal", workspaceId: target.personalWorkspaceId }),
    );
    keys.insertHashedApiKeySync(
      db,
      keyRow({ id: "k-shared", workspaceId: sharedId, keyHash: "b".repeat(64) }),
    );
    keys.insertHashedApiKeySync(
      db,
      keyRow({ id: "k-service", workspaceId: sharedId, userId: null, keyHash: "c".repeat(64) }),
    );

    expect(await deleteUserUnscoped(target.id)).toBe(true);

    // User, memberships and personal workspace are gone.
    expect(db.get(`SELECT id FROM users WHERE id = ?`, [target.id])).toBeUndefined();
    expect(db.get(`SELECT userId FROM memberships WHERE userId = ?`, [target.id])).toBeUndefined();
    expect(
      db.get(`SELECT id FROM workspaces WHERE id = ?`, [target.personalWorkspaceId]),
    ).toBeUndefined();

    // Personal connection and key deleted with the workspace cascade.
    expect(db.get(`SELECT id FROM providerConnections WHERE id = 'conn-personal'`)).toBeUndefined();
    expect(keys.getHashedApiKeyByHashUnscoped(db, "a".repeat(64))).toBeNull();

    // User's key in the surviving shared workspace cascaded away.
    expect(keys.getHashedApiKeyByHashUnscoped(db, "b".repeat(64))).toBeNull();

    // Shared workspace survives; its connection persists with creator nulled.
    expect(db.get(`SELECT id FROM workspaces WHERE id = ?`, [sharedId]).id).toBe(sharedId);
    const sharedConn = db.get(`SELECT * FROM providerConnections WHERE id = 'conn-shared'`);
    expect(sharedConn.createdByUserId).toBeNull();

    // Shared service key survives, userId stays null, creator nulled, still eligible.
    const service = keys.getHashedApiKeyByHashUnscoped(db, "c".repeat(64));
    expect(service).toMatchObject({
      id: "k-service",
      userId: null,
      createdByUserId: null,
      revokedAt: null,
    });
    expect(
      keys.getEligibleApiKeySync(db, "k-service", { keyHash: "c".repeat(64), now: NOW }),
    ).not.toBeNull();

    expect(db.all(`PRAGMA foreign_key_check`)).toEqual([]);
  });
});
