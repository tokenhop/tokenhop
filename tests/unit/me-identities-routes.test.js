// YAN-371: GET /api/me/identities and DELETE /api/me/identities/:id.
// Pins: 404 while off, no subject/userId in the DTO, cross-user 404, password
// row can't be unlinked, the last usable method can't be removed, and a
// successful unlink bumps sv (old tokens die).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];

let s;
let db;
let jwt;
let t;
let list;
let del;

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
  list = await import("@/app/api/me/identities/route.js");
  del = await import("@/app/api/me/identities/[id]/route.js");
}

async function signIn(seeded) {
  const user = await db.getUserUnscoped(seeded.user.id);
  const token = await jwt.createDashboardAuthToken({
    sub: user.id,
    sv: user.sessionVersion,
    wid: seeded.personal,
    amr: ["oidc"],
  });
  jar.cookies.set("auth_token", token);
  return token;
}

const link = (seeded, subject, provider = "oidc") =>
  db.linkIdentityUnscoped(seeded.user.id, { provider, issuer: "https://idp", subject });

const remove = (id, headers = {}) =>
  del.DELETE(
    new NextRequest(`http://localhost/api/me/identities/${id}`, {
      method: "DELETE",
      headers: new Headers(headers),
    }),
    { params: Promise.resolve({ id }) },
  );

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("switch off: hidden", () => {
  beforeEach(async () => {
    jar.cookies.clear();
    await load("off");
    t = await seedTenancy();
  });

  it("404s both routes", async () => {
    await signIn(t.a);
    expect((await list.GET()).status).toBe(404);
    expect((await remove("x")).status).toBe(404);
  });
});

describe("switch on", () => {
  beforeEach(async () => {
    jar.cookies.clear();
    await load("on");
    await db.updateSettings({ requireLogin: true, authMode: "both", ssoType: "oidc" });
    t = await seedTenancy();
  });

  it("GET never returns subject or userId", async () => {
    await link(t.a, "secret-subject-a");
    await signIn(t.a);
    const res = await list.GET();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("secret-subject-a");
    expect(text).not.toContain(t.a.user.id);
    expect(JSON.parse(text).identities[0]).toMatchObject({ provider: "oidc" });
  });

  it("B deleting A's identity: 404, A's row kept (cross-user negative)", async () => {
    const ida = await link(t.a, "sub-a");
    await signIn(t.b);
    expect((await remove(ida.id)).status).toBe(404);
    expect((await db.listIdentitiesUnscoped(t.a.user.id)).map((r) => r.id)).toContain(ida.id);
  });

  it("403 for a cross-site Origin", async () => {
    const ida = await link(t.a, "sub-a");
    await signIn(t.a);
    const res = await remove(ida.id, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("the only usable SSO identity in SSO-only mode: 409, row kept", async () => {
    await db.updateSettings({ authMode: "sso", ssoType: "oidc" });
    const ida = await link(t.a, "sub-a");
    await signIn(t.a);
    const res = await remove(ida.id);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: "last_login_method" });
    expect((await db.listIdentitiesUnscoped(t.a.user.id)).map((r) => r.id)).toContain(ida.id);
  });

  it("a password identity row: 400 password_identity", async () => {
    const pw = await link(t.a, t.a.user.id, "password");
    await signIn(t.a);
    const res = await remove(pw.id);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "password_identity" });
  });

  it("a successful unlink bumps sv: the old token is rejected, this browser stays in", async () => {
    await db.setUserPasswordUnscoped(t.a.user.id, { passwordHash: "x".repeat(60) });
    const ida = await link(t.a, "sub-a");
    const old = await signIn(t.a);
    const res = await remove(ida.id);
    expect(res.status).toBe(200);
    expect(await s.isLiveSession(old)).toBe(false);
    const fresh = jar.cookies.get("auth_token");
    expect(fresh).not.toBe(old);
    expect(await s.isLiveSession(fresh)).toBe(true);
  });
});
