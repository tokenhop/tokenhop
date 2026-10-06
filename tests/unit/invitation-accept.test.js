// YAN-360 invitation accept, password path: happy path and failure guarantees.
import { beforeEach, describe, expect, it } from "vitest";

let repo;
let db;

const acode = (p) => p.catch((e) => e.code);
const ctxOf = (u) => ({ userId: u.id });

beforeEach(async () => {
  repo = await import("@/lib/db/index.js");
  db = await (await import("@/lib/db/driver.js")).getAdapter();
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

describe("acceptPasswordInvitation", () => {
  it("creates approved user, personal workspace, password identity and invited membership, burns invite", async () => {
    const { owner, shared } = await tenancy();
    const { invitation, token } = await invite(owner, shared, { email: "new@x.io" });
    const accept = await import("@/lib/users/invitationAccept.js");

    const out = await accept.acceptPasswordInvitation({
      token,
      email: "new@x.io",
      password: "hunter2hunter2",
    });
    expect(out.user.email).toBe("new@x.io");
    expect(out.user.status).toBe("active");
    expect(out.workspaceId).toBe(shared.id);
    expect(out.role).toBe("member");
    expect(out.invitation.state).toBe("consumed");

    const user = db.get(`SELECT * FROM users WHERE email = ? COLLATE NOCASE`, ["new@x.io"]);
    expect(user.status).toBe("active");
    expect(
      db.get(`SELECT kind FROM workspaces WHERE id = ?`, [out.user.personalWorkspaceId]).kind,
    ).toBe("personal");
    expect(
      db.get(`SELECT * FROM identities WHERE userId = ? AND provider = 'password'`, [user.id])
        .emailAtLink,
    ).toBe("new@x.io");
    const m = db.get(`SELECT * FROM memberships WHERE workspaceId = ? AND userId = ?`, [
      shared.id,
      user.id,
    ]);
    expect(m.role).toBe("member");
    expect(m.source).toBe("invite");
    expect(
      db.get(`SELECT consumedAt FROM invitations WHERE id = ?`, [invitation.id]).consumedAt,
    ).not.toBeNull();
  });

  it("weak password fails with PASSWORD_POLICY before the invite is touched", async () => {
    const { owner, shared } = await tenancy();
    const { invitation, token } = await invite(owner, shared, { email: "weak@x.io" });
    const accept = await import("@/lib/users/invitationAccept.js");
    const err = await accept
      .acceptPasswordInvitation({ token, email: "weak@x.io", password: "short" })
      .catch((e) => e);
    expect(err.code).toBe("PASSWORD_POLICY");
    expect(err.policy).toBe("password_too_short");
    expect(
      db.get(`SELECT consumedAt FROM invitations WHERE id = ?`, [invitation.id]).consumedAt,
    ).toBeNull();
    expect(db.get(`SELECT 1 AS x FROM users WHERE email = ?`, ["weak@x.io"])).toBeUndefined();
  });

  it("reuse of a consumed token fails generically and creates no extra users", async () => {
    const { owner, shared } = await tenancy();
    const { token } = await invite(owner, shared, { email: "a@x.io" });
    const accept = await import("@/lib/users/invitationAccept.js");
    const { user } = await accept.acceptPasswordInvitation({
      token,
      email: "a@x.io",
      password: "hunter2hunter2",
    });
    expect(
      await acode(
        accept.acceptPasswordInvitation({ token, email: "a@x.io", password: "hunter2hunter2" }),
      ),
    ).toBe("INVALID");
    expect(
      await acode(
        accept.acceptPasswordInvitation({
          token,
          email: "other@x.io",
          password: "hunter2hunter2",
        }),
      ),
    ).toBe("INVALID");
    expect(db.get(`SELECT COUNT(*) AS n FROM users WHERE email = 'a@x.io'`).n).toBe(1);
    expect(db.get(`SELECT COUNT(*) AS n FROM users`).n).toBe(2); // owner + acceptor
    expect(user.id).toBeTruthy();
  });

  it("expiry boundary: now >= expiresAt rejects and invite stays live", async () => {
    const { owner, shared } = await tenancy();
    const { invitation, token } = await invite(owner, shared, { email: "e@x.io" });
    db.run(`UPDATE invitations SET expiresAt = ? WHERE id = ?`, [
      new Date().toISOString(),
      invitation.id,
    ]);
    const accept = await import("@/lib/users/invitationAccept.js");
    expect(
      await acode(
        accept.acceptPasswordInvitation({ token, email: "e@x.io", password: "x".repeat(12) }),
      ),
    ).toBe("INVALID");
    expect(
      db.get(`SELECT consumedAt FROM invitations WHERE id = ?`, [invitation.id]).consumedAt,
    ).toBeNull();
    expect(db.get(`SELECT COUNT(*) AS n FROM users WHERE email = 'e@x.io'`).n).toBe(0);
  });

  it("email mismatch on a bound invite fails with generic INVALID", async () => {
    const { owner, shared } = await tenancy();
    const { token } = await invite(owner, shared, { email: "bound@x.io" });
    const accept = await import("@/lib/users/invitationAccept.js");
    expect(
      await acode(
        accept.acceptPasswordInvitation({ token, email: "other@x.io", password: "x".repeat(12) }),
      ),
    ).toBe("INVALID");
    expect(db.get(`SELECT COUNT(*) AS n FROM users`).n).toBe(1); // owner only
  });

  it("duplicate email rolls back the whole tx, leaving the invite live", async () => {
    const { owner, shared } = await tenancy();
    const base = {
      memberships: db.get(`SELECT COUNT(*) AS n FROM memberships`).n,
      identities: db.get(`SELECT COUNT(*) AS n FROM identities`).n,
      workspaces: db.get(`SELECT COUNT(*) AS n FROM workspaces`).n,
      users: db.get(`SELECT COUNT(*) AS n FROM users`).n,
    };
    const { invitation, token } = await invite(owner, shared, { email: "dup@x.io" });
    db.run(`UPDATE users SET email = 'dup@x.io' WHERE id = ?`, [owner.id]);
    const accept = await import("@/lib/users/invitationAccept.js");
    expect(
      await acode(
        accept.acceptPasswordInvitation({ token, email: "dup@x.io", password: "x".repeat(12) }),
      ),
    ).toBe("INVALID");
    expect(
      db.get(`SELECT consumedAt FROM invitations WHERE id = ?`, [invitation.id]).consumedAt,
    ).toBeNull();
    expect(db.get(`SELECT COUNT(*) AS n FROM memberships`).n).toBe(base.memberships);
    expect(db.get(`SELECT COUNT(*) AS n FROM identities`).n).toBe(base.identities);
    expect(db.get(`SELECT COUNT(*) AS n FROM workspaces`).n).toBe(base.workspaces);
    expect(db.get(`SELECT COUNT(*) AS n FROM users`).n).toBe(base.users);
    // Invite survives, so the collision is not a burn.
    db.run(`UPDATE users SET email = 'o@i.test' WHERE id = ?`, [owner.id]);
    const out = await accept.acceptPasswordInvitation({
      token,
      email: "dup@x.io",
      password: "hunter2hunter2",
    });
    expect(out.invitation.state).toBe("consumed");
  });

  it("requireLogin=false blocks accepting when an active user already exists", async () => {
    const { owner, shared } = await tenancy();
    const { token } = await invite(owner, shared, { email: "s@x.io" });
    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
    await updateSettings({ requireLogin: false });
    const accept = await import("@/lib/users/invitationAccept.js");
    expect(
      await acode(
        accept.acceptPasswordInvitation({ token, email: "s@x.io", password: "x".repeat(12) }),
      ),
    ).toBe("SINGLE_USER_MODE");
    expect(db.get(`SELECT COUNT(*) AS n FROM users WHERE email = 's@x.io'`).n).toBe(0);
  });
});
