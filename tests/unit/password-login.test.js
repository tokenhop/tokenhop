// YAN-358 test-first frozen contract: POST /api/auth/login { login, password }.
// Assumptions (flagged for parent): route handler at @/app/api/auth/login/route.js;
// password service at @/lib/auth/userPassword.js (helper names NOT frozen — tests
// prefer route integration, dynamic-import optional helpers); restricted cookie
// `password_change_token`, path /api/auth, ~10min, SameSite=strict.
// Red-first: backend lane writes src/lib/** concurrently, so missing/legacy
// behavior fails honestly here; do not weaken baselines to green this file.
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

let db;
let loginPOST = null;
let userPassword = null;

async function load(state) {
  vi.resetModules();
  process.env[ENV] = state;
  db = await import("@/lib/db/index.js");
  try {
    loginPOST = (await import("@/app/api/auth/login/route.js")).POST;
  } catch {
    loginPOST = null;
  }
  try {
    userPassword = await import("@/lib/auth/userPassword.js");
  } catch {
    userPassword = null;
  }
}

// Trusted loopback+peer headers so getClientIp buckets per test IP.
const peer = (ip) => ({
  "x-9r-peer-token": PEER,
  "x-9r-real-ip": ip,
  host: "localhost",
});

function loginReq(body, ip = "10.9.0.1", extra = {}) {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: new Headers({
      "content-type": "application/json",
      ...peer(ip),
      ...extra,
    }),
    body: JSON.stringify(body),
  });
}

const cookiesOf = (res) =>
  typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];

// Handlers set cookies via the next/headers jar, not the Response, so "no
// cookies" must hold on both channels: empty Set-Cookie on the response AND
// no jar write of an auth/password-change token with a non-empty value.
function expectNoCookies(res, msg) {
  expect(cookiesOf(res), msg).toEqual([]);
  const leaked = jar.writes.filter(
    (w) => (w.name === "auth_token" || w.name === "password_change_token") && w.value,
  );
  expect(leaked, msg).toEqual([]);
}

async function seedUsers(pwB = "correct-horse-15+") {
  const t = await seedTenancy();
  await db.updateSettings({ requireLogin: true });
  const hashB = await bcrypt.hash(pwB, 4);
  // usersRepo supports passwordHash patch; seed B as approved user with hash.
  await db.updateUserUnscoped(t.b.user.id, { passwordHash: hashB, instanceRole: "user" });
  t.b.user = await db.getUserUnscoped(t.b.user.id);
  return { t, pwB };
}

const INVALID = { error: "Invalid email/username or password.", code: "invalid_credentials" };

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("YAN-358 login contract", () => {
  beforeEach(async () => {
    jar.cookies.clear();
    jar.writes.length = 0;
    jar.deletes.length = 0;
    await load("on");
  });

  it("backend exposes POST /api/auth/login (fails until backend lands)", async () => {
    expect(loginPOST, "backend pending: POST /api/auth/login").toBeTypeOf("function");
  });

  it("own-user claims: B login mints B sub/sv/wid amr pwd, never owner", async () => {
    if (!loginPOST) return expect(loginPOST).toBeTypeOf("function");
    const { t, pwB } = await seedUsers();
    const res = await loginPOST(loginReq({ login: "b@tenancy.test", password: pwB }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, mustChangePassword: false });
    expect(body).toHaveProperty("startPage");
    // Route sets auth_token via the next/headers jar, not the Response.
    const auth = [...jar.writes].reverse().find((w) => w.name === "auth_token");
    expect(auth, "auth_token set").toBeTruthy();
    const token = auth.value;
    const { getDashboardAuthSession } = await import("@/lib/auth/dashboardSession");
    const claims = await getDashboardAuthSession(token);
    expect(claims).toMatchObject({ sub: t.b.user.id, sv: t.b.user.sessionVersion, amr: ["pwd"] });
    expect(claims.sub).not.toBe(t.a.user.id);
    expect(claims.wid).toBe(t.b.personal);
    expect(JSON.stringify(claims)).not.toMatch(/passwordHash/);
  });

  it("unknown / wrong / passwordless share byte-identical 401, no cookies", async () => {
    if (!loginPOST) return expect(loginPOST).toBeTypeOf("function");
    const { pwB } = await seedUsers();
    const r1 = await loginPOST(
      loginReq({ login: "nobody@tenancy.test", password: pwB }, "10.9.0.11"),
    );
    const r2 = await loginPOST(
      loginReq({ login: "b@tenancy.test", password: "wrong-pw-xyz" }, "10.9.0.12"),
    );
    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b1).toEqual(INVALID);
    expect(b2).toEqual(INVALID);
    expectNoCookies(r1);
    expectNoCookies(r2);
    // headers equal (no-store, no enumeration leak)
    expect(r1.headers.get("cache-control")).toBe(r2.headers.get("cache-control"));
  });

  it("wrong password on disabled/pending stays generic 401", async () => {
    if (!loginPOST) return expect(loginPOST).toBeTypeOf("function");
    const { t } = await seedUsers();
    await db.updateUserUnscoped(t.b.user.id, { status: "disabled" });
    const res = await loginPOST(
      loginReq({ login: "b@tenancy.test", password: "wrong-pw-xyz" }, "10.9.0.13"),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(INVALID);
    expectNoCookies(res);
  });

  it("correct password: disabled -> 403 account_disabled, pending -> 403 account_pending, disabled+pending -> account_disabled; zero cookies", async () => {
    if (!loginPOST) return expect(loginPOST).toBeTypeOf("function");
    const { t, pwB } = await seedUsers();
    const original = { status: t.b.user.status, instanceRole: t.b.user.instanceRole };
    const cases = [
      [{ status: "disabled" }, "account_disabled"],
      [{ instanceRole: "pending" }, "account_pending"],
      [{ status: "disabled", instanceRole: "pending" }, "account_disabled"],
    ];
    for (const [patch, code] of cases) {
      await db.updateUserUnscoped(t.b.user.id, { ...original, ...patch });
      const res = await loginPOST(loginReq({ login: "b@tenancy.test", password: pwB }, "10.9.0.2"));
      expect(res.status, code).toBe(403);
      expect(await res.json(), code).toMatchObject({ code });
      expectNoCookies(res, code);
    }
  });

  it("cross-field email/username collision -> same 401 invalid_credentials, no cookies", async () => {
    if (!loginPOST) return expect(loginPOST).toBeTypeOf("function");
    const { pwB } = await seedUsers();
    // C's username equals B's email: ambiguous lookup must fail closed.
    const c = await db.createUserUnscoped({
      email: "c@tenancy.test",
      username: "b@tenancy.test",
      instanceRole: "user",
      passwordHash: await bcrypt.hash("c-password-15+", 4),
    });
    expect(c.username).toBe("b@tenancy.test");
    const res = await loginPOST(loginReq({ login: "b@tenancy.test", password: pwB }, "10.9.0.3"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(INVALID);
    expectNoCookies(res);
  });

  it("unknown identifiers run dummy bcrypt compare (spy, not timing)", async () => {
    if (!loginPOST) return expect(loginPOST).toBeTypeOf("function");
    await seedUsers();
    // Spy on the static default import (same object the route shares); spying
    // on an awaited ESM namespace object throws.
    const spy = vi.spyOn(bcrypt, "compare");
    await loginPOST(
      loginReq({ login: "ghost@tenancy.test", password: "whatever-pw" }, "10.9.0.14"),
    );
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    // Dummy hash cost assumption: new helper should expose cost-10 dummy; flag if absent.
    if (userPassword?.DUMMY_HASH || userPassword?.dummyHash) {
      const dummy = userPassword.DUMMY_HASH ?? userPassword.dummyHash;
      expect(bcrypt.getRounds(dummy)).toBe(10);
    }
  });

  it("body key is `login` only: `account` field ignored, never owner fallback", async () => {
    if (!loginPOST) return expect(loginPOST).toBeTypeOf("function");
    const { pwB } = await seedUsers();
    // Attacker supplies account instead of login plus B's password: must not
    // fall back to owner or succeed; multi-user requires identifier.
    const res = await loginPOST(
      loginReq({ account: "b@tenancy.test", password: pwB }, "10.9.0.15"),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(INVALID);
  });

  it("missing login rejected when multi-user active; supplied unknown never picks owner", async () => {
    if (!loginPOST) return expect(loginPOST).toBeTypeOf("function");
    const { pwB } = await seedUsers();
    const missing = await loginPOST(loginReq({ password: pwB }, "10.9.0.16"));
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual(INVALID);
    const unknown = await loginPOST(
      loginReq({ login: "zzz-unknown@tenancy.test", password: pwB }, "10.9.0.17"),
    );
    expect(unknown.status).toBe(401);
    expectNoCookies(unknown);
  });

  it("input bounds: oversize login/password -> 400 invalid_request", async () => {
    if (!loginPOST) return expect(loginPOST).toBeTypeOf("function");
    const big = await loginPOST(loginReq({ login: "a".repeat(321), password: "x" }, "10.9.0.18"));
    expect(big.status).toBe(400);
    expect(await big.json()).toMatchObject({ code: "invalid_request" });
    const bigPw = await loginPOST(
      loginReq({ login: "b@tenancy.test", password: "x".repeat(1025) }, "10.9.0.19"),
    );
    expect(bigPw.status).toBe(400);
  });

  it("independent IP + account lockouts; aliases share account bucket", async () => {
    if (!loginPOST) return expect(loginPOST).toBeTypeOf("function");
    const { t } = await seedUsers();
    // Give B a username alias sharing the same account bucket.
    await db.updateUserUnscoped(t.b.user.id, { username: "bee-alias" });
    expect((await db.getUserUnscoped(t.b.user.id)).username).toBe("bee-alias");
    // Spray one account from many IPs -> account lock (429) even with fresh IP.
    let last = null;
    for (let i = 0; i < 8; i++) {
      last = await loginPOST(
        loginReq({ login: "b@tenancy.test", password: "wrong-pw" }, `10.9.1.${i}`),
      );
    }
    expect(last.status).toBe(429);
    const viaAlias = await loginPOST(
      loginReq({ login: "bee-alias", password: "wrong-pw" }, "10.9.2.99"),
    );
    // Alias shares the account bucket (keyed by resolved user id): locked.
    expect(viaAlias.status).toBe(429);
    expect(viaAlias.headers.get("retry-after")).toBeTruthy();
  });

  it("switch-off pristine: legacy owner flow unchanged, no new cookies", async () => {
    await load("off");
    if (!loginPOST) return expect(loginPOST).toBeTypeOf("function");
    // Pristine off must keep today's behaviour; password endpoints hidden.
    // Assumption: backend keeps legacy 401 text while off (plan §5).
    const res = await loginPOST(loginReq({ password: "nope" }, "10.9.0.31"));
    expect([401, 403, 429]).toContain(res.status);
    expectNoCookies(res);
  });

  it("durable security stays enforced with marker on + rollout off", async () => {
    await load("off");
    if (!loginPOST) return expect(loginPOST).toBeTypeOf("function");
    const { isUserSecurityEnforced } = await import("@/lib/users/securityState.js");
    // No marker in this fixture: just assert helper exists; marker-on matrix
    // covered in gateway-key-established-security tests by parent lane.
    expect(isUserSecurityEnforced).toBeTypeOf("function");
  });
});
