// YAN-751: GET /api/me/sessions and DELETE /api/me/sessions/:id (+ logout).
// Pins: per-device revoke, cross-user uniform 404, CSRF, principal gating,
// switch-off 404, DTO whitelist / privacy, audit of revokes.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const PEER_ENV = "TOKENHOP_PEER_TOKEN";
const savedEnv = process.env[ENV];
const savedPeer = process.env[PEER_ENV];
const PEER = "peer-token-yan-751";
process.env[PEER_ENV] = PEER;

let s;
let db;
let jwt;
let mintSessionCookie;
let adapter;
let t;
let list;
let del;
let logout;

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
  ({ mintSessionCookie } = await import("@/lib/users/sessionMint.js"));
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  list = await import("@/app/api/me/sessions/route.js");
  del = await import("@/app/api/me/sessions/[id]/route.js");
  logout = await import("@/app/api/auth/logout/route.js");
  // The cache lives on globalThis and survives resetModules.
  globalThis.__tokenhopDeviceSessionCache?.clear();
}

/** A fresh browser logs in as `seeded`; leaves its cookie in the jar. */
async function mint(seeded, headers = {}) {
  jar.cookies.delete("auth_token");
  const { cookies } = await import("next/headers");
  const claims = await s.passwordSessionClaims(seeded.user.id);
  const request = new NextRequest("http://localhost/api/auth/login", { method: "POST", headers });
  await mintSessionCookie(await cookies(), request, claims);
  const token = jar.cookies.get("auth_token");
  return { token, sid: (await jwt.getDashboardAuthSession(token)).sid };
}

const remove = (id, headers = {}) =>
  del.DELETE(
    new NextRequest(`http://localhost/api/me/sessions/${id}`, {
      method: "DELETE",
      headers: new Headers(headers),
    }),
    { params: Promise.resolve({ id }) },
  );

const row = (sid) => adapter.get("SELECT * FROM sessions WHERE id = ?", [sid]);
const revokeAudits = (sid) =>
  adapter.all("SELECT * FROM auditEvents WHERE action = 'session.revoke' AND targetId = ?", [sid]);
const expire = (sid) => {
  adapter.run("UPDATE sessions SET expiresAt = ? WHERE id = ?", [
    new Date(Date.now() - 60_000).toISOString(),
    sid,
  ]);
  globalThis.__tokenhopDeviceSessionCache?.clear();
};

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  if (savedPeer === undefined) delete process.env[PEER_ENV];
  else process.env[PEER_ENV] = savedPeer;
});

describe("switch off: hidden", () => {
  beforeEach(async () => {
    jar.cookies.clear();
    jar.headers = new Headers();
    await load("off");
    t = await seedTenancy();
  });

  it("404s GET and DELETE", async () => {
    jar.cookies.set(
      "auth_token",
      await jwt.createDashboardAuthToken({ sub: t.a.user.id, sv: t.a.user.sessionVersion }),
    );
    expect((await list.GET()).status).toBe(404);
    expect((await remove("x")).status).toBe(404);
  });
});

describe("switch on", () => {
  beforeEach(async () => {
    jar.cookies.clear();
    jar.headers = new Headers();
    await load("on");
    await db.updateSettings({ requireLogin: true, authMode: "both", ssoType: "oidc" });
    t = await seedTenancy();
  });

  describe("lifecycle", () => {
    it("revoking another device: that token dies, this one stays and lists alone", async () => {
      const one = await mint(t.a);
      const two = await mint(t.a);
      jar.cookies.set("auth_token", one.token);
      const before = await (await list.GET()).json();
      expect(before.sessions.map((x) => x.id).sort()).toEqual([one.sid, two.sid].sort());
      expect(before.currentSessionId).toBe(one.sid);

      const res = await remove(two.sid);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ success: true, current: false });
      expect(await s.isLiveSession(two.token)).toBe(false);
      expect(await s.isLiveSession(one.token)).toBe(true);
      expect(jar.cookies.get("auth_token")).toBe(one.token);

      const after = await (await list.GET()).json();
      expect(after.sessions.map((x) => x.id)).toEqual([one.sid]);
      expect(after.sessions[0].current).toBe(true);

      jar.cookies.set("auth_token", two.token);
      expect((await list.GET()).status).toBe(401);
    });

    it("revoking the current device reports current and clears the cookie", async () => {
      const { token, sid } = await mint(t.a);
      const res = await remove(sid);
      await expect(res.json()).resolves.toEqual({ success: true, current: true });
      expect(jar.cookies.has("auth_token")).toBe(false);
      expect(await s.isLiveSession(token)).toBe(false);
    });

    it("plain POST /api/auth/logout revokes the row", async () => {
      const { token, sid } = await mint(t.a);
      expect((await logout.POST()).status).toBe(200);
      expect(jar.cookies.has("auth_token")).toBe(false);
      expect(row(sid).revokedAt).toBeTruthy();
      expect(await s.isLiveSession(token)).toBe(false);
    });
  });

  describe("cross-user (IDOR)", () => {
    it("B gets one identical 404 for foreign, unknown, revoked, expired and malformed ids", async () => {
      const a = await mint(t.a);
      const bRevoked = await mint(t.b);
      const bExpired = await mint(t.b);
      const b = await mint(t.b);
      await db.revokeSessionUnscoped(bRevoked.sid, t.b.user.id);
      expire(bExpired.sid);

      const ids = [
        a.sid,
        "00000000-0000-4000-8000-000000000000",
        bRevoked.sid,
        bExpired.sid,
        "not-a-uuid",
        "' OR 1=1 --",
        "../../a",
      ];
      const bodies = [];
      for (const id of ids) {
        const res = await remove(id);
        expect(res.status, id).toBe(404);
        bodies.push(await res.text());
      }
      expect(new Set(bodies).size).toBe(1);
      expect(JSON.parse(bodies[0])).toEqual({ error: "Session not found" });
      expect(revokeAudits(a.sid)).toHaveLength(0);
      expect(await s.isLiveSession(a.token)).toBe(true);
      expect(row(a.sid).revokedAt).toBeNull();
      expect(await s.isLiveSession(b.token)).toBe(true);
    });

    it("B's list never contains A's rows", async () => {
      const a = await mint(t.a);
      await mint(t.b);
      const body = await (await list.GET()).text();
      expect(body).not.toContain(a.sid);
      expect(body).not.toContain(t.a.user.id);
      expect(JSON.parse(body).sessions).toHaveLength(1);
    });
  });

  describe("CSRF and principals", () => {
    it("403 forbidden_origin for a cross-site Origin; row kept", async () => {
      const { sid } = await mint(t.a);
      const res = await remove(sid, { origin: "https://evil.example" });
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ code: "forbidden_origin" });
      expect(row(sid).revokedAt).toBeNull();
    });

    it("cli principal: 401 on both routes", async () => {
      const { getCliToken, CLI_TOKEN_HEADER } = await import("@/lib/auth/cliToken");
      jar.headers = new Headers({
        [CLI_TOKEN_HEADER]: await getCliToken(),
        "x-9r-peer-token": PEER,
        "x-9r-real-ip": "127.0.0.1",
      });
      jar.cookies.clear();
      expect(await s.getPrincipal()).toMatchObject({ via: "cli" });
      expect((await list.GET()).status).toBe(401);
      expect((await remove("x")).status).toBe(401);
    });

    it("local principal (requireLogin off, single user): 401 on both routes", async () => {
      await db.deleteUserUnscoped(t.b.user.id);
      await db.updateSettings({ requireLogin: false });
      jar.cookies.clear();
      expect(await s.getPrincipal()).toMatchObject({ via: "local" });
      expect((await list.GET()).status).toBe(401);
      expect((await remove("x")).status).toBe(401);
    });

    it("sub-less legacy owner token: 401 on both routes", async () => {
      await db.deleteUserUnscoped(t.b.user.id);
      jar.cookies.set("auth_token", await jwt.createDashboardAuthToken());
      expect(await s.getPrincipal()).toMatchObject({ via: "session" });
      expect((await list.GET()).status).toBe(401);
      expect((await remove("x")).status).toBe(401);
    });

    it("no cookie: 401", async () => {
      expect((await list.GET()).status).toBe(401);
      expect((await remove("x")).status).toBe(401);
    });
  });

  describe("privacy", () => {
    it("GET exposes only the whitelisted keys, with a coarse network prefix", async () => {
      const v4 = await mint(t.a, {
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0",
        "x-9r-peer-token": PEER,
        "x-9r-real-ip": "203.0.113.77",
      });
      const v6 = await mint(t.a, {
        "x-9r-peer-token": PEER,
        "x-9r-real-ip": "2001:db8:1234:5678::1",
      });
      const none = await mint(t.a);
      jar.cookies.set("auth_token", none.token);

      const text = await (await list.GET()).text();
      for (const secret of [
        t.a.user.id,
        v4.token,
        v6.token,
        none.token,
        "203.0.113.77",
        "Gecko/20100101",
        "5678::1",
      ]) {
        expect(text).not.toContain(secret);
      }
      const { sessions, currentSessionId } = JSON.parse(text);
      expect(Object.keys(JSON.parse(text)).sort()).toEqual(["currentSessionId", "sessions"]);
      expect(currentSessionId).toBe(none.sid);
      expect(sessions[0].id).toBe(none.sid);

      const base = [
        "createdAt",
        "current",
        "device",
        "expiresAt",
        "id",
        "lastSeenAt",
        "loginMethod",
      ];
      const byId = Object.fromEntries(sessions.map((x) => [x.id, x]));
      for (const x of sessions) {
        const expected = x.network === undefined ? base : [...base, "network"];
        expect(Object.keys(x).sort()).toEqual(expected);
      }
      expect(byId[v4.sid]).toMatchObject({ device: "Firefox on Linux", network: "203.0.113.0/24" });
      expect(byId[v6.sid].network).toBe("2001:db8:1234::/48");
      expect(byId[none.sid].network).toBeUndefined();
      expect(byId[none.sid].loginMethod).toBe("pwd");
    });

    it("hostile User-Agents at login yield enum labels only", async () => {
      const password = "correct-horse-battery";
      await db.setUserPasswordUnscoped(t.a.user.id, {
        passwordHash: await bcrypt.hash(password, 4),
      });
      const { POST: login } = await import("@/app/api/auth/login/route.js");
      const uas = [
        `Mozilla/5.0 (X11; Linux x86_64) Firefox/120.0 ${"A".repeat(10 * 1024)}`,
        "<script>alert(1)</script>",
      ];
      for (const ua of uas) {
        jar.cookies.delete("auth_token");
        const res = await login(
          new NextRequest("http://localhost/api/auth/login", {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": ua },
            body: JSON.stringify({ login: "a@tenancy.test", password }),
          }),
        );
        expect(res.status).toBe(200);
      }
      const rows = adapter.all("SELECT userAgent FROM sessions WHERE userId = ?", [t.a.user.id]);
      const labels = rows.map((r) => r.userAgent).sort();
      expect(labels).toEqual(["Browser on Unknown OS", "Firefox on Linux"]);
      jar.cookies.set("auth_token", jar.cookies.get("auth_token"));
      const text = await (await list.GET()).text();
      expect(text).not.toContain("<script>");
      expect(text).not.toContain("AAAA");
    });
  });

  describe("audit", () => {
    it("a successful revoke writes session.revoke without ip/ua; a 404 writes none", async () => {
      const one = await mint(t.a, { "user-agent": "Firefox/120.0 (X11; Linux)" });
      const two = await mint(t.a, { "user-agent": "Firefox/120.0 (X11; Linux)" });
      jar.cookies.set("auth_token", one.token);

      const total = () =>
        adapter.get("SELECT COUNT(*) AS n FROM auditEvents WHERE action = 'session.revoke'").n;
      const baseline = total();
      expect((await remove("00000000-0000-4000-8000-000000000000")).status).toBe(404);
      expect(total()).toBe(baseline);

      expect((await remove(two.sid)).status).toBe(200);
      const events = revokeAudits(two.sid);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorUserId: t.a.user.id,
        targetType: "session",
        targetId: two.sid,
        result: "success",
        after: null,
      });
      expect(JSON.stringify(events[0])).not.toContain("Firefox");
      expect(total()).toBe(baseline + 1);
    });
  });
});
