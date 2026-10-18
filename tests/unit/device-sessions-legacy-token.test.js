// YAN-751 critical test 4 (D1): a sid-less token minted before device sessions
// stays valid until `sv` changes or `exp`, is never listed, is adopted at the
// next re-mint with its original `exp`, and a forged/non-string `sid` claim is
// rejected at validation.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];

let s; // @/lib/users/session
let db; // @/lib/db/index.js
let jwt; // @/lib/auth/dashboardSession
let sessionsGET; // GET /api/me/sessions
let workspacePOST; // POST /api/me/workspace
let adapter;
let t;

const jar = vi.hoisted(() => ({ cookies: new Map(), headers: new Headers() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n) => (jar.cookies.has(n) ? { name: n, value: jar.cookies.get(n) } : undefined),
    set: (n, v) => jar.cookies.set(n, v),
    delete: (n) => jar.cookies.delete(n),
  }),
  headers: async () => jar.headers,
}));

async function load() {
  vi.resetModules();
  process.env[ENV] = "on";
  s = await import("@/lib/users/session");
  db = await import("@/lib/db/index.js");
  jwt = await import("@/lib/auth/dashboardSession");
  sessionsGET = (await import("@/app/api/me/sessions/route.js")).GET;
  workspacePOST = (await import("@/app/api/me/workspace/route.js")).POST;
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
}

/** A harness-style sid-less session cookie: what a pre-YAN-751 login minted. */
async function signIn(seeded, exp = Math.floor(Date.now() / 1000) + 3600, extra = {}) {
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

const switchWorkspace = (workspaceId) =>
  workspacePOST(
    new NextRequest("http://localhost/api/me/workspace", {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify({ workspaceId }),
    }),
  );

const rowsFor = (userId) => adapter.all(`SELECT * FROM sessions WHERE userId = ?`, [userId]);

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("legacy sid-less token (D1)", () => {
  beforeEach(async () => {
    jar.cookies.clear();
    jar.headers = new Headers();
    await load();
    await db.updateSettings({ requireLogin: true });
    t = await seedTenancy();
    globalThis.__tokenhopDeviceSessionCache?.clear();
    globalThis.__tokenhopSessionCache?.clear();
  });

  it("is accepted, never listed, and reports no current session", async () => {
    const token = await signIn(t.b);
    expect(await s.isLiveSession(token)).toBe(true);

    const res = await sessionsGET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ sessions: [], currentSessionId: null });
    // Listing is a pure read: no adoption, no Set-Cookie, no row.
    expect(rowsFor(t.b.user.id)).toEqual([]);
    expect(jar.cookies.get("auth_token")).toBe(token);
  });

  it("dies on a session-version bump (sign out everywhere)", async () => {
    const token = await signIn(t.b);
    expect(await s.isLiveSession(token)).toBe(true);
    await db.bumpSessionVersion(t.b.user.id);
    expect(await s.isLiveSession(token)).toBe(false);
  });

  it("is adopted by a workspace switch: same exp, row from iat/exp, new token has a sid", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const old = await signIn(t.b, exp);
    const oldClaims = await jwt.getDashboardAuthSession(old);
    expect(oldClaims.sid).toBeUndefined();

    const res = await switchWorkspace(t.shared.id);
    expect(res.status).toBe(200);

    const fresh = await jwt.getDashboardAuthSession(jar.cookies.get("auth_token"));
    expect(fresh.sid).toEqual(expect.any(String));
    expect(fresh.exp).toBe(exp);
    expect(fresh.wid).toBe(t.shared.id);

    const rows = rowsFor(t.b.user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: fresh.sid,
      sv: t.b.user.sessionVersion,
      revokedAt: null,
      createdAt: new Date(oldClaims.iat * 1000).toISOString(),
      expiresAt: new Date(exp * 1000).toISOString(),
    });

    // From now on the session is a real device row: listed and current.
    const list = await (await sessionsGET()).json();
    expect(list.currentSessionId).toBe(fresh.sid);
    expect(list.sessions.map((x) => [x.id, x.current])).toEqual([[fresh.sid, true]]);
  });

  it("an adopted session can be revoked: the sid token stops validating", async () => {
    await signIn(t.b);
    expect((await switchWorkspace(t.shared.id)).status).toBe(200);
    const token = jar.cookies.get("auth_token");
    const { sid } = await jwt.getDashboardAuthSession(token);
    expect(await s.isLiveSession(token)).toBe(true);

    await db.revokeSession(t.b.ctx, sid);
    expect(await s.isLiveSession(token)).toBe(false);
  });
});

describe("forged sid claims fail closed", () => {
  beforeEach(async () => {
    jar.cookies.clear();
    jar.headers = new Headers();
    await load();
    await db.updateSettings({ requireLogin: true });
    t = await seedTenancy();
    globalThis.__tokenhopDeviceSessionCache?.clear();
    globalThis.__tokenhopSessionCache?.clear();
  });

  async function sidOf(seeded) {
    const id = crypto.randomUUID();
    const now = Date.now();
    await db.createSessionUnscoped({
      id,
      userId: seeded.user.id,
      sv: seeded.user.sessionVersion,
      amr: "pwd",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 3600_000).toISOString(),
    });
    return id;
  }

  it("accepts a user's own sid, rejects another user's real sid", async () => {
    const sidA = await sidOf(t.a);
    expect(await s.isLiveSession(await signIn(t.a, undefined, { sid: sidA }))).toBe(true);
    expect(await s.isLiveSession(await signIn(t.b, undefined, { sid: sidA }))).toBe(false);
  });

  it.each([
    ["unknown uuid", () => crypto.randomUUID()],
    ["empty string", () => ""],
    ["number", () => 123],
    ["object", () => ({})],
    ["array", () => ["x"]],
    ["null", () => null],
  ])("rejects a token whose sid is %s", async (_label, make) => {
    const token = await signIn(t.b, undefined, { sid: make() });
    expect(await s.isLiveSession(token)).toBe(false);
  });

  it("a forged sid never reaches the routes either: no principal, 401", async () => {
    await signIn(t.b, undefined, { sid: crypto.randomUUID() });
    expect((await sessionsGET()).status).toBe(401);
  });
});
