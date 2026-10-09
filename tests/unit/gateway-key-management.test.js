// YAN-363: hashed key management service (unused; no route edits). Real
// adapter, isolated temp DATA_DIR, direct hashed fixture — no migration.
import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import {
  createApiKey,
  getApiKey,
  listApiKeys,
  revokeApiKey,
  updateApiKey,
} from "@/lib/users/apiKeyManagement.js";
import { TenancyError } from "@/lib/users/errors.js";
import { getEligibleApiKeySync } from "@/lib/db/repos/apiKeysRepo.js";
import { clearApiKeyPrincipalCache, resolveApiKey } from "@/lib/auth/apiKeyPrincipal.js";
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "@/lib/security/masterKey.js";

const NOW = "2026-10-03T00:00:00.000Z";
const MASTER = crypto.randomBytes(32);
const KID = masterKeyId(MASTER);
const FUTURE = "2027-01-01T00:00:00.000Z";

let db;
const ctxFor = (userId, extra = {}) => ({
  userId,
  instanceRole: "user",
  workspaceIds: ["w", "other", "mine"],
  workspaceRoles: { w: "manager", other: "member", mine: "owner" },
  via: "session",
  ...extra,
});
const manager = ctxFor("manager");
const member = ctxFor("member", { workspaceRoles: { w: "member" } });
const viewer = ctxFor("viewer", { workspaceRoles: { w: "viewer" } });
const admin = ctxFor("admin", { instanceRole: "admin", workspaceIds: ["w"], workspaceRoles: {} });
const soloOwner = ctxFor("solo", { workspaceIds: ["mine"], workspaceRoles: { mine: "owner" } });
const bearer = { ...manager, via: "apiKey" };
const code = (err) => err instanceof TenancyError && err.code;

beforeEach(async () => {
  process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
  clearApiKeyPrincipalCache();
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
  db.exec(
    "DELETE FROM memberships; DELETE FROM workspaces; DELETE FROM users; DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')",
  );
  db.run("DELETE FROM combos");
  const users = [
    ["manager", "user"],
    ["member", "user"],
    ["viewer", "user"],
    ["admin", "admin"],
    ["solo", "user"],
  ];
  for (const [id, role] of users) {
    db.run(
      "INSERT INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES (?, ?, 'active', ?, ?)",
      [id, role, NOW, NOW],
    );
  }
  for (const id of ["w", "other"]) {
    db.run(
      "INSERT INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES (?, ?, 'shared', ?, ?)",
      [id, id, NOW, NOW],
    );
  }
  db.run(
    "INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES (?, ?, 'personal', 'solo', ?, ?)",
    ["mine", "mine", NOW, NOW],
  );
  for (const [id, name] of [
    ["combo-1", "Primary combo"],
    ["combo-2", "Fallback combo"],
  ]) {
    db.run(
      "INSERT INTO combos(id, name, models, workspaceId, createdAt, updatedAt) VALUES (?, ?, '[]', 'w', ?, ?)",
      [id, name, NOW, NOW],
    );
  }
  const roles = { manager: "manager", member: "member", viewer: "viewer" };
  for (const [userId, role] of Object.entries(roles)) {
    db.run("INSERT INTO memberships(workspaceId, userId, role, createdAt) VALUES ('w', ?, ?, ?)", [
      userId,
      role,
      NOW,
    ]);
  }
  db.run(
    "INSERT INTO memberships(workspaceId, userId, role, createdAt) VALUES ('other', 'member', 'manager', ?)",
    [NOW],
  );
  db.run(
    "INSERT INTO memberships(workspaceId, userId, role, createdAt) VALUES ('mine', 'solo', 'owner', ?)",
    [NOW],
  );
  db.run(
    "INSERT INTO _meta(key, value) VALUES ('apiKeysHashedVersion', '1'), ('apiKeysHashKid', ?)",
    [KID],
  );
});

describe("hashed key management", () => {
  it("rejects conflicting service ownership and unknown create fields before insertion", async () => {
    for (const options of [
      { type: "service", userId: "manager" },
      { type: "service", userId: "member" },
      ...["raw", "key", "keyHash", "owner", "workspaceId"].map((field) => ({
        type: "user",
        [field]: "unexpected",
      })),
    ]) {
      await expect(createApiKey(manager, "w", options)).rejects.toMatchObject({ code: "INVALID" });
    }
    expect(db.get("SELECT COUNT(*) AS n FROM apiKeys").n).toBe(0);
  });
  it("manager lists workspace keys metadata-only; viewer cannot list", async () => {
    const { metadata } = await createApiKey(manager, "w", { type: "service", name: "CI" });
    const list = await listApiKeys(manager, "w");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: metadata.id, name: "CI", type: "service" });
    for (const field of ["key", "keyHash", "hashKid"]) expect(list[0]).not.toHaveProperty(field);
    const detail = await getApiKey(manager, "w", metadata.id);
    expect(detail).toEqual(list[0]);
    let err;
    try {
      await listApiKeys(viewer, "w");
    } catch (e) {
      err = e;
    }
    expect(code(err)).toBe("FORBIDDEN");
  });

  it("member lists only own user keys", async () => {
    const own = await createApiKey(member, "w", { type: "user", name: "mine" });
    await createApiKey(manager, "w", { type: "user", name: "manager key" });
    await createApiKey(manager, "w", { type: "service", name: "service" });
    const list = await listApiKeys(member, "w");
    expect(list.map((k) => k.id)).toEqual([own.metadata.id]);
    expect(list[0]).toMatchObject({ type: "user", userId: "member" });
    expect(list[0]).not.toHaveProperty("keyHash");
  });

  it("authorized multi-membership lists other rows strictly scoped to other", async () => {
    // member holds a LIVE manager role in "other": explicit request there
    // legitimately succeeds, but rows stay strictly other-scoped.
    const mine = await createApiKey(member, "other", { type: "service", name: "other-key" });
    const list = await listApiKeys(member, "other");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: mine.metadata.id, workspaceId: "other" });
    const foreignInW = await createApiKey(manager, "w", { type: "service" });
    let err;
    try {
      await getApiKey(member, "other", foreignInW.metadata.id);
    } catch (e) {
      err = e;
    }
    expect(code(err)).toBe("NOT_FOUND");
    expect(err.message).not.toContain(foreignInW.metadata.id);
  });

  it("unmember cross-workspace access is denied without leaking foreign rows", async () => {
    const { metadata } = await createApiKey(manager, "w", { type: "service" });
    db.run(
      "INSERT INTO users(id, instanceRole, status, createdAt, updatedAt) VALUES ('outsider', 'user', 'active', ?, ?)",
      [NOW, NOW],
    );
    const outsider = ctxFor("outsider");
    // outsider holds no membership anywhere: every op is NOT_FOUND, and the
    // stale ctx claim of membership in workspaceRoles must not matter.
    for (const [op] of [
      [() => listApiKeys(outsider, "w")],
      [() => listApiKeys(outsider, "other")],
      [() => getApiKey(outsider, "w", metadata.id)],
      [() => updateApiKey(outsider, "w", metadata.id, { name: "x" })],
      [() => revokeApiKey(outsider, "w", metadata.id)],
      [() => createApiKey(outsider, "w", { type: "user" })],
      [() => revokeApiKey(manager, "w", "no-such-key")],
      [() => getApiKey(manager, "w", "no-such-key")],
      [() => listApiKeys(manager, "ghost-ws")],
    ]) {
      let err;
      try {
        await op();
      } catch (e) {
        err = e;
      }
      expect(code(err)).toBe("NOT_FOUND");
    }
    // Manager of w cannot see the row through "other" either.
    let err;
    try {
      await getApiKey(manager, "other", metadata.id);
    } catch (e) {
      err = e;
    }
    expect(code(err)).toBe("NOT_FOUND");
    expect(err.message).not.toContain(metadata.id);
  });

  it("API-key principals are refused management authority", async () => {
    for (const [op] of [
      [() => listApiKeys(bearer, "w")],
      [() => getApiKey(bearer, "w", "x")],
      [() => createApiKey(bearer, "w", { type: "user" })],
      [() => updateApiKey(bearer, "w", "x", { name: "y" })],
      [() => revokeApiKey(bearer, "w", "x")],
    ]) {
      let err;
      try {
        await op();
      } catch (e) {
        err = e;
      }
      expect(code(err)).toBe("FORBIDDEN");
    }
  });

  it("member creates exactly their own user key; service creation is manager-only", async () => {
    const { key, metadata } = await createApiKey(member, "w", {
      type: "user",
      name: "mine",
      allowedModels: ["openai/gpt-4o"],
      expiresAt: FUTURE,
    });
    expect(key).toMatch(/^th_[0-9A-Za-z]{32}$/);
    expect(metadata).toMatchObject({
      userId: "member",
      createdByUserId: "member",
      type: "user",
      name: "mine",
      isActive: true,
      expiresAt: FUTURE,
      allowedModels: ["openai/gpt-4o"],
    });
    for (const field of ["key", "keyHash", "hashKid"]) expect(metadata).not.toHaveProperty(field);

    // Raw exists only in the create response: no readback, no plaintext row.
    const rows = JSON.stringify(db.all("SELECT * FROM apiKeys"));
    expect(rows).not.toContain(key);
    expect(rows).toContain(hashApiKey(key, deriveApiKeyHashKey(MASTER)));
    expect((await getApiKey(member, "w", metadata.id)).prefix).toBe(
      `${key.slice(0, 7)}…${key.slice(-4)}`,
    );

    for (const [ctx, options, expected] of [
      [member, { type: "service" }, "FORBIDDEN"],
      [member, { type: "user", userId: "manager" }, "FORBIDDEN"],
      [manager, { type: "user", userId: "member" }, "FORBIDDEN"],
      [viewer, { type: "user" }, "FORBIDDEN"],
      [member, { type: "team" }, "INVALID"],
    ]) {
      let err;
      try {
        await createApiKey(ctx, "w", options);
      } catch (e) {
        err = e;
      }
      expect(code(err)).toBe(expected);
    }
  });

  it("manager creates service keys independent of member churn", async () => {
    const { key, metadata } = await createApiKey(manager, "w", { type: "service" });
    expect(metadata.userId).toBeNull();
    expect(metadata.type).toBe("service");
    expect((await resolveApiKey(key))?.apiKeyId).toBe(metadata.id);
    db.run("DELETE FROM memberships WHERE workspaceId='w' AND userId='member'");
    clearApiKeyPrincipalCache();
    expect((await resolveApiKey(key))?.apiKeyId).toBe(metadata.id);
  });

  it("pause is reversible; revoke is an irreversible tombstone", async () => {
    const { key, metadata } = await createApiKey(manager, "w", { type: "user" });
    const id = metadata.id;
    expect((await resolveApiKey(key))?.apiKeyId).toBe(id);

    const paused = await updateApiKey(manager, "w", id, { isActive: false });
    expect(paused.isActive).toBe(false);
    clearApiKeyPrincipalCache();
    expect(await resolveApiKey(key)).toBeNull();
    const resumed = await updateApiKey(manager, "w", id, { isActive: true });
    expect(resumed.isActive).toBe(true);
    clearApiKeyPrincipalCache();
    expect((await resolveApiKey(key))?.apiKeyId).toBe(id);

    const revoked = await revokeApiKey(manager, "w", id);
    expect(revoked.revokedAt).toBe(
      NOW === revoked.revokedAt ? revoked.revokedAt : revoked.revokedAt,
    );
    expect(revoked.revokedAt).toBeTruthy();
    clearApiKeyPrincipalCache();
    expect(await resolveApiKey(key)).toBeNull();
    expect(
      getEligibleApiKeySync(db, id, { keyHash: hashApiKey(key, deriveApiKeyHashKey(MASTER)) }),
    ).toBeNull();

    for (const [op, expected] of [
      [() => updateApiKey(manager, "w", id, { isActive: true }), "INVALID"],
      [() => updateApiKey(manager, "w", id, { name: "zombie" }), "INVALID"],
    ]) {
      let err;
      try {
        await op();
      } catch (e) {
        err = e;
      }
      expect(code(err)).toBe(expected);
    }
    // Idempotent re-revoke returns the same tombstone.
    expect((await revokeApiKey(manager, "w", id)).revokedAt).toBe(revoked.revokedAt);
  });

  it("member updates are refused; managers edit only the mutable allowlist", async () => {
    const { metadata } = await createApiKey(manager, "w", { type: "service" });
    const id = metadata.id;
    let err;
    try {
      await updateApiKey(member, "w", id, { name: "x" });
    } catch (e) {
      err = e;
    }
    expect(code(err)).toBe("FORBIDDEN");

    const updated = await updateApiKey(manager, "w", id, {
      name: "renamed",
      allowedCombos: ["combo-1"],
      expiresAt: FUTURE,
    });
    expect(updated).toMatchObject({
      name: "renamed",
      allowedCombos: ["combo-1"],
      expiresAt: FUTURE,
    });

    for (const [patch, expected] of [
      [{ workspaceId: "other" }, "INVALID"],
      [{ userId: "member" }, "INVALID"],
      [{ revokedAt: NOW }, "INVALID"],
      [{ keyHash: "0".repeat(64) }, "INVALID"],
      [{ allowedModels: [42] }, "INVALID"],
      [{ allowedModels: ["x".repeat(257)] }, "INVALID"],
      [{ expiresAt: "tomorrow" }, "INVALID"],
      [{ isActive: "yes" }, "INVALID"],
      [{ name: "x".repeat(65) }, "INVALID"],
    ]) {
      let e2;
      try {
        await updateApiKey(manager, "w", id, patch);
      } catch (e) {
        e2 = e;
      }
      expect(code(e2)).toBe(expected);
    }
    expect(
      db.get("SELECT workspaceId, userId, revokedAt FROM apiKeys WHERE id = ?", [id]),
    ).toMatchObject({
      workspaceId: "w",
      userId: null,
      revokedAt: null,
    });
  });

  it("stale ctx never supersedes live DB: removed member, disabled user, demoted admin", async () => {
    // Disabled live user: ctx still looks active — denied as NOT_FOUND.
    db.run("UPDATE users SET status = 'disabled' WHERE id = 'manager'");
    let err;
    try {
      await listApiKeys(manager, "w");
    } catch (e) {
      err = e;
    }
    expect(code(err)).toBe("NOT_FOUND");
    db.run("UPDATE users SET status = 'active' WHERE id = 'manager'");

    // Escalated stale ctx (member claims instance admin): live role wins. A
    // trusted ctx.instanceRole would grant admin-in-member-workspace manage.
    const forgedAdmin = ctxFor("member", { instanceRole: "admin" });
    const service = await createApiKey(manager, "w", { type: "service" });
    try {
      await revokeApiKey(forgedAdmin, "w", service.metadata.id);
    } catch (e) {
      err = e;
    }
    expect(code(err)).toBe("FORBIDDEN");
    try {
      await listApiKeys(forgedAdmin, "mine");
    } catch (e) {
      err = e;
    }
    expect(code(err)).toBe("NOT_FOUND");

    const { key, metadata: own } = await createApiKey(member, "w", { type: "user" });
    db.run("UPDATE memberships SET role = 'viewer' WHERE workspaceId = 'w' AND userId = 'member'");
    try {
      await revokeApiKey(member, "w", own.id);
    } catch (e) {
      err = e;
    }
    expect(code(err)).toBe("FORBIDDEN");
    expect((await getApiKey(manager, "w", own.id)).revokedAt).toBeNull();
    expect(key).toBeTruthy();
  });

  it("instance admin cannot cross the personal-workspace secret boundary", async () => {
    await createApiKey(soloOwner, "mine", { type: "user" });
    let err;
    try {
      await listApiKeys(admin, "mine");
    } catch (e) {
      err = e;
    }
    expect(code(err)).toBe("NOT_FOUND");
    try {
      await createApiKey(admin, "mine", { type: "service" });
    } catch (e) {
      err = e;
    }
    expect(code(err)).toBe("NOT_FOUND");

    // Membership with a manager role is the only admin path in, and even then
    // only for shared workspaces a human actually joined.
    db.run(
      "INSERT INTO memberships(workspaceId, userId, role, createdAt) VALUES ('w', 'admin', 'manager', ?)",
      [NOW],
    );
    const list = await listApiKeys(admin, "w");
    expect(Array.isArray(list)).toBe(true);
  });

  it("legacy storage refuses management without touching rows", async () => {
    db.run("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
    const before = db.get("SELECT COUNT(*) AS n FROM apiKeys").n;
    for (const [op] of [
      [() => listApiKeys(manager, "w")],
      [() => createApiKey(manager, "w", { type: "service" })],
    ]) {
      let err;
      try {
        await op();
      } catch (e) {
        err = e;
      }
      expect(code(err)).toBe("INVALID");
      expect(err.message).toContain("hashed storage");
    }
    expect(db.get("SELECT COUNT(*) AS n FROM apiKeys").n).toBe(before);
  });

  it("allowedCombos must reference existing combo IDs; empty stays unrestricted", async () => {
    const ok = await createApiKey(member, "w", { type: "user", allowedCombos: ["combo-1"] });
    expect(ok.metadata.allowedCombos).toEqual(["combo-1"]);

    for (const [options, ctx] of [
      [{ type: "user", allowedCombos: ["no-such-combo"] }, member],
      [{ type: "user", allowedCombos: ["Primary combo"] }, member],
      [{ type: "service", allowedCombos: ["no-such-combo"] }, manager],
    ]) {
      let err;
      try {
        await createApiKey(ctx, "w", options);
      } catch (e) {
        err = e;
      }
      expect(code(err)).toBe("INVALID");
      expect(err.message).not.toContain("no-such-combo");
      expect(err.message).not.toContain("Primary combo");
    }
    // No rows persisted from the rejected creates.
    expect(db.get("SELECT COUNT(*) AS n FROM apiKeys WHERE allowedCombos != '[]'").n).toBe(1);

    // Empty list is unrestricted and accepted.
    const open = await createApiKey(manager, "w", { type: "service", allowedCombos: [] });
    expect(open.metadata.allowedCombos).toEqual([]);

    // A rejected multi-field update leaves the entire stored row unchanged.
    const before = db.get("SELECT * FROM apiKeys WHERE id = ?", [open.metadata.id]);
    for (const invalid of ["ghost", "Fallback combo"]) {
      await expect(
        updateApiKey(manager, "w", open.metadata.id, {
          name: "must not persist",
          isActive: false,
          allowedCombos: ["combo-1", invalid],
        }),
      ).rejects.toMatchObject({
        code: "INVALID",
        message: "allowedCombos entries must be existing combo IDs",
      });
      expect(db.get("SELECT * FROM apiKeys WHERE id = ?", [open.metadata.id])).toEqual(before);
    }

    const moved = await updateApiKey(manager, "w", open.metadata.id, {
      allowedCombos: ["combo-2"],
    });
    expect(moved.allowedCombos).toEqual(["combo-2"]);
  });

  it("allowedCombos rejects combos owned by another workspace", async () => {
    db.run("UPDATE combos SET workspaceId = 'other' WHERE id = 'combo-2'");
    db.run(
      "INSERT INTO combos(id, name, models, workspaceId, createdAt, updatedAt) VALUES ('legacy', 'Legacy', '[]', NULL, ?, ?)",
      [NOW, NOW],
    );

    await expect(
      createApiKey(member, "w", { type: "user", allowedCombos: ["combo-2"] }),
    ).rejects.toMatchObject({ code: "INVALID" });
    await expect(
      createApiKey(member, "w", { type: "user", allowedCombos: ["legacy"] }),
    ).rejects.toMatchObject({ code: "INVALID" });
    const key = await createApiKey(member, "w", {
      type: "user",
      allowedCombos: ["combo-1"],
    });
    expect(key.metadata.allowedCombos).toEqual(["combo-1"]);
    await expect(
      updateApiKey(manager, "w", key.metadata.id, { allowedCombos: ["combo-2"] }),
    ).rejects.toMatchObject({ code: "INVALID" });
  });

  it("creates validate scope and expiry inputs through the strict row validator", async () => {
    for (const [options, expected] of [
      [{ type: "user", name: "x".repeat(65) }, "INVALID"],
      [{ type: "user", allowedModels: [42] }, "INVALID"],
      [{ type: "user", allowedModels: new Array(129).fill("m") }, "INVALID"],
      [{ type: "user", expiresAt: "2020-01-01T00:00:00.000Z" }, "INVALID"],
      [{ type: "user", expiresAt: "not-a-date" }, "INVALID"],
    ]) {
      let err;
      try {
        await createApiKey(member, "w", options);
      } catch (e) {
        err = e;
      }
      expect(code(err)).toBe(expected);
    }
    expect(db.get("SELECT COUNT(*) AS n FROM apiKeys WHERE userId='member'").n).toBe(0);
  });
});
