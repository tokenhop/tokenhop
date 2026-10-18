// YAN-751 critical test 3: every re-mint path keeps the session's `sid` and
// original `exp` (D3), rebinds the row to the new sessionVersion, and never
// resurrects a revoked row. The restricted forced-change flow is the one path
// that mints a fresh row with a fresh 24 h expiry (D7).
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const PEER = "peer-token-yan-751-remint";
process.env.TOKENHOP_PEER_TOKEN = PEER;
const PW_A = "owner-secret-15+";
const PW_B = "temp-secret-15+";
const PW_NEW = "fresh-secret-15+";

let s; // @/lib/users/session
let db; // @/lib/db/index.js
let jwt; // @/lib/auth/dashboardSession
let mint; // @/lib/users/sessionMint.js
let adapter;
let loginPOST;
let changePOST;
let workspacePOST;
let identityDELETE;
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
  mint = await import("@/lib/users/sessionMint.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  loginPOST = (await import("@/app/api/auth/login/route.js")).POST;
  changePOST = (await import("@/app/api/auth/change-password/route.js")).POST;
  workspacePOST = (await import("@/app/api/me/workspace/route.js")).POST;
  identityDELETE = (await import("@/app/api/me/identities/[id]/route.js")).DELETE;
}

const post = (url, body, headers = {}) =>
  new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: new Headers({ "content-type": "application/json", ...headers }),
    body: JSON.stringify(body),
  });
const peer = { "x-9r-peer-token": PEER, "x-9r-real-ip": "10.8.0.1", host: "localhost" };

const row = (sid) => adapter.get(`SELECT * FROM sessions WHERE id = ?`, [sid]);
const rowCount = (userId) =>
  adapter.get(`SELECT COUNT(*) AS n FROM sessions WHERE userId = ?`, [userId]).n;
const authToken = () => jar.cookies.get("auth_token");
const nowSec = () => Math.floor(Date.now() / 1000);

/** A live session cookie backed by a real row, expiring `ttlSec` from now (default 1 h). */
async function signIn(seeded, ttlSec = 3600) {
  const user = await db.getUserUnscoped(seeded.user.id);
  const exp = nowSec() + ttlSec;
  const sid = randomUUID();
  await db.createSessionUnscoped({
    id: sid,
    userId: user.id,
    sv: user.sessionVersion,
    amr: "pwd",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(exp * 1000).toISOString(),
  });
  const token = await jwt.createDashboardAuthToken(
    { sub: user.id, sv: user.sessionVersion, wid: seeded.personal, amr: ["pwd"], sid },
    exp,
  );
  jar.cookies.set("auth_token", token);
  return { token, sid, exp };
}

/**
 * Run a re-mint and assert the session survived intact: same sid, exp never
 * grown, row rebound to the current sv, no new row, still live and listed.
 */
async function expectRemint(seeded, session, run) {
  const rowsBefore = rowCount(seeded.user.id);
  await run();
  const user = await db.getUserUnscoped(seeded.user.id);
  const next = authToken();
  expect(next).not.toBe(session.token);
  const claims = await jwt.getDashboardAuthSession(next);
  expect(claims.sid).toBe(session.sid);
  expect(claims.exp).toBe(session.exp); // the old exp, never a fresh 24 h
  expect(claims.sv).toBe(user.sessionVersion);
  const stored = row(session.sid);
  expect(stored).toMatchObject({ sv: user.sessionVersion, revokedAt: null });
  expect(stored.expiresAt).toBe(new Date(session.exp * 1000).toISOString());
  expect(rowCount(user.id)).toBe(rowsBefore);
  expect(await s.isLiveSession(next)).toBe(true);
  expect((await db.listSessions(seeded.ctx)).map((r) => r.id)).toEqual([session.sid]);
  return user;
}

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("YAN-751 re-mint keeps sid and exp", () => {
  beforeEach(async () => {
    jar.cookies.clear();
    jar.headers = new Headers();
    await load();
    await db.updateSettings({ requireLogin: true, authMode: "both", ssoType: "oidc" });
    t = await seedTenancy();
    await db.updateUserUnscoped(t.a.user.id, { passwordHash: await bcrypt.hash(PW_A, 4) });
    await db.updateUserUnscoped(t.b.user.id, { passwordHash: await bcrypt.hash(PW_B, 4) });
    globalThis.__tokenhopDeviceSessionCache?.clear();
    globalThis.__tokenhopSessionCache?.clear();
  });

  it("baseline: the real login route mints a sid with a ~24 h exp and a listed row", async () => {
    const res = await loginPOST(
      post("/api/auth/login", { login: "a@tenancy.test", password: PW_A }, peer),
    );
    expect(res.status).toBe(200);
    const claims = await jwt.getDashboardAuthSession(authToken());
    expect(typeof claims.sid).toBe("string");
    expect(Math.abs(claims.exp - (nowSec() + jwt.SESSION_MAX_AGE_SEC))).toBeLessThan(10);
    expect((await db.listSessions(t.a.ctx)).map((r) => r.id)).toEqual([claims.sid]);
  });

  it("fresh login with the same user's cookie supersedes the old row (R7)", async () => {
    const old = await signIn(t.a);
    expect(await s.isLiveSession(old.token)).toBe(true);
    const res = await loginPOST(
      post("/api/auth/login", { login: "a@tenancy.test", password: PW_A }, peer),
    );
    expect(res.status).toBe(200);
    const claims = await jwt.getDashboardAuthSession(authToken());
    expect(claims.sid).not.toBe(old.sid);
    expect(row(old.sid)).toBeUndefined();
    expect(rowCount(t.a.user.id)).toBe(1);
    expect(row(claims.sid)).toMatchObject({ userId: t.a.user.id, revokedAt: null });
    expect(await s.isLiveSession(old.token)).toBe(false);
    expect((await db.listSessions(t.a.ctx)).map((r) => r.id)).toEqual([claims.sid]);
  });

  it("workspace switch: same sid, same exp, wid changed", async () => {
    const session = await signIn(t.a);
    await expectRemint(t.a, session, async () => {
      const res = await workspacePOST(post("/api/me/workspace", { workspaceId: t.shared.id }));
      expect(res.status).toBe(200);
    });
    expect((await jwt.getDashboardAuthSession(authToken())).wid).toBe(t.shared.id);
  });

  it("workspace switch: a failed preference write re-mints the original wid", async () => {
    const session = await signIn(t.a);
    adapter.run(`ALTER TABLE userPreferences RENAME TO userPreferencesBroken`);
    let res;
    try {
      res = await workspacePOST(post("/api/me/workspace", { workspaceId: t.shared.id }));
    } finally {
      adapter.run(`ALTER TABLE userPreferencesBroken RENAME TO userPreferences`);
    }
    expect(res.status).toBe(500);
    const claims = await jwt.getDashboardAuthSession(authToken());
    expect(claims.wid).toBe(t.a.personal);
    expect(claims.sid).toBe(session.sid);
    expect(claims.exp).toBe(session.exp);
    expect(await s.isLiveSession(authToken())).toBe(true);
  });

  it("identity unlink: same sid, same exp, row rebound to the bumped sv", async () => {
    const ida = await db.linkIdentityUnscoped(t.a.user.id, {
      provider: "oidc",
      issuer: "https://idp",
      subject: "sub-a",
    });
    const session = await signIn(t.a);
    await expectRemint(t.a, session, async () => {
      const res = await identityDELETE(
        new NextRequest(`http://localhost/api/me/identities/${ida.id}`, { method: "DELETE" }),
        { params: Promise.resolve({ id: ida.id }) },
      );
      expect(res.status).toBe(200);
    });
  });

  it("change-password with a full session: same sid, same exp (D3)", async () => {
    const session = await signIn(t.a);
    const before = (await db.getUserUnscoped(t.a.user.id)).sessionVersion;
    const user = await expectRemint(t.a, session, async () => {
      const res = await changePOST(
        post("/api/auth/change-password", { currentPassword: PW_A, newPassword: PW_NEW }),
      );
      expect(res.status).toBe(200);
    });
    expect(user.sessionVersion).toBeGreaterThan(before);
  });

  it("owner reset (revokeOwnerSessions): same sid, same exp, other devices die", async () => {
    const other = await signIn(t.a);
    const session = await signIn(t.a, 7200);
    const before = (await db.getUserUnscoped(t.a.user.id)).sessionVersion;
    const user = await expectRemint(t.a, session, () =>
      s.revokeOwnerSessions(post("/api/settings", {})),
    );
    expect(user.sessionVersion).toBeGreaterThan(before);
    expect(await s.isLiveSession(other.token)).toBe(false);
  });

  it("revoked sid: re-mint fails, cookie cleared, workspace 401, row not resurrected", async () => {
    const session = await signIn(t.a);
    // Populate the sid cache so the post-revoke checks prove the cache drop.
    expect(await s.isLiveSession(session.token)).toBe(true);
    expect(await db.revokeSessionUnscoped(session.sid, t.a.user.id)).toBe(true);
    expect(await s.isLiveSession(session.token)).toBe(false);
    const revokedAt = row(session.sid).revokedAt;
    expect(revokedAt).toBeTruthy();

    expect(
      (await workspacePOST(post("/api/me/workspace", { workspaceId: t.shared.id }))).status,
    ).toBe(401);

    const from = await jwt.getDashboardAuthSession(session.token);
    const user = await db.getUserUnscoped(t.a.user.id);
    const claims = { sub: user.id, sv: user.sessionVersion, wid: t.a.personal, amr: ["pwd"] };
    const cookieStore = await (await import("next/headers")).cookies();
    expect(await mint.mintSessionCookie(cookieStore, post("/x", {}), claims, { from })).toBe(false);
    expect(authToken()).toBeUndefined();

    expect(row(session.sid).revokedAt).toBe(revokedAt);
    expect(rowCount(user.id)).toBe(1);
    expect(await db.listSessions(t.a.ctx)).toEqual([]);
  });

  it("mintSessionCookie: from={sid} without a valid exp fails and clears the cookie", async () => {
    const session = await signIn(t.a);
    const user = await db.getUserUnscoped(t.a.user.id);
    const claims = { sub: user.id, sv: user.sessionVersion, wid: t.a.personal, amr: ["pwd"] };
    const cookieStore = await (await import("next/headers")).cookies();
    expect(authToken()).toBe(session.token);
    expect(
      await mint.mintSessionCookie(cookieStore, post("/x", {}), claims, {
        from: { sid: session.sid },
      }),
    ).toBe(false);
    expect(authToken()).toBeUndefined();
    expect(row(session.sid)).toMatchObject({ revokedAt: null });
    expect(rowCount(user.id)).toBe(1);
  });

  it("mintSessionCookie: from={sid, exp in the past} fails", async () => {
    const session = await signIn(t.a);
    const user = await db.getUserUnscoped(t.a.user.id);
    const claims = { sub: user.id, sv: user.sessionVersion, wid: t.a.personal, amr: ["pwd"] };
    const cookieStore = await (await import("next/headers")).cookies();
    const from = { sid: session.sid, sub: user.id, exp: nowSec() - 10 };
    expect(await mint.mintSessionCookie(cookieStore, post("/x", {}), claims, { from })).toBe(false);
    expect(authToken()).toBeUndefined();
  });

  it("workspace switch: a failed pref write after a concurrent sv bump leaves no live cookie", async () => {
    const session = await signIn(t.a);
    const realTx = adapter.transaction.bind(adapter);
    let bumped = false;
    const spy = vi.spyOn(adapter, "transaction").mockImplementation((fn) => {
      // Concurrent sign-out-everywhere lands (outside the tx), then the write fails.
      if (!bumped) {
        bumped = true;
        adapter.run(`UPDATE users SET sessionVersion = sessionVersion + 1 WHERE id = ?`, [
          t.a.user.id,
        ]);
        throw new Error("pref write failed");
      }
      return realTx(fn);
    });
    let res;
    try {
      res = await workspacePOST(post("/api/me/workspace", { workspaceId: t.shared.id }));
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(500);
    const token = authToken();
    expect(token === undefined || (await s.isLiveSession(token)) === false).toBe(true);
    expect(token).not.toBe(session.token);
  });

  it("workspace switch: a sv bump after the principal check fails closed (YAN-1218)", async () => {
    const session = await signIn(t.a);
    const { sv } = await jwt.getDashboardAuthSession(session.token);
    const req = post("/api/me/workspace", { workspaceId: t.shared.id });
    // The body is read after the principal check and before the re-mint:
    // land a concurrent sign-out-everywhere right there.
    req.json = async () => {
      await db.bumpSessionVersion(t.a.user.id);
      return { workspaceId: t.shared.id };
    };
    const res = await workspacePOST(req);
    expect(res.status).toBe(401);
    expect(authToken()).toBeUndefined();
    expect(await s.isLiveSession(session.token)).toBe(false);
    expect(row(session.sid).sv).toBe(sv); // never rebound to the bumped sv
  });

  it("mintSessionCookie: a sub-less re-mint of a user-bound session fails and clears", async () => {
    const session = await signIn(t.a);
    const from = await jwt.getDashboardAuthSession(session.token);
    const cookieStore = await (await import("next/headers")).cookies();
    expect(
      await mint.mintSessionCookie(cookieStore, post("/x", {}), { authenticated: true }, { from }),
    ).toBe(false);
    expect(authToken()).toBeUndefined();
    expect(rowCount(t.a.user.id)).toBe(1);
  });

  it("restricted forced-change flow mints a fresh row with a fresh ~24 h exp (D7)", async () => {
    await db.setUserPasswordUnscoped(t.b.user.id, {
      passwordHash: await bcrypt.hash(PW_B, 4),
      mustChangePassword: true,
    });
    expect(rowCount(t.b.user.id)).toBe(0);
    const login = await loginPOST(
      post("/api/auth/login", { login: "b@tenancy.test", password: PW_B }, peer),
    );
    expect(login.status).toBe(403);
    expect(authToken()).toBeUndefined();
    expect(jar.cookies.get("password_change_token")).toBeTruthy();
    expect(rowCount(t.b.user.id)).toBe(0); // the challenge itself is not a session

    const res = await changePOST(
      post("/api/auth/change-password", { currentPassword: PW_B, newPassword: PW_NEW }),
    );
    expect(res.status).toBe(200);
    const claims = await jwt.getDashboardAuthSession(authToken());
    expect(typeof claims.sid).toBe("string");
    expect(Math.abs(claims.exp - (nowSec() + jwt.SESSION_MAX_AGE_SEC))).toBeLessThan(10);
    const user = await db.getUserUnscoped(t.b.user.id);
    expect(row(claims.sid)).toMatchObject({
      userId: user.id,
      sv: user.sessionVersion,
      revokedAt: null,
    });
    expect(rowCount(user.id)).toBe(1);
    expect((await db.listSessions(t.b.ctx)).map((r) => r.id)).toEqual([claims.sid]);
  });
});
