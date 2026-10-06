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
