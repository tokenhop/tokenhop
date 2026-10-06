// acceptExistingInvitation: bound invite requires password identity; pure-SSO
// accounts use the verified SSO callback path instead.
import { beforeEach, describe, expect, it } from "vitest";

let repo;
let db;
let accept;

const acode = (p) => p.catch((e) => e.code);
const ctxOf = (u) => ({ userId: u.id });

beforeEach(async () => {
  repo = await import("@/lib/db/index.js");
  db = await (await import("@/lib/db/driver.js")).getAdapter();
  accept = await import("@/lib/users/invitationAccept.js");
  for (const t of ["invitations", "memberships", "identities", "workspaces", "users"])
    db.run(`DELETE FROM ${t}`);
});

async function tenancy() {
  const owner = await repo.createUserUnscoped({ email: "o@i.test", instanceRole: "owner" });
  const shared = await repo.createSharedWorkspace(ctxOf(owner), { name: "S" });
  return { owner, shared };
}

const invite = (owner, shared, opts = {}) =>
  repo.createInvitation(ctxOf(owner), { workspaceId: shared.id, role: "member", ...opts });

async function ssoOnlyUser(email, subject = `sub-${email}`) {
  const { linkIdentityUnscoped } = await import("@/lib/db/repos/identitiesRepo.js");
  const user = await repo.createUserUnscoped({ email, instanceRole: "user" });
  await linkIdentityUnscoped(user.id, {
    provider: "oidc",
    issuer: "https://idp.test",
    subject,
    emailAtLink: email,
  });
  return user;
}

async function addPasswordIdentity(userId, email) {
  const { insertIdentitySync } = await import("@/lib/db/repos/identitiesRepo.js");
  insertIdentitySync(db, userId, {
    provider: "password",
    issuer: "",
    subject: userId,
    emailAtLink: email,
  });
}

const members = (ws, uid) =>
  db.all(`SELECT * FROM memberships WHERE workspaceId = ? AND userId = ?`, [ws, uid]);
const live = (id) => db.get(`SELECT consumedAt, revokedAt FROM invitations WHERE id = ?`, [id]);

describe("acceptExistingInvitation", () => {
  it("denies a bound invite for a persisted SSO account with no password identity; invite stays live", async () => {
    const { owner, shared } = await tenancy();
    const { invitation, token } = await invite(owner, shared, { email: "sso@x.io" });
    const user = await ssoOnlyUser("sso@x.io");

    expect(await acode(accept.acceptExistingInvitation({ token, userId: user.id }))).toBe(
      "INVALID",
    );
    expect(live(invitation.id).consumedAt).toBeNull();
    expect(members(shared.id, user.id)).toEqual([]);
  });

  it("succeeds after a password identity is added to the same account", async () => {
    const { owner, shared } = await tenancy();
    const { invitation, token } = await invite(owner, shared, { email: "sso@x.io" });
    const user = await ssoOnlyUser("sso@x.io");
    expect(await acode(accept.acceptExistingInvitation({ token, userId: user.id }))).toBe(
      "INVALID",
    );

    await addPasswordIdentity(user.id, "sso@x.io");
    const out = await accept.acceptExistingInvitation({ token, userId: user.id });
    expect(out).toMatchObject({ workspaceId: shared.id, role: "member" });
    expect(out.invitation.state).toBe("consumed");
    expect(members(shared.id, user.id)).toHaveLength(1);
    expect(members(shared.id, user.id)[0].source).toBe("invite");
    expect(live(invitation.id).consumedAt).not.toBeNull();
  });

  it("accepts an unbound invite for a pure-SSO account", async () => {
    const { owner, shared } = await tenancy();
    const { token } = await invite(owner, shared);
    const user = await ssoOnlyUser("free@x.io");

    const out = await accept.acceptExistingInvitation({ token, userId: user.id });
    expect(out).toMatchObject({ workspaceId: shared.id, role: "member" });
    expect(out.invitation.state).toBe("consumed");
    expect(members(shared.id, user.id)).toHaveLength(1);
  });

  it("existing membership is a conflict: INVALID, invite stays live, no duplicate row", async () => {
    const { owner, shared } = await tenancy();
    const { invitation, token } = await invite(owner, shared);
    const user = await ssoOnlyUser("dup@x.io");
    const { addMembershipUnscoped } = await import("@/lib/db/repos/membershipsRepo.js");
    db.transaction(() =>
      addMembershipUnscoped(db, { workspaceId: shared.id, userId: user.id, role: "viewer" }),
    );

    expect(await acode(accept.acceptExistingInvitation({ token, userId: user.id }))).toBe(
      "INVALID",
    );
    expect(live(invitation.id).consumedAt).toBeNull();
    const rows = members(shared.id, user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("viewer");
  });
});
