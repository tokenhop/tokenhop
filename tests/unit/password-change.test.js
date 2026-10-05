// YAN-358 test-first frozen contract: POST /api/auth/change-password
// { currentPassword, newPassword } and POST /api/users/[id]/password { password };
// restricted `password_change_token` (Path=/api/auth, SameSite=strict, ~10min) is
// never a normal principal. Assumptions (flagged for parent): handler paths under
// @/app/api/...; helper module @/lib/auth/userPassword.js names NOT frozen —
// tests drive routes + db only. Red-first while backend writes src/**.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const PEER = "peer-token-yan-358";
process.env.TOKENHOP_PEER_TOKEN = PEER;

// Handlers set cookies via the next/headers jar, not the response, so the
// jar records writes (name/value/options) and deletes for assertions.
const jar = vi.hoisted(() => ({
  cookies: new Map(),
  writes: [],
  deletes: [],
  headers: new Headers(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n) => (jar.cookies.has(n) ? { name: n, value: jar.cookies.get(n) } : undefined),
    set: (n, v, opts = {}) => {
      // Browser semantics: an expired/maxAge-0 Set-Cookie removes the cookie.
      const expired = opts.maxAge === 0 || (opts.expires && new Date(opts.expires) <= new Date());
      if (expired) jar.cookies.delete(n);
      else jar.cookies.set(n, v);
      jar.writes.push({ name: n, value: v, options: opts });
    },
    delete: (n) => {
      jar.cookies.delete(n);
      jar.deletes.push(n);
    },
  }),
  headers: async () => jar.headers,
}));

const PW_B = "correct-horse-15+";
const PW_NEW = "fresh-secret-15+";

let s;
let db;
let jwt;
let loginPOST = null;
let changePOST = null;
let adminPOST = null;
let statusGET = null;
let proxy = null;

async function load(state) {
  vi.resetModules();
  process.env[ENV] = state;
  s = await import("@/lib/users/session");
  db = await import("@/lib/db/index.js");
  jwt = await import("@/lib/auth/dashboardSession");
  // Aliased specifiers survive variable-import resolution on every runner;
  // relative ones do not (vitest 5.0.2 vite resolves a variable relative
  // specifier from the project root → "/src/dashboardGuard.js"), so that one
  // uses a literal import and fails loudly instead of returning null.
  const grab = async (path, key) => {
    try {
      return (await import(path))[key];
    } catch {
      return null;
    }
  };
  loginPOST = await grab("@/app/api/auth/login/route.js", "POST");
  changePOST = await grab("@/app/api/auth/change-password/route.js", "POST");
  adminPOST = await grab("@/app/api/users/[id]/password/route.js", "POST");
  statusGET = await grab("@/app/api/auth/status/route.js", "GET");
  proxy = (await import("../../src/dashboardGuard.js")).proxy;
}

const peer = (ip) => ({ "x-9r-peer-token": PEER, "x-9r-real-ip": ip, host: "localhost" });

const loginReq = (body, ip = "10.8.0.1") =>
  new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json", ...peer(ip) }),
    body: JSON.stringify(body),
  });

const changeReq = (body) =>
  new NextRequest("http://localhost/api/auth/change-password", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });

const cookiesOf = (res) =>
  typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
// Last non-empty write of a cookie, from the recorded jar writes.
const lastWrite = (name) => [...jar.writes].reverse().find((w) => w.name === name && w.value);

const tokenFor = (u, extra = {}) =>
  jwt.createDashboardAuthToken({
    sub: u.user.id,
    sv: u.user.sessionVersion,
    wid: u.personal,
    amr: ["pwd"],
    ...extra,
  });

// Owner A with a password hash; user B with PW_B; both approved/active.
async function seed() {
  const t = await seedTenancy();
  await db.updateSettings({ requireLogin: true });
  await db.updateUserUnscoped(t.a.user.id, { passwordHash: await bcrypt.hash("owner-pw-15+", 4) });
  await db.updateUserUnscoped(t.b.user.id, { passwordHash: await bcrypt.hash(PW_B, 4) });
  t.a.user = await db.getUserUnscoped(t.a.user.id);
  t.b.user = await db.getUserUnscoped(t.b.user.id);
  return t;
}

const clearJar = () => {
  jar.cookies.clear();
  jar.writes.length = 0;
  jar.deletes.length = 0;
};

// Full-session call as a seeded user through the next/headers jar. Returns the
// handler result plus the auth_token the handler minted (captured before the
// jar is cleared in `finally`).
async function asUser(u, fn) {
  jar.cookies.set("auth_token", await tokenFor(u));
  try {
    return await fn();
  } finally {
    clearJar();
  }
}

// Feed the challenge cookie the login handler wrote into the jar.
const setChallenge = (value) => jar.cookies.set("password_change_token", value);

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("YAN-358 self-service change-password", () => {
  beforeEach(async () => {
    clearJar();
    await load("on");
  });

  it("exposes POST /api/auth/change-password (fails until backend lands)", () => {
    expect(changePOST, "backend pending: change-password route").toBeTypeOf("function");
  });

  it("self change with current password bumps sv, invalidates old token, re-mints", async () => {
    if (!changePOST) return expect(changePOST).toBeTypeOf("function");
    const t = await seed();
    const oldToken = await tokenFor(t.b);
    // Capture jar state inside the callback: asUser clears the jar in finally.
    const { res, fresh, challengeSet } = await asUser(t.b, async () => {
      const r = await changePOST(changeReq({ currentPassword: PW_B, newPassword: PW_NEW }));
      return {
        res: r,
        fresh: jar.cookies.get("auth_token") ?? lastWrite("auth_token")?.value,
        challengeSet: jar.cookies.has("password_change_token"),
      };
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true });
    expect(body).toHaveProperty("startPage");
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    const after = await db.getUserUnscoped(t.b.user.id);
    expect(after.sessionVersion).toBe(t.b.user.sessionVersion + 1);
    expect(challengeSet).toBe(false);
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(oldToken);
    expect(await jwt.getDashboardAuthSession(fresh)).toMatchObject({
      sub: t.b.user.id,
      sv: after.sessionVersion,
      amr: ["pwd"],
      authenticated: true,
    });
    // Old token revoked next request.
    expect(
      await s.hasValidSession(
        new NextRequest("http://localhost/api/x", {
          headers: new Headers({ cookie: `auth_token=${oldToken}` }),
        }),
      ),
    ).toBe(false);
    // Owner and settings mirror untouched by B's change.
    expect(await db.getUserPasswordHashUnscoped(t.a.user.id)).toBeTruthy();
  });

  it("wrong current password -> 401 invalid_current_password; nothing changes", async () => {
    if (!changePOST) return expect(changePOST).toBeTypeOf("function");
    const t = await seed();
    const hashBefore = await db.getUserPasswordHashUnscoped(t.b.user.id);
    const res = await asUser(t.b, () =>
      changePOST(changeReq({ currentPassword: "totally-wrong-9", newPassword: PW_NEW })),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "invalid_current_password" });
    expect(await db.getUserPasswordHashUnscoped(t.b.user.id)).toBe(hashBefore);
    expect((await db.getUserUnscoped(t.b.user.id)).sessionVersion).toBe(t.b.user.sessionVersion);
  });

  it("extra targeting fields (login/userId/account) -> 400; subject only from credential", async () => {
    if (!changePOST) return expect(changePOST).toBeTypeOf("function");
    const t = await seed();
    for (const field of ["login", "userId", "account"]) {
      const res = await asUser(t.b, () =>
        changePOST(changeReq({ currentPassword: PW_B, newPassword: PW_NEW, [field]: t.a.user.id })),
      );
      expect(res.status, field).toBe(400);
      expect(await res.json()).toMatchObject({ code: expect.any(String) });
    }
    // A's hash never touched by B's attempt.
    expect(await db.getUserPasswordHashUnscoped(t.a.user.id)).toBeTruthy();
  });

  it("new-password policy: short / >72 bytes / reused / default -> 400 codes", async () => {
    if (!changePOST) return expect(changePOST).toBeTypeOf("function");
    const t = await seed();
    const cases = [
      ["short7!", "password_too_short"],
      ["a".repeat(80), "password_too_long"],
      [PW_B, "password_reused"],
      // "123456" is 6 chars so it hits the 8-char minimum first.
      ["123456", "password_too_short"],
      ["short-7", "password_too_short"],
    ];
    for (const [newPassword, code] of cases) {
      const res = await asUser(t.b, () =>
        changePOST(changeReq({ currentPassword: PW_B, newPassword })),
      );
      expect(res.status, code).toBe(400);
      expect(await res.json(), code).toMatchObject({ code });
    }
    // The public default rejected by the dedicated password_default branch.
    const savedInit = process.env.INITIAL_PASSWORD;
    process.env.INITIAL_PASSWORD = "FromEnvInit-99";
    try {
      const res = await asUser(t.b, () =>
        changePOST(changeReq({ currentPassword: PW_B, newPassword: "FromEnvInit-99" })),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "password_default" });
      const resDefault = await asUser(t.b, () =>
        changePOST(changeReq({ currentPassword: PW_B, newPassword: "87654321" })),
      );
      expect(await resDefault.json()).not.toMatchObject({ code: "password_default" });
    } finally {
      if (savedInit === undefined) delete process.env.INITIAL_PASSWORD;
      else process.env.INITIAL_PASSWORD = savedInit;
    }
  });

  it("pristine switch-off hides the route (404), legacy settings flow untouched", async () => {
    await load("off");
    if (!changePOST) return expect(changePOST).toBeTypeOf("function");
    const res = await changePOST(changeReq({ currentPassword: "x", newPassword: "y-y-y-y-y-y-y" }));
    expect(res.status).toBe(404);
  });
});

describe("YAN-358 admin temporary password + restricted challenge", () => {
  beforeEach(async () => {
    clearJar();
    await load("on");
  });

  it("exposes POST /api/users/[id]/password (fails until backend lands)", () => {
    expect(adminPOST, "backend pending: admin password route").toBeTypeOf("function");
  });

  it("owner sets temp password: durable flag, one bump, sessions revoked, no cookie for target", async () => {
    if (!adminPOST) return expect(adminPOST).toBeTypeOf("function");
    const t = await seed();
    const oldToken = await tokenFor(t.b);
    const sv = t.b.user.sessionVersion;
    const res = await asUser(t.a, () =>
      adminPOST(changeReq({ password: "Temp-pass-9" }), {
        params: Promise.resolve({ id: t.b.user.id }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });
    // No target session is ever minted.
    expect(cookiesOf(res).filter((c) => c.startsWith("auth_token="))).toEqual([]);
    const b = await db.getUserUnscoped(t.b.user.id);
    expect(b.sessionVersion).toBe(sv + 1);
    // mustChangePassword persisted (column from migration 007).
    expect(b.mustChangePassword ?? null, "users.mustChangePassword column/flag").toBe(1);
    expect(
      await s.hasValidSession(
        new NextRequest("http://localhost/api/x", {
          headers: new Headers({ cookie: `auth_token=${oldToken}` }),
        }),
      ),
    ).toBe(false);
  });

  it("admin target restrictions: no self, no owner, no peer admin, user 403, unknown 404", async () => {
    if (!adminPOST) return expect(adminPOST).toBeTypeOf("function");
    const t = await seed();
    const admin2 = await db.createUserUnscoped({
      email: "admin2@tenancy.test",
      instanceRole: "admin",
      passwordHash: await bcrypt.hash("admin2-pw-15+", 4),
    });
    const call = (as, id) =>
      asUser(as, () =>
        adminPOST(changeReq({ password: "Temp-pass-9" }), { params: Promise.resolve({ id }) }),
      );
    // Ordinary user lacks instance.users.manage. Must run BEFORE any reset of B:
    // a reset bumps B's sv and sets mustChangePassword, so B's session would
    // resolve to 401 instead of the authorize() 403.
    expect((await call(t.b, t.b.user.id)).status).toBe(403);
    // Admin may reset ordinary user; never self, owner or peer admin.
    const adminSeeded = { user: admin2, personal: admin2.personalWorkspaceId };
    expect((await call(adminSeeded, t.b.user.id)).status).toBe(200);
    for (const id of [admin2.id, t.a.user.id]) {
      const res = await call(adminSeeded, id);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "forbidden_target" });
    }
    expect((await call(adminSeeded, admin2.id)).status).toBe(403);
    expect((await call(t.a, "no-such-user")).status).toBe(404);
    // Owner may reset other non-owner users.
    expect((await call(t.a, t.b.user.id)).status).toBe(200);
  });

  it("temp login -> 403 password_change_required with restricted cookie only", async () => {
    if (!adminPOST || !loginPOST) return expect(adminPOST).toBeTypeOf("function");
    const t = await seed();
    await asUser(t.a, () =>
      adminPOST(changeReq({ password: "Temp-pass-9" }), {
        params: Promise.resolve({ id: t.b.user.id }),
      }),
    );
    const res = await loginPOST(loginReq({ login: "b@tenancy.test", password: "Temp-pass-9" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: "password_change_required",
      mustChangePassword: true,
      reason: "temporary",
      passwordMinLength: 8,
    });
    // Login handlers write via the next/headers jar, not the response.
    expect(cookiesOf(res)).toEqual([]);
    const challengeWrite = lastWrite("password_change_token");
    expect(challengeWrite, "challenge cookie").toBeTruthy();
    expect(challengeWrite.value).toBeTruthy();
    expect(challengeWrite.options).toMatchObject({
      path: "/api/auth",
      sameSite: "strict",
      maxAge: 600,
      httpOnly: true,
    });
    // No full session is ever minted with the challenge.
    expect(lastWrite("auth_token")).toBeUndefined();
    const raw = challengeWrite.value;
    // getDashboardAuthSession rejects purpose tokens by design (security
    // property); readSignedAuthToken decodes the raw claims.
    expect(await jwt.getDashboardAuthSession(raw)).toBeNull();
    const claims = await jwt.readSignedAuthToken(raw);
    expect(claims).toMatchObject({
      sub: t.b.user.id,
      purpose: "password-change",
      authenticated: false,
      amr: ["pwd"],
    });

    // Challenge cannot become a normal principal — handler-level, no proxy.
    const reqChallenge = (path) =>
      new NextRequest(`http://localhost${path}`, {
        headers: new Headers({ cookie: `auth_token=${raw}` }),
      });
    expect(await s.hasValidSession(reqChallenge("/api/x"))).toBe(false);
    expect(await s.resolvePrincipal(reqChallenge("/api/x"))).toBeNull();
    expect(await s.isLiveSession(raw)).toBe(false);
    // Guard: dashboard redirects to login with the allowlisted error; APIs refuse.
    expect(proxy).toBeTypeOf("function");
    const dash = await proxy(reqChallenge("/dashboard"));
    expect(dash.status).toBe(307);
    // A challenge pasted into auth_token earns nothing: plain login redirect.
    expect(dash.headers.get("location")).toMatch(/\/login$/);
    expect((await proxy(reqChallenge("/api/settings"))).status).toBe(401);
    // Status: authenticated false, mustChangePassword true.
    setChallenge(raw);
    if (statusGET) {
      const body = await (await statusGET()).json();
      expect(body).toMatchObject({ authenticated: false, mustChangePassword: true });
    }
    jar.cookies.clear();
  });

  it("challenge rotation: verify temp, mint fresh full session, revoke everything else", async () => {
    if (!adminPOST || !loginPOST || !changePOST) return expect(changePOST).toBeTypeOf("function");
    const t = await seed();
    await asUser(t.a, () =>
      adminPOST(changeReq({ password: "Temp-pass-9" }), {
        params: Promise.resolve({ id: t.b.user.id }),
      }),
    );
    await loginPOST(loginReq({ login: "b@tenancy.test", password: "Temp-pass-9" }));
    // Cookies go to the jar, not the response; keep the challenge in the jar
    // and make sure no full auth_token is left over.
    const challenge =
      jar.cookies.get("password_change_token") ?? lastWrite("password_change_token")?.value;
    expect(challenge, "challenge cookie from jar").toBeTruthy();
    setChallenge(challenge);
    jar.cookies.delete("auth_token");
    const done = await changePOST(
      changeReq({ currentPassword: "Temp-pass-9", newPassword: PW_NEW }),
    );
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ success: true });
    expect(jar.cookies.has("password_change_token")).toBe(false);
    const b = await db.getUserUnscoped(t.b.user.id);
    expect(b.mustChangePassword ?? 0).toBe(0);
    const fresh = jar.cookies.get("auth_token");
    expect(fresh).toBeTruthy();
    const freshClaims = await jwt.getDashboardAuthSession(fresh);
    expect(freshClaims).toMatchObject({
      sub: t.b.user.id,
      sv: b.sessionVersion,
      authenticated: true,
    });
    expect(freshClaims.purpose).toBeUndefined();
    // New password works; temp password is dead.
    const relogin = await loginPOST(loginReq({ login: "b@tenancy.test", password: PW_NEW }));
    expect(relogin.status).toBe(200);
    const stale = await loginPOST(
      loginReq({ login: "b@tenancy.test", password: "Temp-pass-9" }, "10.8.0.9"),
    );
    expect(stale.status).toBe(401);
  });

  it("durable must-change survives a module reload (restart)", async () => {
    if (!adminPOST || !loginPOST) return expect(adminPOST).toBeTypeOf("function");
    const t = await seed();
    await asUser(t.a, () =>
      adminPOST(changeReq({ password: "Temp-pass-9" }), {
        params: Promise.resolve({ id: t.b.user.id }),
      }),
    );
    // Same DATA_DIR, fresh modules = reopened DB.
    await load("on");
    const res = await loginPOST(loginReq({ login: "b@tenancy.test", password: "Temp-pass-9" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "password_change_required" });
  });

  it("pristine switch-off hides the admin route (404)", async () => {
    await load("off");
    if (!adminPOST) return expect(adminPOST).toBeTypeOf("function");
    const t = await seedTenancy();
    const res = await adminPOST(changeReq({ password: "Temp-pass-9" }), {
      params: Promise.resolve({ id: t.b.user.id }),
    });
    expect(res.status).toBe(404);
  });
});
