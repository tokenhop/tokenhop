// acceptExistingInvitation: bound invite requires password identity; pure-SSO
// accounts use the verified SSO callback path instead.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const auth = vi.hoisted(() => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/users/session", () => ({ getPrincipal: auth.getPrincipal }));
const savedEnv = process.env.TOKENHOP_MULTI_USER;
afterAll(() => {
  if (savedEnv === undefined) delete process.env.TOKENHOP_MULTI_USER;
  else process.env.TOKENHOP_MULTI_USER = savedEnv;
});

let repo;
let db;
let accept;

const acode = (p) => p.catch((e) => e.code);
const ctxOf = (u) => ({ userId: u.id });

beforeEach(async () => {
  process.env.TOKENHOP_MULTI_USER = "on";
  auth.getPrincipal.mockResolvedValue(null);
  const limiter = await import("@/lib/auth/loginLimiter.js");
  limiter.recordSuccess("unknown");
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
    expect(out).toMatchObject({ workspaceId: shared.id, workspaceName: "S", role: "member" });
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
    expect(out).toMatchObject({ workspaceId: shared.id, workspaceName: "S", role: "member" });
    expect(out.invitation.state).toBe("consumed");
    expect(members(shared.id, user.id)).toHaveLength(1);
  });

  it("existing membership is ALREADY_MEMBER, invite stays live, no duplicate row", async () => {
    const { owner, shared } = await tenancy();
    const { invitation, token } = await invite(owner, shared);
    const user = await ssoOnlyUser("dup@x.io");
    const { addMembershipUnscoped } = await import("@/lib/db/repos/membershipsRepo.js");
    db.transaction(() =>
      addMembershipUnscoped(db, { workspaceId: shared.id, userId: user.id, role: "viewer" }),
    );

    expect(await acode(accept.acceptExistingInvitation({ token, userId: user.id }))).toBe(
      "ALREADY_MEMBER",
    );
    expect(live(invitation.id).consumedAt).toBeNull();
    const rows = members(shared.id, user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("viewer");
  });
});

const post = async (body) => {
  const { POST } = await import("@/app/api/invitations/accept/route.js");
  return POST(
    new NextRequest("https://hop.test/api/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
};

describe("invitation acceptance response contract", () => {
  it("signed-in member gets 409 already_member, leaving token usable for intended recipient", async () => {
    const { owner, shared } = await tenancy();
    const { invitation, token } = await invite(owner, shared);
    auth.getPrincipal.mockResolvedValue({ via: "session", userId: owner.id });
    const res = await post({ token });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Already a member of this workspace",
      code: "already_member",
    });
    expect(live(invitation.id).consumedAt).toBeNull();
    const recipient = await ssoOnlyUser("intended@x.io");
    auth.getPrincipal.mockResolvedValue({ via: "session", userId: recipient.id });
    const accepted = await post({ token });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      workspaceId: shared.id,
      workspaceName: "S",
      role: "member",
    });
    expect(live(invitation.id).consumedAt).not.toBeNull();
  });

  it("anonymous create-account success adds only workspaceName", async () => {
    const { owner, shared } = await tenancy();
    const { token } = await invite(owner, shared);
    const res = await post({ token, email: "new@x.io", password: "hunter2hunter2" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspaceName).toBe("S");
    expect(Object.keys(body).sort()).toEqual([
      "invitation",
      "role",
      "user",
      "workspaceId",
      "workspaceName",
    ]);
  });

  it.each(["member", "anonymous"])(
    "invalid/expired/revoked tokens return identical invite_invalid bodies for %s",
    async (caller) => {
      const { owner, shared } = await tenancy();
      if (caller === "member")
        auth.getPrincipal.mockResolvedValue({ via: "session", userId: owner.id });
      const expired = await invite(owner, shared);
      const revoked = await invite(owner, shared);
      db.run("UPDATE invitations SET expiresAt = ? WHERE id = ?", [
        new Date(Date.now() - 60000).toISOString(),
        expired.invitation.id,
      ]);
      db.run("UPDATE invitations SET revokedAt = ? WHERE id = ?", [
        new Date().toISOString(),
        revoked.invitation.id,
      ]);
      for (const token of ["A".repeat(43), expired.token, revoked.token]) {
        const body =
          caller === "member"
            ? { token }
            : { token, email: "anon@x.io", password: "hunter2hunter2" };
        const res = await post(body);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Invalid invitation", code: "invite_invalid" });
      }
    },
  );

  it("anonymous account collision and bound-email mismatch never reveal membership or workspace name", async () => {
    const { owner, shared } = await tenancy();
    const unbound = await invite(owner, shared);
    const anon = await post({
      token: unbound.token,
      email: owner.email,
      password: "hunter2hunter2",
    });
    expect(anon.status).toBe(400);
    expect(await anon.json()).toEqual({ error: "Invalid invitation", code: "invite_invalid" });
    const bound = await invite(owner, shared, { email: "intended@x.io" });
    auth.getPrincipal.mockResolvedValue({ via: "session", userId: owner.id });
    const wrong = await post({ token: bound.token });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: "Invalid invitation", code: "invite_invalid" });
    expect(live(bound.invitation.id).consumedAt).toBeNull();
  });
});
