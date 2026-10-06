// YAN-360: SSO admission with a server-held invitationToken against real SQLite.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const ENV = "TOKENHOP_MULTI_USER";
const saved = { switch: process.env[ENV], email: process.env.TOKENHOP_OWNER_EMAIL };
let b;
let db;
let adapter;
let sso;
let owner;

const DEFAULTS = {
  password: null,
  requireLogin: true,
  oidcIssuerUrl: "",
  samlEntryPoint: "",
  samlCert: "",
  ssoAllowedGroups: [],
  ssoAdminGroups: [],
  ssoGroupWorkspaceMap: [],
  ssoDefaultRole: "pending",
};

const count = (sql, p = []) => adapter.get(sql, p).c;
const user = (id) => adapter.get(`SELECT * FROM users WHERE id = ?`, [id]);
const idp = (sub, extra = {}) => ({
  provider: "oidc",
  issuer: "https://idp.test",
  subject: sub,
  ...extra,
});
const inviteRow = (id) => adapter.get(`SELECT * FROM invitations WHERE id = ?`, [id]);
const members = (id) =>
  adapter.all(`SELECT workspaceId, role, source FROM memberships WHERE userId = ?`, [id]);
const shared = async (name) => (await db.createSharedWorkspace({ userId: owner.id }, { name })).id;
const mint = (workspaceId, opts = {}) =>
  db.createInvitation({ userId: owner.id }, { workspaceId, role: "member", ...opts });

beforeEach(async () => {
  vi.resetModules();
  process.env[ENV] = "on";
  delete process.env.TOKENHOP_OWNER_EMAIL;
  globalThis.__tokenhopOwnerBootstrap = { done: false, failedAt: 0, running: null };
  b = await import("@/lib/users/bootstrap");
  db = await import("@/lib/db/index.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  sso = await import("@/lib/users/ssoProvisioning.js");
  for (const t of ["invitations", "memberships", "identities", "workspaces", "users"])
    adapter.run(`DELETE FROM ${t}`);
  adapter.run(`DELETE FROM _meta WHERE key LIKE 'owner%' OR key = 'defaultWorkspaceId'`);
  await db.updateSettings(DEFAULTS);
  await b.ensureOwnerBootstrap({ throwOnError: true });
  owner = await db.getOwnerUnscoped();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(() => {
  for (const [k, v] of [
    [ENV, saved.switch],
    ["TOKENHOP_OWNER_EMAIL", saved.email],
  ]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("ssoAdmit with invitationToken", () => {
  it("bound invite with verified matching email approves a user and consumes the invite", async () => {
    const ws = await shared("Inv");
    const { invitation, token } = await mint(ws, { email: "a@x.io" });
    const out = await sso.ssoAdmit(idp("inv1", { email: "A@X.io", emailVerified: true }), [], {
      invitationToken: token,
    });
    expect(out.kind).toBe("active");
    expect(user(out.userId)).toMatchObject({ instanceRole: "user", status: "active" });
    expect(
      count(`SELECT COUNT(*) AS c FROM identities WHERE userId = ? AND subject = 'inv1'`, [
        out.userId,
      ]),
    ).toBe(1);
    expect(members(out.userId).filter((m) => m.source === "invite")).toEqual([
      { workspaceId: ws, role: "member", source: "invite" },
    ]);
    const stored = inviteRow(invitation.id);
    expect(stored.consumedAt).not.toBeNull();
    expect(stored.consumedByUserId).toBe(out.userId);
  });

  it("unverified or wrong email is denied with rollback and the invite stays live", async () => {
    const ws = await shared("Inv");
    const usersBefore = count(`SELECT COUNT(*) AS c FROM users`);

    const a = await mint(ws, { email: "a@x.io" });
    await expect(
      sso.ssoAdmit(idp("unv", { email: "a@x.io" }), [], { invitationToken: a.token }),
    ).rejects.toMatchObject({ code: "denied" });
    expect(count(`SELECT COUNT(*) AS c FROM users`)).toBe(usersBefore);
    expect(count(`SELECT COUNT(*) AS c FROM identities WHERE subject = 'unv'`)).toBe(0);
    expect(inviteRow(a.invitation.id).consumedAt).toBeNull();

    const c = await mint(ws, { email: "a@x.io" });
    await expect(
      sso.ssoAdmit(idp("wrg", { email: "b@x.io", emailVerified: true }), [], {
        invitationToken: c.token,
      }),
    ).rejects.toMatchObject({ code: "denied" });
    expect(count(`SELECT COUNT(*) AS c FROM users`)).toBe(usersBefore);
    expect(count(`SELECT COUNT(*) AS c FROM identities WHERE subject = 'wrg'`)).toBe(0);
    expect(inviteRow(c.invitation.id).consumedAt).toBeNull();
  });

  it("a linked pending account is approved by a later invite login", async () => {
    const ws = await shared("Inv");
    const first = await sso.ssoAdmit(idp("pend1"), []);
    expect(first.kind).toBe("pending");
    const { token } = await mint(ws);
    const out = await sso.ssoAdmit(idp("pend1"), [], { invitationToken: token });
    expect(out).toEqual({ kind: "active", userId: first.userId });
    expect(user(first.userId)).toMatchObject({
      instanceRole: "user",
      instanceRoleSource: null,
    });
    expect(members(first.userId).filter((m) => m.source === "invite")).toEqual([
      { workspaceId: ws, role: "member", source: "invite" },
    ]);
  });

  it("allow-list denial leaves the invite live and writes nothing", async () => {
    await db.updateSettings({ ssoAllowedGroups: ["ok"] });
    const ws = await shared("Inv");
    const { invitation, token } = await mint(ws);
    const before = [
      count(`SELECT COUNT(*) AS c FROM users`),
      count(`SELECT COUNT(*) AS c FROM identities`),
    ];
    await expect(
      sso.ssoAdmit(idp("deny1"), ["no"], { invitationToken: token }),
    ).rejects.toMatchObject({ code: "denied" });
    expect([
      count(`SELECT COUNT(*) AS c FROM users`),
      count(`SELECT COUNT(*) AS c FROM identities`),
    ]).toEqual(before);
    expect(inviteRow(invitation.id).consumedAt).toBeNull();
  });

  it("an existing membership is a conflict: denied, never overwritten, invite stays live", async () => {
    const ws = await shared("Inv");
    const u = await sso.ssoAdmit(idp("conf1"), []);
    const { addMembershipUnscoped } = await import("@/lib/db/repos/membershipsRepo.js");
    adapter.transaction(() =>
      addMembershipUnscoped(adapter, {
        workspaceId: ws,
        userId: u.userId,
        role: "member",
        source: "manual",
      }),
    );
    const { invitation, token } = await mint(ws, { role: "viewer" });
    await expect(sso.ssoAdmit(idp("conf1"), [], { invitationToken: token })).rejects.toMatchObject({
      code: "denied",
    });
    expect(members(u.userId).filter((m) => m.workspaceId === ws)).toEqual([
      { workspaceId: ws, role: "member", source: "manual" },
    ]);
    expect(inviteRow(invitation.id).consumedAt).toBeNull();
    expect(user(u.userId).instanceRole).toBe("pending");
  });
});
