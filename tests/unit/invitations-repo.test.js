// YAN-360 task 1.5: invitationsRepo mint/expiry/reuse/revoke/no-secrets.
import { beforeEach, describe, expect, it } from "vitest";

let repo;
let db;

const acode = (p) => p.catch((e) => e.code);
const scode = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return undefined;
};
const ctxOf = (u) => ({ userId: u.id });
const consume = (token, opts = {}) =>
  db.transaction(() => repo.consumeInvitationSync(db, token, opts));

beforeEach(async () => {
  repo = await import("@/lib/db/index.js");
  db = await (await import("@/lib/db/driver.js")).getAdapter();
  for (const t of ["invitations", "memberships", "identities", "workspaces", "users"])
    db.run(`DELETE FROM ${t}`);
});

async function tenancy() {
  const owner = await repo.createUserUnscoped({ email: "o@i.test", instanceRole: "owner" });
  const other = await repo.createUserUnscoped({ email: "x@i.test", instanceRole: "user" });
  const shared = await repo.createSharedWorkspace(ctxOf(owner), { name: "S" });
  return { owner, other, shared };
}

describe("invitationsRepo", () => {
  it("mints a once-visible token, stores only the hex hash, 7-day expiry", async () => {
    const { owner, shared } = await tenancy();
    const { invitation, token } = await repo.createInvitation(ctxOf(owner), {
      workspaceId: shared.id,
      role: "member",
      email: " New@X.io ",
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(invitation.email).toBe("new@x.io");
    expect(invitation.state).toBe("live");
    expect(invitation).not.toHaveProperty("tokenHash");
    const stored = db.get(`SELECT * FROM invitations WHERE id = ?`, [invitation.id]);
    expect(stored.tokenHash).toBe(repo.hashInvitationToken(token));
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(new Date(stored.expiresAt) - new Date(stored.createdAt)).toBe(7 * 86400 * 1000);
  });

  it("rejects bad roles, ungranted manager, personal workspaces", async () => {
    const { owner, shared } = await tenancy();
    expect(
      await acode(repo.createInvitation(ctxOf(owner), { workspaceId: shared.id, role: "owner" })),
    ).toBe("INVALID");
    // A workspace manager (not owner, not instance admin) can't grant manager.
    const mgr = await repo.createUserUnscoped({ email: "m@i.test", instanceRole: "user" });
    const { addMembershipUnscoped } = await import("@/lib/db/repos/membershipsRepo.js");
    db.transaction(() =>
      addMembershipUnscoped(db, { workspaceId: shared.id, userId: mgr.id, role: "manager" }),
    );
    expect(
      await acode(repo.createInvitation(ctxOf(mgr), { workspaceId: shared.id, role: "manager" })),
    ).toBe("FORBIDDEN");
    // ...but may mint member/viewer invites (live authority, not a snapshot).
    expect(
      (await repo.createInvitation(ctxOf(mgr), { workspaceId: shared.id, role: "viewer" }))
        .invitation.role,
    ).toBe("viewer");
    // The workspace owner may grant manager.
    expect(
      (await repo.createInvitation(ctxOf(owner), { workspaceId: shared.id, role: "manager" }))
        .invitation.role,
    ).toBe("manager");
    expect(
      await acode(
        repo.createInvitation(ctxOf(owner), {
          workspaceId: owner.personalWorkspaceId,
          role: "member",
        }),
      ),
    ).toBe("PERSONAL_WORKSPACE");
  });

  it("pending and plain-member actors are forbidden; authority is live", async () => {
    const { owner, other, shared } = await tenancy();
    const pending = await repo.createUserUnscoped({ email: "p@i.test", instanceRole: "pending" });
    // Non-members don't see the workspace; pending users are refused before any
    // workspace lookup (same as membershipsRepo), so neither is an existence oracle.
    expect(
      await acode(repo.createInvitation(ctxOf(other), { workspaceId: shared.id, role: "member" })),
    ).toBe("NOT_FOUND");
    expect(
      await acode(
        repo.createInvitation(ctxOf(pending), { workspaceId: shared.id, role: "member" }),
      ),
    ).toBe("FORBIDDEN");
    // Members (any workspace role below manager) can't mint; pending users are
    // forbidden even with a (stale) owner row.
    const { addMembershipUnscoped } = await import("@/lib/db/repos/membershipsRepo.js");
    db.transaction(() => {
      addMembershipUnscoped(db, { workspaceId: shared.id, userId: other.id, role: "member" });
      addMembershipUnscoped(db, { workspaceId: shared.id, userId: pending.id, role: "owner" });
    });
    expect(
      await acode(repo.createInvitation(ctxOf(other), { workspaceId: shared.id, role: "member" })),
    ).toBe("FORBIDDEN");
    expect(
      await acode(
        repo.createInvitation(ctxOf(pending), { workspaceId: shared.id, role: "member" }),
      ),
    ).toBe("FORBIDDEN");
    expect(await acode(repo.listInvitations(ctxOf(pending), shared.id))).toBe("FORBIDDEN");
    // A demoted manager loses mint on the next call (live re-read).
    const { invitation } = await repo.createInvitation(ctxOf(owner), {
      workspaceId: shared.id,
      role: "member",
    });
    const revoker = await repo.createUserUnscoped({ email: "r@i.test", instanceRole: "user" });
    db.transaction(() =>
      addMembershipUnscoped(db, { workspaceId: shared.id, userId: revoker.id, role: "manager" }),
    );
    expect((await repo.revokeInvitation(ctxOf(revoker), invitation.id)).state).toBe("revoked");
    db.run(`DELETE FROM memberships WHERE workspaceId = ? AND userId = ?`, [shared.id, revoker.id]);
    expect(await acode(repo.listInvitations(ctxOf(revoker), shared.id))).toBe("NOT_FOUND");
  });

  it("lists metadata only; non-members get NOT_FOUND", async () => {
    const { owner, other, shared } = await tenancy();
    const { invitation, token } = await repo.createInvitation(ctxOf(owner), {
      workspaceId: shared.id,
      role: "viewer",
    });
    const listed = await repo.listInvitations(ctxOf(owner), shared.id);
    expect(listed.map((i) => i.id)).toEqual([invitation.id]);
    const blob = JSON.stringify(listed);
    expect(blob).not.toContain(token);
    expect(blob).not.toContain("tokenHash");
    expect(await acode(repo.listInvitations(ctxOf(other), shared.id))).toBe("NOT_FOUND");
  });

  it("consumes once; reuse fails; email binding is case-insensitive", async () => {
    const { owner, shared } = await tenancy();
    const { invitation, token } = await repo.createInvitation(ctxOf(owner), {
      workspaceId: shared.id,
      role: "member",
      email: "a@x.io",
    });
    expect(scode(() => consume(token, { email: "b@x.io" }))).toBe("INVALID");
    expect(scode(() => consume(token))).toBe("INVALID"); // bound invite needs an email
    expect(
      db.get(`SELECT consumedAt FROM invitations WHERE id = ?`, [invitation.id]).consumedAt,
    ).toBeNull();
    const ok = consume(token, { email: " A@X.io ", consumedByUserId: null });
    expect(ok.state).toBe("consumed");
    expect(scode(() => consume(token, { email: "a@x.io" }))).toBe("INVALID");
  });

  it("expiry boundary: now >= expiresAt rejects, token unconsumed", async () => {
    const { owner, shared } = await tenancy();
    const { invitation, token } = await repo.createInvitation(ctxOf(owner), {
      workspaceId: shared.id,
      role: "member",
    });
    expect(scode(() => consume(token, { now: invitation.expiresAt }))).toBe("INVALID");
    expect(
      db.get(`SELECT consumedAt FROM invitations WHERE id = ?`, [invitation.id]).consumedAt,
    ).toBeNull();
    const before = new Date(new Date(invitation.expiresAt) - 1).toISOString();
    expect(consume(token, { now: before }).state).toBe("consumed");
  });

  it("malformed, unknown and wrong-length tokens fail generically", async () => {
    const { owner, shared } = await tenancy();
    await repo.createInvitation(ctxOf(owner), { workspaceId: shared.id, role: "member" });
    for (const bad of ["", "short", "x".repeat(43), null, undefined, 42]) {
      expect(scode(() => consume(bad))).toBe("INVALID");
    }
  });

  it("revoke is idempotent, blocks consume, never unconsumes", async () => {
    const { owner, other, shared } = await tenancy();
    const a = await repo.createInvitation(ctxOf(owner), { workspaceId: shared.id, role: "member" });
    expect(await acode(repo.revokeInvitation(ctxOf(other), a.invitation.id))).toBe("NOT_FOUND");
    expect((await repo.revokeInvitation(ctxOf(owner), a.invitation.id)).state).toBe("revoked");
    expect((await repo.revokeInvitation(ctxOf(owner), a.invitation.id)).state).toBe("revoked");
    expect(scode(() => consume(a.token))).toBe("INVALID");

    const b = await repo.createInvitation(ctxOf(owner), { workspaceId: shared.id, role: "member" });
    consume(b.token);
    expect((await repo.revokeInvitation(ctxOf(owner), b.invitation.id)).state).toBe("consumed");
    expect(
      db.get(`SELECT revokedAt FROM invitations WHERE id = ?`, [b.invitation.id]).revokedAt,
    ).toBeNull();
  });

  it("failed consume inside a tx rolls back the conditional update", async () => {
    const { owner, shared } = await tenancy();
    const { invitation, token } = await repo.createInvitation(ctxOf(owner), {
      workspaceId: shared.id,
      role: "member",
    });
    expect(
      scode(() =>
        db.transaction(() => {
          repo.consumeInvitationSync(db, token);
          throw Object.assign(new Error("later step failed"), { code: "BOOM" });
        }),
      ),
    ).toBe("BOOM");
    expect(
      db.get(`SELECT consumedAt FROM invitations WHERE id = ?`, [invitation.id]).consumedAt,
    ).toBeNull();
    expect(consume(token).state).toBe("consumed");
  });
});
