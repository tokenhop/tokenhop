// YAN-358 test-first frozen contract: independent IP and account lockouts.
// Critical negatives only: locks engage before any bcrypt work, unknown
// identifiers accrue, one bucket's success never clears the other, and a
// spoofed x-9r-real-ip without the trusted peer token cannot escape a bucket.
// Route-integration only — limiter helper API is NOT frozen; backend writes it
// concurrently, so this file is red-first by design.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const PEER = "peer-token-yan-358-limiter";
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

async function load(state = "on") {
  vi.resetModules();
  process.env[ENV] = state;
  db = await import("@/lib/db/index.js");
  try {
    loginPOST = (await import("@/app/api/auth/login/route.js")).POST;
  } catch {
    loginPOST = null;
  }
}

const peer = (ip) => ({ "x-9r-peer-token": PEER, "x-9r-real-ip": ip, host: "localhost" });

function req(body, headers) {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json", ...headers }),
    body: JSON.stringify(body),
  });
}

const bad = (login) => ({ login, password: "wrong-pw-xyz" });

async function seed() {
  const t = await seedTenancy();
  await db.updateSettings({ requireLogin: true });
  const hash = await bcrypt.hash("user-pw-15+", 4);
  await db.updateUserUnscoped(t.a.user.id, { passwordHash: hash });
  await db.updateUserUnscoped(t.b.user.id, { passwordHash: hash });
  return t;
}

// Fail up to n times for the same IP/login, return the final response.
async function failNTimes(n, body, headers) {
  let last = null;
  for (let i = 0; i < n; i++) last = await loginPOST(req(body, headers));
  return last;
}

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("YAN-358 login limiter", () => {
  beforeEach(async () => {
    jar.cookies.clear();
    jar.writes.length = 0;
    jar.deletes.length = 0;
    await load("on");
  });

  it("exposes POST /api/auth/login (fails until backend lands)", () => {
    expect(loginPOST, "backend pending: login route").toBeTypeOf("function");
  });

  it("IP lock: many accounts from one IP lock that IP for everyone", async () => {
    if (!loginPOST) return expect(loginPOST).toBeTypeOf("function");
    await seed();
    const ip = peer("10.7.0.1");
    // Alternate targets: identical-account lockout must not mask the IP bucket.
    await failNTimes(3, bad("b@tenancy.test"), ip);
    const last = await failNTimes(3, bad("a@tenancy.test"), ip);
    expect(last.status).toBe(429);
    expect(last.headers.get("retry-after")).toBeTruthy();
    expect(await last.json()).toMatchObject({ retryAfter: expect.any(Number) });
    // Even a *valid* third login from the locked IP is refused first.
    const other = await loginPOST(
      req({ login: "nobody@tenancy.test", password: "whatever-pw" }, ip),
    );
    expect(other.status).toBe(429);
  });

  it("locked bucket returns before any bcrypt.compare runs", async () => {
    if (!loginPOST) return expect(loginPOST).toBeTypeOf("function");
    await seed();
    const ip = peer("10.7.0.2");
    await failNTimes(6, bad("b@tenancy.test"), ip);
    const spy = vi.spyOn(bcrypt, "compare");
    spy.mockClear();
    const res = await loginPOST(req(bad("b@tenancy.test"), ip));
    expect(res.status).toBe(429);
    expect(spy, "no bcrypt work while locked").not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("account lock: one account attacked from many IPs locks the account", async () => {
    if (!loginPOST) return expect(loginPOST).toBeTypeOf("function");
    await seed();
    // Rotating source IPs must not dilute the per-account bucket.
    for (let i = 0; i < 7; i++) {
      await loginPOST(req(bad("b@tenancy.test"), peer(`10.7.1.${i}`)));
    }
    // Fresh, never-used IP: still refused for that account.
    const res = await loginPOST(req(bad("b@tenancy.test"), peer("10.7.9.9")));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    // Unrelated account from a clean IP still works (independent buckets).
    const ok = await loginPOST(
      req({ login: "a@tenancy.test", password: "user-pw-15+" }, peer("10.7.8.8")),
    );
    expect(ok.status).toBe(200);
  });

  it("unknown identifiers accrue their own normalized lockout", async () => {
    if (!loginPOST) return expect(loginPOST).toBeTypeOf("function");
    await seed();
    // Same unknown login, case/whitespace variants, from many IPs.
    for (let i = 0; i < 10; i++) {
      await loginPOST(
        req(bad(i % 2 ? "Ghost@Tenancy.test" : " ghost@tenancy.test "), peer(`10.7.2.${i}`)),
      );
    }
    // Normalized variants share one bucket, so repeated failures must accrue
    // to an eventual 429. Retrying from a fresh IP proves the account-side
    // bucket (not just the per-IP one) recorded the failures.
    let res = null;
    for (let i = 0; i < 5 && res?.status !== 429; i++) {
      res = await loginPOST(req(bad("GHOST@tenancy.test"), peer(`10.7.2.${100 + i}`)));
    }
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("a success on one bucket does not clear the attacker's other bucket", async () => {
    if (!loginPOST) return expect(loginPOST).toBeTypeOf("function");
    await seed();
    const attacker = peer("10.7.3.1");
    await failNTimes(6, bad("b@tenancy.test"), attacker); // locks attacker's IP
    // Legit success elsewhere must not unblock the attacker.
    const ok = await loginPOST(
      req({ login: "a@tenancy.test", password: "user-pw-15+" }, peer("10.7.3.9")),
    );
    expect(ok.status).toBe(200);
    const still = await loginPOST(req(bad("b@tenancy.test"), attacker));
    expect(still.status).toBe(429);
  });

  it("spoofed x-9r-real-ip without the peer token cannot escape the bucket", async () => {
    if (!loginPOST) return expect(loginPOST).toBeTypeOf("function");
    await seed();
    const spoof = (ip) => ({ "x-9r-real-ip": ip, host: "localhost" }); // no peer token
    await failNTimes(6, bad("b@tenancy.test"), spoof("10.7.4.1"));
    // Rotate the spoofed IP: without trusted headers this is one shared bucket.
    const res = await loginPOST(req(bad("b@tenancy.test"), spoof("10.7.4.99")));
    expect(res.status).toBe(429);
    // A genuinely different trusted IP + untouched account is not caught by it.
    const clean = await loginPOST(req(bad("a@tenancy.test"), peer("10.7.5.1")));
    expect(clean.status).toBe(401);
  });
});
