// YAN-355: request principal and revocable sessions (ADR-0003/0004), with the
// switch on and off. Uses the YAN-354 two-user harness (owner A, user B).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const PEER = "peer-token-yan-355";
process.env.TOKENHOP_PEER_TOKEN = PEER;

let s; // @/lib/users/session
let db; // @/lib/db/index.js
let jwt; // @/lib/auth/dashboardSession
let t;

// Route handlers read cookies()/headers(); back them with a per-test store.
const jar = vi.hoisted(() => ({ cookies: new Map(), headers: new Headers() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n) => (jar.cookies.has(n) ? { name: n, value: jar.cookies.get(n) } : undefined),
    set: (n, v) => jar.cookies.set(n, v),
    delete: (n) => jar.cookies.delete(n),
  }),
  headers: async () => jar.headers,
}));

async function load(state) {
  vi.resetModules();
  process.env[ENV] = state;
  s = await import("@/lib/users/session");
  db = await import("@/lib/db/index.js");
  jwt = await import("@/lib/auth/dashboardSession");
}

function req({ token, headers = {} } = {}) {
  const h = new Headers(headers);
  if (token) h.set("cookie", `auth_token=${token}`);
  return new NextRequest("http://localhost/api/x", { headers: h });
}

const tokenFor = (seeded, extra = {}) =>
  jwt.createDashboardAuthToken({
    sub: seeded.user.id,
    sv: seeded.user.sessionVersion,
    wid: seeded.personal,
    amr: ["pwd"],
    ...extra,
  });

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("switch on", () => {
  beforeEach(async () => {
    jar.cookies.clear();
    await load("on");
    await db.updateSettings({ requireLogin: true });
    t = await seedTenancy();
  });

  it("mints sub/sv/wid/amr for the owner", async () => {
    expect(await s.sessionClaims("pwd")).toEqual({
      sub: t.a.user.id,
      sv: t.a.user.sessionVersion,
      wid: t.a.personal,
      amr: ["pwd"],
    });
    // Two users: an SSO login can't stand for the owner (YAN-359 links identities),
    // so it is refused rather than minted sub-less.
    expect(await s.sessionClaims("oidc")).toBeNull();
  });

  it("resolves the session principal and honours wid only for own workspaces", async () => {
    const p = await s.resolvePrincipal(req({ token: await tokenFor(t.a, { wid: t.shared.id }) }));
    expect(p).toMatchObject({ userId: t.a.user.id, instanceRole: "owner", via: "session" });
    expect(p.activeWorkspaceId).toBe(t.shared.id);
    expect(p.workspaceIds.sort()).toEqual([t.a.personal, t.shared.id].sort());
    const forged = await s.resolvePrincipal(
      req({ token: await tokenFor(t.b, { wid: t.a.personal }) }),
    );
    expect(forged.activeWorkspaceId).toBe(t.b.personal);
  });

  it("revokes on the next request after a sessionVersion bump", async () => {
    const token = await tokenFor(t.a);
    expect(await s.hasValidSession(req({ token }))).toBe(true);
    await db.bumpSessionVersion(t.a.user.id);
    expect(await s.hasValidSession(req({ token }))).toBe(false);
    expect(await s.resolvePrincipal(req({ token }))).toBeNull();
  });

  it("picks up an out-of-process sessionVersion change once the cache expires", async () => {
    const token = await tokenFor(t.a);
    expect(await s.hasValidSession(req({ token }))).toBe(true);
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    adapter.run("UPDATE users SET sessionVersion = sessionVersion + 1 WHERE id = ?", [t.a.user.id]);
    vi.useFakeTimers({ now: Date.now() + 5001, toFake: ["Date"] });
    try {
      expect(await s.hasValidSession(req({ token }))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a disabled user's session", async () => {
    const token = await tokenFor(t.b);
    expect(await s.resolvePrincipal(req({ token }))).toMatchObject({ userId: t.b.user.id });
    await db.updateUserUnscoped(t.b.user.id, { status: "disabled" });
    expect(await s.resolvePrincipal(req({ token }))).toBeNull();
  });

  it("guards routes by capability: user B is authenticated but not an admin (YAN-357)", async () => {
    const { proxy } = await import("../../src/dashboardGuard.js");
    const call = async (seeded, path, method = "GET") => {
      const h = new Headers({ cookie: `auth_token=${await tokenFor(seeded)}` });
      return proxy(new NextRequest(`http://localhost${path}`, { method, headers: h }));
    };
    expect(await s.hasValidSession(req({ token: await tokenFor(t.b) }))).toBe(true);
    for (const path of ["/api/providers", "/api/settings", "/api/tunnel/status"]) {
      expect((await call(t.b, path)).status, path).toBe(403);
      expect((await call(t.a, path)).status, path).not.toBe(403);
    }
    expect((await call(t.b, "/api/keys", "POST")).status).toBe(403);
    expect((await call(t.b, "/api/gateway/status")).status).not.toBe(403);
    expect((await call(t.b, "/api/health")).status).not.toBe(403);
    await db.updateUserUnscoped(t.b.user.id, { instanceRole: "pending" });
    t.b.user = await db.getUserUnscoped(t.b.user.id);
    expect((await call(t.b, "/dashboard")).status).toBe(307);
    expect((await call(t.b, "/dashboard")).headers.get("location")).toContain("/login");
    expect((await call(t.a, "/dashboard")).headers.get("location")).toBeNull();
  });

  it("accepts a legacy sub-less token with one user, rejects it with two", async () => {
    const legacy = await jwt.createDashboardAuthToken();
    expect(await s.hasValidSession(req({ token: legacy }))).toBe(false);
    await db.deleteUserUnscoped(t.b.user.id);
    expect(await s.hasValidSession(req({ token: legacy }))).toBe(true);
    expect(await s.resolvePrincipal(req({ token: legacy }))).toMatchObject({
      userId: t.a.user.id,
      via: "session",
    });
  });

  it("maps the CLI token to the owner, loopback-only once a second user exists", async () => {
    const { getCliToken, CLI_TOKEN_HEADER } = await import("@/lib/auth/cliToken");
    const cli = { [CLI_TOKEN_HEADER]: await getCliToken() };
    const loopback = { ...cli, "x-9r-peer-token": PEER, "x-9r-real-ip": "127.0.0.1" };
    expect(await s.resolvePrincipal(req({ headers: loopback }))).toMatchObject({
      userId: t.a.user.id,
      via: "cli",
    });
    expect(await s.cliTokenAccepted(req({ headers: cli }))).toBe(false);
    expect(await s.cliTokenAccepted(req({ headers: { ...loopback, "x-9r-via-proxy": "1" } }))).toBe(
      false,
    );
    await db.deleteUserUnscoped(t.b.user.id);
    expect(await s.cliTokenAccepted(req({ headers: cli }))).toBe(true);
  });

  it("acts as the owner in single-user mode (requireLogin=false)", async () => {
    expect(await s.resolvePrincipal(req())).toBeNull();
    await db.updateSettings({ requireLogin: false });
    // Two active users: login off no longer opens the instance (YAN-356).
    expect(await s.resolvePrincipal(req())).toBeNull();
    await db.deleteUserUnscoped(t.b.user.id);
    expect(await s.resolvePrincipal(req())).toMatchObject({ userId: t.a.user.id, via: "local" });
    // Nothing to revoke in single-user mode, so no peer can sign the owner out.
    const { POST } = await import("@/app/api/auth/logout-all/route.js");
    expect((await POST()).status).toBe(401);
  });

  it("describes the principal without secrets", async () => {
    const p = await s.resolvePrincipal(req({ token: await tokenFor(t.a) }));
    const out = await s.describePrincipal(p);
    expect(out).toMatchObject({ role: "owner", via: "session", user: { id: t.a.user.id } });
    expect(JSON.stringify(out)).not.toMatch(/passwordHash|sessionVersion/);
  });
});

describe("switch on: route handlers", () => {
  beforeEach(async () => {
    jar.cookies.clear();
    await load("on");
    await db.updateSettings({ requireLogin: true });
    t = await seedTenancy();
  });

  it("logout-all revokes every token of the caller and clears the cookie", async () => {
    const other = await tokenFor(t.a);
    jar.cookies.set("auth_token", await tokenFor(t.a));
    const { POST } = await import("@/app/api/auth/logout-all/route.js");
    expect((await POST()).status).toBe(200);
    expect(jar.cookies.has("auth_token")).toBe(false);
    expect(await s.hasValidSession(req({ token: other }))).toBe(false);
    expect((await POST()).status).toBe(401);
  });

  it("a password change signs out other devices but re-mints the caller's cookie", async () => {
    const other = await tokenFor(t.a);
    jar.cookies.set("auth_token", await tokenFor(t.a, { amr: ["oidc"], wid: t.shared.id }));
    await s.revokeOwnerSessions(req());
    expect(await s.hasValidSession(req({ token: other }))).toBe(false);
    const mine = jar.cookies.get("auth_token");
    expect(await s.hasValidSession(req({ token: mine }))).toBe(true);
    expect(await jwt.getDashboardAuthSession(mine)).toMatchObject({
      sub: t.a.user.id,
      amr: ["oidc"],
      wid: t.shared.id,
    });
  });

  it("a password reset signs the owner out everywhere", async () => {
    const token = await tokenFor(t.a);
    const { POST } = await import("@/app/api/auth/reset-password/route.js");
    expect((await POST()).status).toBe(200);
    expect(await s.hasValidSession(req({ token }))).toBe(false);
  });

  it("status reports the principal without secrets and drops revoked sessions", async () => {
    jar.cookies.set("auth_token", await tokenFor(t.a));
    const { GET } = await import("@/app/api/auth/status/route.js");
    const body = await (await GET()).json();
    expect(body).toMatchObject({ authenticated: true, principal: { role: "owner" } });
    expect(JSON.stringify(body)).not.toMatch(/passwordHash|sessionVersion|"sv"/);
    await db.bumpSessionVersion(t.a.user.id);
    expect(await (await GET()).json()).toMatchObject({ authenticated: false, principal: null });
  });

  it("fails closed when the users table is unreadable", async () => {
    const token = await tokenFor(t.a);
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    adapter.run("ALTER TABLE users RENAME TO users_gone");
    try {
      expect(await s.hasValidSession(req({ token }))).toBe(false);
    } finally {
      adapter.run("ALTER TABLE users_gone RENAME TO users");
    }
  });
});

describe("switch off: today's behaviour", () => {
  beforeEach(async () => {
    await load("off");
    t = await seedTenancy();
  });

  it("mints no new claims and resolves no principal", async () => {
    expect(await s.sessionClaims("pwd")).toEqual({});
    expect(await s.resolvePrincipal(req({ token: await tokenFor(t.a) }))).toBeNull();
  });

  it("checks tokens by signature only, so a bump doesn't revoke", async () => {
    const token = await tokenFor(t.b);
    await db.bumpSessionVersion(t.b.user.id);
    expect(await s.hasValidSession(req({ token }))).toBe(true);
    expect(await s.hasValidSession(req({ token: await jwt.createDashboardAuthToken() }))).toBe(
      true,
    );
    expect(await s.hasValidSession(req({ token: "garbage" }))).toBe(false);
  });

  it("hides logout-all", async () => {
    const { POST } = await import("@/app/api/auth/logout-all/route.js");
    expect((await POST()).status).toBe(404);
  });

  it("accepts the CLI token from anywhere", async () => {
    const { getCliToken, CLI_TOKEN_HEADER } = await import("@/lib/auth/cliToken");
    expect(
      await s.cliTokenAccepted(req({ headers: { [CLI_TOKEN_HEADER]: await getCliToken() } })),
    ).toBe(true);
  });
});
