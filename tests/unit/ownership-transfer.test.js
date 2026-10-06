// YAN-360: POST /api/users/ownership-transfer contract with a real DB —
// hidden (404) while the multi-user switch is off, session-only principals,
// password re-auth (wrong password rejected, SSO-only owner fails closed),
// and the happy path swapping the single owner row with sv bumps on both rows.
// Only the switch/session/sameOrigin/cookie-claims layer is mocked; the DB,
// repos, bcrypt hashing and login limiter are real.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireMultiUser: vi.fn(),
  authorize: vi.fn(),
  getPrincipal: vi.fn(),
  getDashboardAuthSession: vi.fn(),
}));

vi.mock("@/lib/users/featureSwitch", () => ({ requireMultiUser: mocks.requireMultiUser }));
vi.mock("@/lib/users/session", () => ({
  authorize: mocks.authorize,
  getPrincipal: mocks.getPrincipal,
}));
vi.mock("@/lib/auth/sameOrigin.js", () => ({
  isCrossSite: vi.fn(() => false),
  isJson: vi.fn(() => true),
}));
vi.mock("@/lib/auth/dashboardSession.js", () => ({
  getDashboardAuthSession: mocks.getDashboardAuthSession,
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

const { POST } = await import("@/app/api/users/ownership-transfer/route.js");
const { hashPassword } = await import("@/lib/auth/userPassword.js");
const repo = await import("@/lib/db/repos/usersRepo.js");

const OWNER = { via: "session", userId: "owner-1" };

const post = (body) =>
  new Request("http://localhost/api/users/ownership-transfer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

let db;
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.requireMultiUser.mockResolvedValue(null);
  mocks.getPrincipal.mockResolvedValue(OWNER);
  mocks.authorize.mockResolvedValue(null);
  mocks.getDashboardAuthSession.mockResolvedValue(null);
  db = await (await import("@/lib/db/driver.js")).getAdapter();
  for (const t of ["memberships", "identities", "workspaces", "users"]) db.run(`DELETE FROM ${t}`);
});

describe("hidden and principal gate", () => {
  it("multi-user switch off -> 404, no auth, no transfer", async () => {
    mocks.requireMultiUser.mockResolvedValue(
      NextResponse.json({ error: "Not found" }, { status: 404 }),
    );
    const res = await POST(post({ toUserId: crypto.randomUUID(), currentPassword: "x" }));
    expect(res.status).toBe(404);
    expect(mocks.getPrincipal).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it("cli principal (token, no password channel) -> 401 before capability check", async () => {
    mocks.getPrincipal.mockResolvedValue({ via: "cli", userId: "owner-1" });
    const res = await POST(post({ toUserId: crypto.randomUUID(), currentPassword: "x" }));
    expect(res.status).toBe(401);
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
});

describe("password re-auth against a real DB", () => {
  const PASSWORD = "correct horse battery";

  const seed = async ({ password = PASSWORD } = {}) => {
    const owner = await repo.createUserUnscoped({
      email: `${crypto.randomUUID()}@x.io`,
      instanceRole: "owner",
      ...(password == null ? {} : { passwordHash: await hashPassword(password) }),
    });
    const target = await repo.createUserUnscoped({
      email: `${crypto.randomUUID()}@x.io`,
      instanceRole: "user",
    });
    mocks.getPrincipal.mockResolvedValue({ via: "session", userId: owner.id });
    // Verified cookie claims: the sv proof the route requires before bcrypt.
    mocks.getDashboardAuthSession.mockResolvedValue({ sub: owner.id, sv: owner.sessionVersion });
    return { owner, target };
  };

  it("wrong password -> 401 reauth_required, roles unchanged", async () => {
    const { owner, target } = await seed();
    const res = await POST(post({ toUserId: target.id, currentPassword: "wrong password" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "reauth_required" });
    expect(await repo.getUserUnscoped(owner.id)).toMatchObject({
      instanceRole: "owner",
      sessionVersion: 1,
    });
    expect(await repo.getUserUnscoped(target.id)).toMatchObject({
      instanceRole: "user",
      sessionVersion: 1,
    });
  });

  it("SSO-only owner (no password hash) -> 403 reauth_unsupported, transfer not performed", async () => {
    const { owner, target } = await seed({ password: null });
    const res = await POST(post({ toUserId: target.id, currentPassword: "anything" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "reauth_unsupported" });
    expect(await repo.getUserUnscoped(owner.id).then((u) => u.instanceRole)).toBe("owner");
    expect(await repo.getUserUnscoped(target.id).then((u) => u.instanceRole)).toBe("user");
  });

  // Parameterized over claim shapes whose sv cannot be trusted: null claims
  // (cookie gone/stale) must fail closed as STALE even with the right password.
  it.each([["null claims", null]])(
    "%s with valid password -> 409 stale_session, roles and sv unchanged",
    async (_name, claims) => {
      const { owner, target } = await seed();
      mocks.getDashboardAuthSession.mockResolvedValue(claims);
      const res = await POST(post({ toUserId: target.id, currentPassword: PASSWORD }));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "stale_session" });
      expect(await repo.getUserUnscoped(owner.id)).toMatchObject({
        instanceRole: "owner",
        sessionVersion: 1,
      });
      expect(await repo.getUserUnscoped(target.id)).toMatchObject({
        instanceRole: "user",
        sessionVersion: 1,
      });
    },
  );

  it("correct password -> 200; target becomes owner, old owner admin, both sv bumped", async () => {
    const { owner, target } = await seed();
    const res = await POST(post({ toUserId: target.id, currentPassword: PASSWORD }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toMatchObject({ id: target.id, instanceRole: "owner" });
    expect(body.user).not.toHaveProperty("sessionVersion");
    expect(await repo.getUserUnscoped(owner.id)).toMatchObject({
      instanceRole: "admin",
      sessionVersion: 2,
    });
    expect(await repo.getUserUnscoped(target.id)).toMatchObject({
      instanceRole: "owner",
      sessionVersion: 2,
    });
    expect((await repo.getOwnerUnscoped()).id).toBe(target.id);
  });
});
