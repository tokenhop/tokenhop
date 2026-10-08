// YAN-371: POST /api/me/workspace — switch the active workspace. Uses the
// YAN-354 two-user harness (owner A, user B, shared workspace; B is member).
// Pins the security posture of the re-mint: live membership (404, not 403),
// session-only principal, cross-site Origin refused, exp never extended, and
// the lastWorkspaceId restore (with the membership fallback).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const PEER = "peer-token-yan-371";
process.env.TOKENHOP_PEER_TOKEN = PEER;

let s; // @/lib/users/session
let db; // @/lib/db/index.js
let jwt; // @/lib/auth/dashboardSession
let t;
let route; // @/app/api/me/workspace/route.js

// The route reads cookies()/headers(); back them with a per-test store.
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
  route = await import("@/app/api/me/workspace/route.js");
}

/** A live session cookie for a seeded user; `exp` keeps the original expiry. */
async function signIn(seeded, exp = Math.floor(Date.now() / 1000) + 24 * 3600, extra = {}) {
  const token = await jwt.createDashboardAuthToken(
    {
      sub: seeded.user.id,
      sv: seeded.user.sessionVersion,
      wid: seeded.personal,
      amr: ["pwd"],
      ...extra,
    },
    exp,
  );
  jar.cookies.set("auth_token", token);
  return token;
}

async function post(body, headers = {}) {
  const h = new Headers({ "content-type": "application/json", ...headers });
  return route.POST(
    new NextRequest("http://localhost/api/me/workspace", {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
    }),
  );
}

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

  it("404s even for a valid session and body", async () => {
    await signIn(t.a);
    const res = await post({ workspaceId: t.a.personal });
    expect(res.status).toBe(404);
  });
});

describe("switch on", () => {
  beforeEach(async () => {
    jar.cookies.clear();
    jar.headers = new Headers();
    await load("on");
    await db.updateSettings({ requireLogin: true });
    t = await seedTenancy();
  });

  it("401 for the cli and local principals: session only", async () => {
    const { getCliToken, CLI_TOKEN_HEADER } = await import("@/lib/auth/cliToken");
    jar.headers = new Headers({
      [CLI_TOKEN_HEADER]: await getCliToken(),
      "x-9r-peer-token": PEER,
      "x-9r-real-ip": "127.0.0.1",
    });
    expect((await post({ workspaceId: t.a.personal })).status).toBe(401);
    // No cookie, login required: no principal at all.
    jar.headers = new Headers();
    expect((await post({ workspaceId: t.a.personal })).status).toBe(401);
  });

  it("403 for a cross-site Origin, cookie untouched", async () => {
    const before = await signIn(t.b);
    const res = await post({ workspaceId: t.shared.id }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: "forbidden_origin" });
    expect(jar.cookies.get("auth_token")).toBe(before);
  });

  it("400 invalid_request for a malformed body", async () => {
    await signIn(t.b);
    for (const body of [{}, { workspaceId: 1 }, { workspaceId: "x", extra: 1 }, null]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ code: "invalid_request" });
    }
  });

  it("B switching to A's personal workspace: 404, cookie not re-minted", async () => {
    const before = await signIn(t.b);
    const res = await post({ workspaceId: t.a.personal });
    expect(res.status).toBe(404);
    expect(jar.cookies.get("auth_token")).toBe(before);
    expect((await jwt.getDashboardAuthSession(before)).wid).toBe(t.b.personal);
  });

  it("B switching to the shared workspace: 200, re-minted wid, exp unchanged", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    await signIn(t.b, exp, { oidcName: "B", oidcEmail: "b@tenancy.test" });
    const res = await post({ workspaceId: t.shared.id });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      activeWorkspaceId: t.shared.id,
      workspace: { id: t.shared.id, kind: "shared", role: "member" },
    });

    const after = jar.cookies.get("auth_token");
    const session = await jwt.getDashboardAuthSession(after);
    expect(session).toMatchObject({
      sub: t.b.user.id,
      sv: t.b.user.sessionVersion,
      wid: t.shared.id,
    });
    // Display claims survive the re-mint; expiry never extends (D4).
    expect(session.amr).toEqual(["pwd"]);
    expect(session.oidcName).toBe("B");
    expect(session.exp).toBe(exp);
  });

  it("passwordSessionClaims restores the shared workspace, then falls back to personal", async () => {
    await signIn(t.b);
    expect((await post({ workspaceId: t.shared.id })).status).toBe(200);
    // The switch persisted lastWorkspaceId; the next login restores it (D5).
    expect((await s.passwordSessionClaims(t.b.user.id)).wid).toBe(t.shared.id);

    // A dropped membership beats the stored preference: personal fallback.
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    adapter.run(`DELETE FROM memberships WHERE workspaceId = ? AND userId = ?`, [
      t.shared.id,
      t.b.user.id,
    ]);
    expect((await s.passwordSessionClaims(t.b.user.id)).wid).toBe(t.b.personal);
  });
});
