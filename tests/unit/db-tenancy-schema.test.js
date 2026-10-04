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
    // 005 is inert on old data; 006 only stamps the new sortOrder column.
    const stripSort = (rows) => rows.map(({ sortOrder: _ignored, ...rest }) => rest);
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
});

describe("principal", () => {
  it("can() denies a missing principal and unknown capabilities", async () => {
    const { can } = await import("@/lib/users/principal.js");
    expect(can({ instanceRole: "owner" }, "instance.users.manage")).toBe(true);
    expect(can({ instanceRole: "owner" }, "x")).toBe(false);
    expect(can(null, "instance.users.manage")).toBe(false);
  });
});
