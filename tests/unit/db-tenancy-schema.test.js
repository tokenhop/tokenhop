// YAN-353: identity and tenancy tables (migration 004) and their repos —
// fresh and v1.0.0 upgrades, typed uniqueness errors, and every invariant.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const FIXTURE = fs.readFileSync(path.join(__dirname, "../fixtures/db/v1.0.0.sql"), "utf-8");
const NEW_TABLES = ["identities", "memberships", "users", "workspaces"];

const tables = (db) =>
  db
    .all(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${NEW_TABLES.map(() => "?").join(",")})`,
      NEW_TABLES,
    )
    .map((t) => t.name)
    .sort();

describe("migration 004 identity-tenancy", () => {
  it("adds the tables to a v1.0.0 DB without touching its data, idempotently", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
    const { runVersionedMigrations } = await import("@/lib/db/migrate.js");
    const m004 = (await import("@/lib/db/migrations/004-identity-tenancy.js")).default;
    const db = await createSqlJsAdapter(path.join(process.env.TOKENHOP_TEST_ROOT, "v1.sqlite"));
    db.exec(FIXTURE);
    const before = db.all(`SELECT * FROM combos ORDER BY id`);

    expect(runVersionedMigrations(db).to).toBeGreaterThanOrEqual(6);
    expect(tables(db)).toEqual(NEW_TABLES);
    // 005 is inert on old data; 006 only stamps the new sortOrder column; 009
    // rebuilds combos adding NULL workspaceId/createdByUserId.
    const stripSort = (rows) =>
      rows.map(({ sortOrder: _s, workspaceId: _w, createdByUserId: _c, ...rest }) => rest);
    expect(stripSort(db.all(`SELECT * FROM combos ORDER BY id`))).toEqual(stripSort(before));
    expect(db.get(`SELECT key FROM apiKeys`).key).toBe("sk-th-legacy");
    expect(db.get(`SELECT COUNT(*) AS c FROM users`).c).toBe(0);

    m004.up(db); // rerun after a restore: no-op
    expect(tables(db)).toEqual(NEW_TABLES);
    db.close();
  });

  it("fresh DB gets the tables through the app's own adapter", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    expect(tables(await getAdapter())).toEqual(NEW_TABLES);
  });
});

describe("tenancy repos", () => {
  let db;
  let repo;
  const ctxOf = (u) => ({
    userId: u.id,
    instanceRole: u.instanceRole,
    workspaceIds: [],
    activeWorkspaceId: null,
    via: "session",
  });
  const code = (p) => p.catch((e) => e.code);

  beforeEach(async () => {
    repo = await import("@/lib/db/index.js");
    db = await (await import("@/lib/db/driver.js")).getAdapter();
    for (const t of ["memberships", "identities", "workspaces", "users"])
      db.run(`DELETE FROM ${t}`);
  });

  it("creates a user with a personal workspace; never returns passwordHash", async () => {
    const u = await repo.createUserUnscoped({
      email: "a@x.io",
      instanceRole: "owner",
      passwordHash: "h",
    });
    expect(u).not.toHaveProperty("passwordHash");
    expect(u.sessionVersion).toBe(1);
    expect(await repo.getUserPasswordHashUnscoped(u.id)).toBe("h");
    const ws = await repo.listWorkspaces(ctxOf(u));
    expect(ws).toEqual([
      expect.objectContaining({ id: u.personalWorkspaceId, kind: "personal", role: "owner" }),
    ]);
    for (const row of await repo.listUsersUnscoped())
      expect(row).not.toHaveProperty("passwordHash");
  });

  it("uniqueness conflicts are typed errors", async () => {
    const a = await repo.createUserUnscoped({
      email: "A@x.io",
      username: "amy",
      instanceRole: "owner",
    });
    expect(await code(repo.createUserUnscoped({ email: "a@X.io" }))).toBe("EMAIL_TAKEN");
    expect(await code(repo.createUserUnscoped({ username: "AMY" }))).toBe("USERNAME_TAKEN");
    expect(await code(repo.createUserUnscoped({ instanceRole: "owner" }))).toBe("OWNER_EXISTS");
    expect(await code(repo.createUserUnscoped({ instanceRole: "root" }))).toBe("INVALID");

    const id = { provider: "oidc", issuer: "https://idp", subject: "s1" };
    await repo.linkIdentityUnscoped(a.id, id);
    const b = await repo.createUserUnscoped({});
    expect(await code(repo.linkIdentityUnscoped(b.id, id))).toBe("IDENTITY_TAKEN");
    // Same subject at another issuer is a different identity.
    await repo.linkIdentityUnscoped(b.id, { ...id, issuer: "https://other" });
    expect((await repo.findIdentityUnscoped(id)).userId).toBe(a.id);

    const ws = await repo.createSharedWorkspace(ctxOf(a), { name: "Home" });
    await repo.addMembership(ctxOf(a), ws.id, { userId: b.id });
    expect(await code(repo.addMembership(ctxOf(a), ws.id, { userId: b.id }))).toBe(
      "MEMBERSHIP_EXISTS",
    );
  });

  it("the owner can't be deleted, disabled or demoted; only transferred", async () => {
    const o = await repo.createUserUnscoped({ instanceRole: "owner" });
    const u = await repo.createUserUnscoped({ instanceRole: "user" });
    expect(await code(repo.deleteUserUnscoped(o.id))).toBe("OWNER_IMMUTABLE");
    expect(await code(repo.updateUserUnscoped(o.id, { status: "disabled" }))).toBe(
      "OWNER_IMMUTABLE",
    );
    expect(await code(repo.updateUserUnscoped(o.id, { instanceRole: "admin" }))).toBe(
      "OWNER_IMMUTABLE",
    );
    expect(await code(repo.updateUserUnscoped(u.id, { instanceRole: "owner" }))).toBe(
      "OWNER_IMMUTABLE",
    );
    expect(await code(repo.transferOwnership(ctxOf(u), u.id))).toBe("OWNER_IMMUTABLE");

    const pending = await repo.createUserUnscoped({});
    expect(await code(repo.transferOwnership(ctxOf(o), pending.id))).toBe("INVALID");

    const next = await repo.transferOwnership(ctxOf(o), u.id);
    expect(next).toMatchObject({ instanceRole: "owner", sessionVersion: 2 });
    expect(await repo.getUserUnscoped(o.id)).toMatchObject({
      instanceRole: "admin",
      sessionVersion: 2,
    });
    expect((await repo.getOwnerUnscoped()).id).toBe(u.id);
  });

  it("role, status and password changes bump sessionVersion; profile edits don't", async () => {
    const u = await repo.createUserUnscoped({ instanceRole: "user" });
    expect((await repo.updateUserUnscoped(u.id, { displayName: "U" })).sessionVersion).toBe(1);
    expect((await repo.updateUserUnscoped(u.id, { instanceRole: "user" })).sessionVersion).toBe(1);
    expect((await repo.updateUserUnscoped(u.id, { passwordHash: "x" })).sessionVersion).toBe(2);
    expect((await repo.updateUserUnscoped(u.id, { status: "disabled" })).sessionVersion).toBe(3);
  });

  it("a shared workspace keeps its last owner/manager", async () => {
    const a = await repo.createUserUnscoped({ instanceRole: "owner" });
    const b = await repo.createUserUnscoped({ instanceRole: "user" });
    const ws = await repo.createSharedWorkspace(ctxOf(a), { name: "Team" });
    await repo.addMembership(ctxOf(a), ws.id, { userId: b.id, role: "member" });

    expect(await code(repo.removeMembership(ctxOf(a), ws.id, a.id))).toBe("LAST_MANAGER");
    expect(await code(repo.updateMembershipRole(ctxOf(a), ws.id, a.id, "member"))).toBe(
      "LAST_MANAGER",
    );
    await repo.updateMembershipRole(ctxOf(a), ws.id, b.id, "manager");
    expect(await repo.removeMembership(ctxOf(a), ws.id, a.id)).toBe(true);
    expect(await code(repo.deleteUserUnscoped(b.id))).toBe("LAST_MANAGER");
  });

  it("personal workspaces take no members, can't be deleted, and go with their user", async () => {
    const a = await repo.createUserUnscoped({ instanceRole: "owner" });
    const b = await repo.createUserUnscoped({ instanceRole: "user" });
    const ws = a.personalWorkspaceId;
    expect(await code(repo.addMembership(ctxOf(a), ws, { userId: b.id }))).toBe(
      "PERSONAL_WORKSPACE",
    );
    expect(await code(repo.deleteWorkspace(ctxOf(a), ws))).toBe("PERSONAL_WORKSPACE");

    await repo.linkIdentityUnscoped(b.id, { provider: "saml", subject: "nameid" });
    expect(await repo.deleteUserUnscoped(b.id)).toBe(true);
    expect(
      db.get(`SELECT COUNT(*) AS c FROM workspaces WHERE id = ?`, [b.personalWorkspaceId]).c,
    ).toBe(0);
    expect(db.get(`SELECT COUNT(*) AS c FROM identities WHERE userId = ?`, [b.id]).c).toBe(0);
  });

  it("scoped reads and writes never reach another user's workspaces or identities", async () => {
    const a = await repo.createUserUnscoped({ instanceRole: "owner" });
    const b = await repo.createUserUnscoped({ instanceRole: "user" });
    const team = await repo.createSharedWorkspace(ctxOf(a), { name: "A team" });
    const ida = await repo.linkIdentityUnscoped(a.id, {
      provider: "oidc",
      issuer: "i",
      subject: "a",
    });
    const B = ctxOf(b);

    expect((await repo.listWorkspaces(B)).map((w) => w.id)).toEqual([b.personalWorkspaceId]);
    for (const id of [team.id, a.personalWorkspaceId]) {
      expect(await repo.getWorkspace(B, id)).toBeNull();
      expect(await code(repo.renameWorkspace(B, id, "x"))).toBe("NOT_FOUND");
      expect(await code(repo.deleteWorkspace(B, id))).toBe("NOT_FOUND");
      expect(await code(repo.listMemberships(B, id))).toBe("NOT_FOUND");
      expect(await code(repo.addMembership(B, id, { userId: b.id }))).toBe("NOT_FOUND");
      expect(await code(repo.removeMembership(B, id, a.id))).toBe("NOT_FOUND");
      expect(await code(repo.updateMembershipRole(B, id, a.id, "viewer"))).toBe("NOT_FOUND");
    }
    expect(await repo.getUser(B, a.id)).toBeNull();
    expect(await repo.listIdentities(B)).toEqual([]);
    expect(await repo.unlinkIdentity(B, ida.id)).toBe(false);
    expect(await code(repo.listWorkspaces(null))).toBe("INVALID");
    expect((await repo.listWorkspacesUnscoped()).length).toBe(3);
  });

  it("manual same-role write clears idp source with exactly one sv bump; repeat is a no-op (YAN-359)", async () => {
    const src = (id) => db.get(`SELECT instanceRoleSource AS s FROM users WHERE id = ?`, [id]).s;
    const u = await repo.createUserUnscoped({ email: "s@x.io", instanceRole: "admin" });
    expect(u).not.toHaveProperty("instanceRoleSource");
    db.run(`UPDATE users SET instanceRoleSource = 'idp' WHERE id = ?`, [u.id]);
    expect(src(u.id)).toBe("idp");

    const cleared = await repo.updateUserUnscoped(u.id, { instanceRole: "admin" });
    expect(cleared).not.toHaveProperty("instanceRoleSource");
    expect(cleared.sessionVersion).toBe(2);
    expect(src(u.id)).toBeNull();

    const again = await repo.updateUserUnscoped(u.id, { instanceRole: "admin" });
    expect(again.sessionVersion).toBe(2);
    expect(src(u.id)).toBeNull();
  });

  it("displayName patch preserves idp source and sessionVersion; real role change clears once (YAN-359)", async () => {
    const src = (id) => db.get(`SELECT instanceRoleSource AS s FROM users WHERE id = ?`, [id]).s;
    const u = await repo.createUserUnscoped({ email: "p@x.io", instanceRole: "user" });
    db.run(`UPDATE users SET instanceRoleSource = 'idp' WHERE id = ?`, [u.id]);

    const kept = await repo.updateUserUnscoped(u.id, { displayName: "P" });
    expect(kept).not.toHaveProperty("instanceRoleSource");
    expect(kept.sessionVersion).toBe(1);
    expect(kept.displayName).toBe("P");
    expect(src(u.id)).toBe("idp");

    const moved = await repo.updateUserUnscoped(u.id, { instanceRole: "admin" });
    expect(moved.sessionVersion).toBe(2);
    expect(src(u.id)).toBeNull();
  });

  it("public user reads never expose instanceRoleSource (YAN-359)", async () => {
    const u = await repo.createUserUnscoped({ email: "h@x.io", instanceRole: "admin" });
    db.run(`UPDATE users SET instanceRoleSource = 'idp' WHERE id = ?`, [u.id]);
    expect(u).not.toHaveProperty("instanceRoleSource");
    expect(await repo.getUserUnscoped(u.id)).not.toHaveProperty("instanceRoleSource");
    expect(await repo.getUser(ctxOf(u), u.id)).not.toHaveProperty("instanceRoleSource");
    expect(await repo.updateUserUnscoped(u.id, { displayName: "H" })).not.toHaveProperty(
      "instanceRoleSource",
    );
    for (const row of await repo.listUsersUnscoped())
      expect(row).not.toHaveProperty("instanceRoleSource");
  });

  it("ownership transfer clears idp source on both rows (YAN-359)", async () => {
    const src = (id) => db.get(`SELECT instanceRoleSource AS s FROM users WHERE id = ?`, [id]).s;
    const o = await repo.createUserUnscoped({ instanceRole: "owner" });
    const u = await repo.createUserUnscoped({ instanceRole: "user" });
    db.run(`UPDATE users SET instanceRoleSource = 'idp' WHERE id IN (?, ?)`, [o.id, u.id]);

    const next = await repo.transferOwnership(ctxOf(o), u.id);
    expect(next).not.toHaveProperty("instanceRoleSource");
    expect(next).toMatchObject({ instanceRole: "owner", sessionVersion: 2 });
    expect(src(o.id)).toBeNull();
    expect(src(u.id)).toBeNull();
    expect(await repo.getUserUnscoped(o.id)).toMatchObject({
      instanceRole: "admin",
      sessionVersion: 2,
    });
  });

  it("sync user+identity inserts roll back together when the tx throws (YAN-359)", async () => {
    const { createUserWithPersonalWorkspaceSync } = await import("@/lib/db/repos/usersRepo.js");
    const { insertIdentitySync } = await import("@/lib/db/repos/identitiesRepo.js");
    const count = (t) => db.get(`SELECT COUNT(*) AS c FROM ${t}`).c;
    const before = {
      users: count("users"),
      workspaces: count("workspaces"),
      memberships: count("memberships"),
      identities: count("identities"),
    };
    expect(() =>
      db.transaction(() => {
        const created = createUserWithPersonalWorkspaceSync(db, {
          email: "r@x.io",
          instanceRole: "user",
        });
        insertIdentitySync(db, created.id, {
          provider: "oidc",
          issuer: "https://idp",
          subject: "rollback-1",
        });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect({
      users: count("users"),
      workspaces: count("workspaces"),
      memberships: count("memberships"),
      identities: count("identities"),
    }).toEqual(before);
  });

  it("syncIdpMembershipsSync reconciles idp rows only, validating before any write (YAN-359)", async () => {
    const { syncIdpMembershipsSync, addMembershipUnscoped } = await import(
      "@/lib/db/repos/membershipsRepo.js"
    );
    const syncCode = (fn) => {
      try {
        return fn() && null;
      } catch (e) {
        return e.code;
      }
    };
    const a = await repo.createUserUnscoped({ instanceRole: "owner" });
    const u = await repo.createUserUnscoped({ instanceRole: "user" });
    const t1 = await repo.createSharedWorkspace(ctxOf(a), { name: "T1" });
    const t2 = await repo.createSharedWorkspace(ctxOf(a), { name: "T2" });
    const t3 = await repo.createSharedWorkspace(ctxOf(a), { name: "T3" });
    const row = (ws) =>
      db.get(`SELECT role, source FROM memberships WHERE workspaceId = ? AND userId = ?`, [
        ws.id,
        u.id,
      ]);

    // add
    expect(
      syncIdpMembershipsSync(db, u.id, [
        { workspaceId: t1.id, role: "member" },
        { workspaceId: t2.id, role: "manager" },
      ]),
    ).toEqual({
      changed: true,
      added: [
        { workspaceId: t1.id, role: "member" },
        { workspaceId: t2.id, role: "manager" },
      ],
      updated: [],
      removed: [],
    });
    expect(row(t1)).toEqual({ role: "member", source: "idp" });

    // update + remove; a wanted idp grant onto an existing invite row never
    // overwrites or re-sources it.
    db.transaction(() =>
      addMembershipUnscoped(db, {
        workspaceId: t3.id,
        userId: u.id,
        role: "viewer",
        source: "invite",
      }),
    );
    expect(
      syncIdpMembershipsSync(db, u.id, [
        { workspaceId: t1.id, role: "viewer" },
        { workspaceId: t3.id, role: "manager" },
      ]),
    ).toEqual({
      changed: true,
      added: [],
      updated: [{ workspaceId: t1.id, before: "member", after: "viewer" }],
      removed: [{ workspaceId: t2.id, role: "manager" }],
    });
    expect(row(t1)).toEqual({ role: "viewer", source: "idp" });
    expect(row(t3)).toEqual({ role: "viewer", source: "invite" });
    // t2 dropped, t1 kept, t3 invite untouched (+1 personal owner row = 3 total)
    expect(db.get(`SELECT COUNT(*) AS c FROM memberships WHERE userId = ?`, [u.id]).c).toBe(3);

    // idempotent no-op
    expect(syncIdpMembershipsSync(db, u.id, [{ workspaceId: t1.id, role: "viewer" }])).toEqual({
      changed: false,
      added: [],
      updated: [],
      removed: [],
    });

    // invalid inputs throw before writing anything
    const invalid = [
      () =>
        syncIdpMembershipsSync(db, u.id, [{ workspaceId: u.personalWorkspaceId, role: "member" }]),
      () => syncIdpMembershipsSync(db, u.id, [{ workspaceId: "ws_missing", role: "member" }]),
      () => syncIdpMembershipsSync(db, u.id, [{ workspaceId: t1.id, role: "owner" }]),
      () => syncIdpMembershipsSync(db, u.id, [{ workspaceId: t1.id }, { role: "member" }]),
      () =>
        syncIdpMembershipsSync(db, u.id, [
          { workspaceId: t1.id, role: "member" },
          { workspaceId: t1.id, role: "viewer" },
        ]),
      () => syncIdpMembershipsSync(db, "ghost", []),
      () => syncIdpMembershipsSync(db, u.id, null),
    ];
    for (const fn of invalid) expect(syncCode(fn)).toBe("INVALID");
    expect(row(t1)).toEqual({ role: "viewer", source: "idp" });
  });

  it("syncIdpMembershipsSync LAST_MANAGER aborts removal and demotion, rolling back the caller tx (YAN-359)", async () => {
    const { syncIdpMembershipsSync } = await import("@/lib/db/repos/membershipsRepo.js");
    const a = await repo.createUserUnscoped({ instanceRole: "owner" });
    const u = await repo.createUserUnscoped({ instanceRole: "user" });
    await repo.updateUserUnscoped(u.id, { displayName: "Was" });
    const solo = await repo.createSharedWorkspace(ctxOf(a), { name: "Solo" });
    const other = await repo.createSharedWorkspace(ctxOf(a), { name: "Other" });
    syncIdpMembershipsSync(db, u.id, [
      { workspaceId: solo.id, role: "manager" },
      { workspaceId: other.id, role: "member" },
    ]);
    // make u the sole manager of solo (creator row dropped directly, bypassing the guard)
    db.run(`DELETE FROM memberships WHERE workspaceId = ? AND userId = ?`, [solo.id, a.id]);

    // removal of the sole manager throws inside the caller's tx; earlier writes die with it
    expect(() =>
      db.transaction(() => {
        db.run(`UPDATE users SET displayName = 'X' WHERE id = ?`, [u.id]);
        syncIdpMembershipsSync(db, u.id, [{ workspaceId: other.id, role: "member" }]);
      }),
    ).toThrow("A workspace needs at least one owner or manager");
    expect(db.get(`SELECT displayName FROM users WHERE id = ?`, [u.id]).displayName).toBe("Was");
    expect(
      db.get(`SELECT role, source FROM memberships WHERE workspaceId = ? AND userId = ?`, [
        solo.id,
        u.id,
      ]),
    ).toEqual({ role: "manager", source: "idp" });

    // demotion of the sole manager is blocked too
    expect(() =>
      syncIdpMembershipsSync(db, u.id, [
        { workspaceId: solo.id, role: "viewer" },
        { workspaceId: other.id, role: "member" },
      ]),
    ).toThrow("A workspace needs at least one owner or manager");

    // a second manager makes both removal and demotion fine again
    const b = await repo.createUserUnscoped({ instanceRole: "user" });
    syncIdpMembershipsSync(db, b.id, [{ workspaceId: solo.id, role: "manager" }]);
    expect(syncIdpMembershipsSync(db, u.id, [{ workspaceId: other.id, role: "member" }])).toEqual({
      changed: true,
      added: [],
      updated: [],
      removed: [{ workspaceId: solo.id, role: "manager" }],
    });
  });
});

describe("principal", () => {
  it("can() denies a missing principal and unknown capabilities", async () => {
    const { can } = await import("@/lib/users/principal.js");
    expect(can({ instanceRole: "owner" }, "instance.users.manage")).toBe(true);
    expect(can({ instanceRole: "owner" }, "x")).toBe(false);
    expect(can(null, "instance.users.manage")).toBe(false);
  });
});

// YAN-359: losing an IdP membership revokes that user's keys in that workspace
// only. Own sql.js DB: the hashed apiKeys shape must not leak into other tests.
describe("syncIdpMembershipsSync key revocation", () => {
  it("revokes the user's keys in the removed workspace only; demotion and service keys untouched", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
    const { runVersionedMigrations } = await import("@/lib/db/migrate.js");
    const { HASHED_API_KEYS_TABLE, buildCreateTableSql } = await import("@/lib/db/schema.js");
    const { createUserWithPersonalWorkspaceSync } = await import("@/lib/db/repos/usersRepo.js");
    const { syncIdpMembershipsSync } = await import("@/lib/db/repos/membershipsRepo.js");
    const db = await createSqlJsAdapter(path.join(process.env.TOKENHOP_TEST_ROOT, "revoke.sqlite"));
    runVersionedMigrations(db);
    db.exec(`DROP TABLE apiKeys; ${buildCreateTableSql("apiKeys", HASHED_API_KEYS_TABLE)}`);
    const kid = "0123456789abcdef";
    db.run(
      `INSERT INTO _meta(key, value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)`,
      [kid],
    );

    const now = new Date().toISOString();
    const u = createUserWithPersonalWorkspaceSync(db, { email: "u@x.io", instanceRole: "user" });
    for (const ws of ["ws-a", "ws-b"]) {
      db.run(
        `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES(?, ?, 'shared', NULL, ?, ?)`,
        [ws, ws, now, now],
      );
    }
    const key = (id, workspaceId, userId) =>
      db.run(
        `INSERT INTO apiKeys(id, workspaceId, userId, keyHash, hashKid, prefix, createdAt) VALUES(?, ?, ?, ?, ?, 'th_', ?)`,
        [id, workspaceId, userId, `hash-${id}`, kid, now],
      );
    syncIdpMembershipsSync(db, u.id, [
      { workspaceId: "ws-a", role: "manager" },
      { workspaceId: "ws-b", role: "member" },
    ]);
    key("k-a", "ws-a", u.id);
    key("k-b", "ws-b", u.id);
    key("k-svc", "ws-a", null);
    const revoked = (id) => db.get(`SELECT revokedAt FROM apiKeys WHERE id = ?`, [id]).revokedAt;

    // Demotion keeps the membership, so no key is revoked. A second manager
    // makes the demotion legal.
    const other = createUserWithPersonalWorkspaceSync(db, {
      email: "o@x.io",
      instanceRole: "user",
    });
    db.run(
      `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES('ws-a', ?, 'manager', 'manual', ?)`,
      [other.id, now],
    );
    syncIdpMembershipsSync(db, u.id, [
      { workspaceId: "ws-a", role: "viewer" },
      { workspaceId: "ws-b", role: "member" },
    ]);
    expect(revoked("k-a")).toBeNull();

    const delta = syncIdpMembershipsSync(db, u.id, [{ workspaceId: "ws-b", role: "member" }]);
    expect(delta.removed).toHaveLength(1);
    expect(revoked("k-a")).not.toBeNull();
    expect(revoked("k-b")).toBeNull();
    expect(revoked("k-svc")).toBeNull();
    db.close();
  });
});
