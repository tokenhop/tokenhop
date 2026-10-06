import { beforeEach, expect, it } from "vitest";

let db, repo, members, owner, manager, member, ws;
const ctx = (u) => ({
  userId: u.id,
  instanceRole: u.instanceRole,
  workspaceIds: [ws.id],
  activeWorkspaceId: ws.id,
});
beforeEach(async () => {
  repo = await import("@/lib/db/index.js");
  members = await import("@/lib/db/repos/membershipsRepo.js");
  db = await (await import("@/lib/db/driver.js")).getAdapter();
  for (const t of ["memberships", "identities", "workspaces", "users"]) db.run(`DELETE FROM ${t}`);
  owner = await repo.createUserUnscoped({ instanceRole: "owner" });
  manager = await repo.createUserUnscoped({ instanceRole: "user" });
  member = await repo.createUserUnscoped({ instanceRole: "user" });
  ws = await repo.createSharedWorkspace(
    { userId: owner.id, instanceRole: "owner", workspaceIds: [], activeWorkspaceId: null },
    { name: "Team" },
  );
  await members.addMembership(ctx(owner), ws.id, { userId: manager.id, role: "manager" });
  await members.addMembership(ctx(owner), ws.id, { userId: member.id });
});

it("manager cannot demote or remove workspace owner", async () => {
  await expect(
    members.updateMembershipRole(ctx(manager), ws.id, owner.id, "member"),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(members.removeMembership(ctx(manager), ws.id, owner.id)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});
it("ordinary member cannot mutate and manual adds reject invite provenance", async () => {
  await expect(members.removeMembership(ctx(member), ws.id, manager.id)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(
    members.addMembership(ctx(owner), ws.id, { userId: member.id, source: "invite" }),
  ).rejects.toMatchObject({ code: "INVALID" });
});
it("disable refuses last active manager and ignores disabled alternatives", async () => {
  const users = await import("@/lib/db/repos/usersRepo.js");
  db.run("UPDATE memberships SET role = 'member' WHERE workspaceId = ? AND userId = ?", [
    ws.id,
    owner.id,
  ]);
  await expect(users.updateUserUnscoped(manager.id, { status: "disabled" })).rejects.toMatchObject({
    code: "LAST_MANAGER",
  });
  db.run("UPDATE memberships SET role = 'manager' WHERE workspaceId = ? AND userId = ?", [
    ws.id,
    member.id,
  ]);
  db.run("UPDATE users SET status = 'disabled' WHERE id = ?", [member.id]);
  await expect(users.updateUserUnscoped(manager.id, { status: "disabled" })).rejects.toMatchObject({
    code: "LAST_MANAGER",
  });
  db.run("UPDATE users SET status = 'active' WHERE id = ?", [member.id]);
  expect((await users.updateUserUnscoped(manager.id, { status: "disabled" })).status).toBe(
    "disabled",
  );
});
it("pending managers don't count, and demotion to pending is guarded like disable", async () => {
  const users = await import("@/lib/db/repos/usersRepo.js");
  db.run("UPDATE memberships SET role = 'member' WHERE workspaceId = ? AND userId = ?", [
    ws.id,
    owner.id,
  ]);
  db.run("UPDATE memberships SET role = 'manager' WHERE workspaceId = ? AND userId = ?", [
    ws.id,
    member.id,
  ]);
  db.run("UPDATE users SET instanceRole = 'pending' WHERE id = ?", [member.id]);
  await expect(users.updateUserUnscoped(manager.id, { status: "disabled" })).rejects.toMatchObject({
    code: "LAST_MANAGER",
  });
  await expect(
    users.updateUserUnscoped(manager.id, { instanceRole: "pending" }),
  ).rejects.toMatchObject({ code: "LAST_MANAGER" });
});
