// Task 1.2: usersRepo.listUsersPageUnscoped — SQL LIMIT/OFFSET pagination,
// safe DTO projection, and updateUserUnscoped role/status allow-lists.
import { beforeEach, describe, expect, it } from "vitest";

let repo;
let db;

const seed = async (n) => {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push(
      await repo.createUserUnscoped({
        email: `u${i}@x.io`,
        instanceRole: "user",
        passwordHash: "h",
      }),
    );
  }
  return out;
};

const code = (p) => p.catch((e) => e.code);

describe("listUsersPageUnscoped", () => {
  beforeEach(async () => {
    repo = await import("@/lib/db/repos/usersRepo.js");
    db = await (await import("@/lib/db/driver.js")).getAdapter();
    for (const t of ["memberships", "identities", "workspaces", "users"])
      db.run(`DELETE FROM ${t}`);
  });

  it("clamps garbage page/pageSize and never returns a page beyond the data", async () => {
    await seed(3);
    const def = await repo.listUsersPageUnscoped({ page: 0, pageSize: 0 });
    expect(def.pagination).toEqual({ page: 1, pageSize: 50, totalItems: 3, totalPages: 1 });
    expect(def.users).toHaveLength(3);

    // Garbage → default 50; negatives clamp to the 1..100 floor.
    for (const bad of [0, NaN, "x", null, undefined, {}]) {
      const r = await repo.listUsersPageUnscoped({ page: bad, pageSize: bad });
      expect(r.pagination.page).toBe(1);
      expect(r.pagination.pageSize).toBe(50);
    }
    expect((await repo.listUsersPageUnscoped({ page: -5, pageSize: -5 })).pagination).toEqual(
      expect.objectContaining({ page: 1, pageSize: 1 }),
    );
    // Valid numbers pass through (only clamped, never defaulted).
    expect((await repo.listUsersPageUnscoped({ page: 2, pageSize: 2.7 })).pagination.pageSize).toBe(
      2,
    );
    const huge = await repo.listUsersPageUnscoped({ pageSize: 10_000 });
    expect(huge.pagination.pageSize).toBe(100);
  });

  it("pages stably by createdAt,id with no overlap", async () => {
    const seeded = await seed(5);
    const seen = [];
    for (const page of [1, 2, 3]) {
      const r = await repo.listUsersPageUnscoped({ page, pageSize: 2 });
      expect(r.pagination.totalItems).toBe(5);
      expect(r.pagination.totalPages).toBe(3);
      seen.push(...r.users.map((u) => u.id));
    }
    const expected = seeded
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : 1))
      .map((u) => u.id);
    expect(seen).toEqual(expected);
    const empty = await repo.listUsersPageUnscoped({ page: 4, pageSize: 2 });
    expect(empty.users).toEqual([]);
  });

  it("projects a safe DTO: no passwordHash, sessionVersion or instanceRoleSource", async () => {
    await repo.createUserUnscoped({ instanceRole: "owner", passwordHash: "h" });
    const { users } = await repo.listUsersPageUnscoped({ pageSize: 10 });
    expect(users).toHaveLength(1);
    const u = users[0];
    expect(u).not.toHaveProperty("passwordHash");
    expect(u).not.toHaveProperty("sessionVersion");
    expect(u).not.toHaveProperty("instanceRoleSource");
    expect(u).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        instanceRole: "owner",
        status: "active",
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      }),
    );
  });

  it("reflects updates via updateUserUnscoped", async () => {
    const u = await repo.createUserUnscoped({ email: "a@x.io", instanceRole: "user" });
    await repo.updateUserUnscoped(u.id, { status: "disabled", instanceRole: "admin" });
    const { users } = await repo.listUsersPageUnscoped({});
    expect(users[0]).toEqual(
      expect.objectContaining({ status: "disabled", instanceRole: "admin" }),
    );
  });
});

describe("updateUserUnscoped allow-lists", () => {
  beforeEach(async () => {
    repo = await import("@/lib/db/repos/usersRepo.js");
    db = await (await import("@/lib/db/driver.js")).getAdapter();
    for (const t of ["memberships", "identities", "workspaces", "users"])
      db.run(`DELETE FROM ${t}`);
  });

  it("rejects invalid instanceRole/status before touching the owner guard", async () => {
    const u = await repo.createUserUnscoped({ instanceRole: "user" });
    expect(await code(repo.updateUserUnscoped(u.id, { instanceRole: "root" }))).toBe("INVALID");
    expect(await code(repo.updateUserUnscoped(u.id, { instanceRole: null }))).toBe("INVALID");
    expect(await code(repo.updateUserUnscoped(u.id, { status: "banned" }))).toBe("INVALID");
    // Untouched by the rejected patches.
    expect(await repo.getUserUnscoped(u.id)).toEqual(
      expect.objectContaining({ instanceRole: "user", status: "active" }),
    );
  });

  it("keeps valid values and other trusted fields working", async () => {
    const u = await repo.createUserUnscoped({ instanceRole: "user" });
    const patched = await repo.updateUserUnscoped(u.id, {
      instanceRole: "admin",
      status: "disabled",
      displayName: "Zed",
    });
    expect(patched).toEqual(
      expect.objectContaining({ instanceRole: "admin", status: "disabled", displayName: "Zed" }),
    );
  });

  it("owner invariants still win over the allow-list", async () => {
    const o = await repo.createUserUnscoped({ instanceRole: "owner" });
    expect(await code(repo.updateUserUnscoped(o.id, { status: "disabled" }))).toBe(
      "OWNER_IMMUTABLE",
    );
    expect(await code(repo.updateUserUnscoped(o.id, { instanceRole: "admin" }))).toBe(
      "OWNER_IMMUTABLE",
    );
  });
});

describe("listUsersPageUnscoped filters and enriched DTO", () => {
  beforeEach(async () => {
    repo = await import("@/lib/db/repos/usersRepo.js");
    db = await (await import("@/lib/db/driver.js")).getAdapter();
    for (const t of ["memberships", "identities", "workspaces", "users"])
      db.run(`DELETE FROM ${t}`);
  });

  const mk = (over = {}) =>
    repo.createUserUnscoped({ instanceRole: "user", passwordHash: "h", ...over });
  const ids = async (opts) => (await repo.listUsersPageUnscoped(opts)).users.map((u) => u.id);

  it("searches email/username/displayName literally; wildcards and SQL never widen it", async () => {
    const a = await mk({ email: "Ann.Mail@x.io", username: "ann", displayName: "Ann A" });
    const b = await mk({ email: "bob@x.io", username: "bob", displayName: "100_% sure" });
    const c = await mk({ email: "cy@x.io", username: "cy", displayName: "100x" });

    expect(await ids({ search: "ann.mail" })).toEqual([a.id]); // email, case-insensitive
    expect(await ids({ search: "bob" })).toEqual([b.id]); // username
    expect(await ids({ search: "Ann A" })).toEqual([a.id]); // displayName
    // `_` and `%` are literal: "100_%" must not match "100x".
    expect(await ids({ search: "100_%" })).toEqual([b.id]);
    expect(await ids({ search: "%" })).toEqual([b.id]);
    expect(await ids({ search: "_" })).toEqual([b.id]);
    expect(await ids({ search: "\\" })).toEqual([]);
    expect(await ids({ search: "' OR 1=1 --" })).toEqual([]);
    expect(new Set(await ids({ search: "100" }))).toEqual(new Set([b.id, c.id]));
    // Trimmed; blank means no filter.
    expect(await ids({ search: "  ann " })).toEqual([a.id]);
    expect((await repo.listUsersPageUnscoped({ search: "   " })).pagination.totalItems).toBe(3);
  });

  it("rejects over-long search and unknown role/status with INVALID", async () => {
    expect(await code(repo.listUsersPageUnscoped({ search: "x".repeat(101) }))).toBe("INVALID");
    expect((await repo.listUsersPageUnscoped({ search: "x".repeat(100) })).users).toEqual([]);
    expect(await code(repo.listUsersPageUnscoped({ role: "root" }))).toBe("INVALID");
    expect(await code(repo.listUsersPageUnscoped({ status: "banned" }))).toBe("INVALID");
    expect(await code(repo.listUsersPageUnscoped({ search: { $ne: 1 } }))).toBe("INVALID");
  });

  it("filters intersect, and count and page share one WHERE", async () => {
    for (let i = 1; i <= 5; i++) await mk({ email: `ann${i}@x.io` });
    await mk({ email: "other@x.io" });
    const off = await mk({ email: "ann-off@x.io" });
    await repo.updateUserUnscoped(off.id, { status: "disabled" });

    const p2 = await repo.listUsersPageUnscoped({
      search: "ann",
      status: "active",
      page: 2,
      pageSize: 2,
    });
    expect(p2.pagination).toEqual({ page: 2, pageSize: 2, totalItems: 5, totalPages: 3 });
    expect(p2.users).toHaveLength(2);
    expect(await ids({ search: "ann", status: "disabled" })).toEqual([off.id]);
    expect(await ids({ role: "admin" })).toEqual([]);
  });

  it("pending badge query: ?role=pending&status=active&pageSize=1 counts only active pending", async () => {
    await mk();
    const p1 = await mk({ email: "p1@x.io", instanceRole: "pending" });
    const p2 = await mk({ email: "p2@x.io", instanceRole: "pending" });
    await repo.updateUserUnscoped(p2.id, { status: "disabled" });
    const r = await repo.listUsersPageUnscoped({ role: "pending", status: "active", pageSize: 1 });
    expect(r.pagination.totalItems).toBe(1);
    expect(r.users.map((u) => u.id)).toEqual([p1.id]);
  });

  it("enriches each row with identities (no subject) and workspaceCount", async () => {
    const u = await mk({ email: "e@x.io" });
    const other = await mk({ email: "o@x.io" });
    const sql = `INSERT INTO identities(id, userId, provider, issuer, subject, emailAtLink, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?)`;
    db.run(sql, [
      "i-1",
      u.id,
      "oidc",
      "https://iss",
      "SUBJECT-SECRET",
      "e@x.io",
      "2026-01-01T00:00:00.000Z",
    ]);
    db.run(sql, ["i-2", u.id, "saml", "idp", "SUBJECT-2", null, "2026-01-02T00:00:00.000Z"]);
    db.run(
      `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES('w-x', 'Extra', 'shared', ?, 't', 't')`,
      [u.id],
    );
    db.run(
      `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES('w-x', ?, 'member', 'manual', 't')`,
      [u.id],
    );

    const { users } = await repo.listUsersPageUnscoped({});
    const row = users.find((x) => x.id === u.id);
    expect(row.workspaceCount).toBe(2); // personal + Extra
    expect(row.identities).toEqual([
      {
        id: "i-1",
        provider: "oidc",
        issuer: "https://iss",
        emailAtLink: "e@x.io",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastLoginAt: null,
      },
      {
        id: "i-2",
        provider: "saml",
        issuer: "idp",
        emailAtLink: null,
        createdAt: "2026-01-02T00:00:00.000Z",
        lastLoginAt: null,
      },
    ]);
    const o = users.find((x) => x.id === other.id);
    expect(o).toMatchObject({ identities: [], workspaceCount: 1 });
    expect(JSON.stringify(users)).not.toMatch(
      /SUBJECT|subject|passwordHash|sessionVersion|instanceRoleSource/,
    );
    expect(await repo.getUserDetailUnscoped(u.id)).toEqual(row);
    expect(await repo.getUserDetailUnscoped("missing")).toBeNull();
  });
});

describe("revokeUserSessionsUnscoped", () => {
  beforeEach(async () => {
    repo = await import("@/lib/db/repos/usersRepo.js");
    db = await (await import("@/lib/db/driver.js")).getAdapter();
    for (const t of ["memberships", "identities", "workspaces", "users"])
      db.run(`DELETE FROM ${t}`);
  });

  const sv = (id) => db.get(`SELECT sessionVersion AS v FROM users WHERE id = ?`, [id]).v;
  const mk = (instanceRole, extra = {}) =>
    repo.createUserUnscoped({
      instanceRole,
      email: `${instanceRole}${Math.random()}@x.io`,
      ...extra,
    });

  it("owner and admin may revoke a user: sessionVersion +1 once, nothing else changes", async () => {
    const owner = await mk("owner");
    const admin = await mk("admin");
    const user = await mk("user");
    const before = await repo.getUserUnscoped(user.id);
    const actorBefore = sv(admin.id);
    expect(await repo.revokeUserSessionsUnscoped(user.id, { actorUserId: admin.id })).toBe(true);
    expect(sv(admin.id)).toBe(actorBefore); // actor's own sessions stay valid
    expect(sv(user.id)).toBe(before.sessionVersion + 1);
    const after = await repo.getUserUnscoped(user.id);
    expect(after).toMatchObject({ instanceRole: "user", status: "active" });
    expect(after.updatedAt >= before.updatedAt).toBe(true);
    // Owner may also target an admin.
    const adminBefore = sv(admin.id);
    await repo.revokeUserSessionsUnscoped(admin.id, { actorUserId: owner.id });
    expect(sv(admin.id)).toBe(adminBefore + 1);
  });

  it("refuses self, owner target, admin->admin, non-admin, disabled actor, missing ids", async () => {
    const owner = await mk("owner");
    const admin = await mk("admin");
    const admin2 = await mk("admin");
    const user = await mk("user");
    const pend = await mk("pending");
    const counts = () => [owner, admin, admin2, user, pend].map((x) => sv(x.id));
    const snap = counts();

    for (const [target, actor] of [
      [owner.id, owner.id], // self
      [admin.id, admin.id], // self
      [owner.id, admin.id], // owner immutable
      [admin2.id, admin.id], // admin cannot target admin
      [user.id, user.id],
      [user.id, pend.id], // non-admin actor
    ]) {
      expect(await code(repo.revokeUserSessionsUnscoped(target, { actorUserId: actor }))).toBe(
        "FORBIDDEN",
      );
    }
    expect(await code(repo.revokeUserSessionsUnscoped("missing", { actorUserId: owner.id }))).toBe(
      "NOT_FOUND",
    );
    expect(await code(repo.revokeUserSessionsUnscoped(user.id, { actorUserId: "ghost" }))).toBe(
      "NOT_FOUND",
    );
    expect(await code(repo.revokeUserSessionsUnscoped(user.id, {}))).toBe("FORBIDDEN");
    await repo.updateUserUnscoped(admin.id, { status: "disabled" });
    snap[1] += 1; // the disable itself bumps admin's version
    expect(await code(repo.revokeUserSessionsUnscoped(user.id, { actorUserId: admin.id }))).toBe(
      "FORBIDDEN",
    );
    expect(counts()).toEqual(snap);
  });

  it("drops the session cache so the new version is read immediately", async () => {
    const owner = await mk("owner");
    const user = await mk("user");
    const warm = await repo.getSessionUserUnscoped(user.id); // caches it
    await repo.revokeUserSessionsUnscoped(user.id, { actorUserId: owner.id });
    expect((await repo.getSessionUserUnscoped(user.id)).sessionVersion).toBe(
      warm.sessionVersion + 1,
    );
  });
});
