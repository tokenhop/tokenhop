// YAN-751 critical test 5: with the multi-user switch off every device-session
// path falls through to today's behaviour — no `sid`, no `sessions` writes or
// reads, byte-identical claim set, and both routes answer 404.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const savedInitial = process.env.INITIAL_PASSWORD;
const PEER = "peer-token-yan-751";
const PASSWORD = "switch-off-pw-751";
process.env.TOKENHOP_PEER_TOKEN = PEER;
process.env.INITIAL_PASSWORD = PASSWORD;
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

const jar = vi.hoisted(() => ({ cookies: new Map(), headers: new Headers() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n) => (jar.cookies.has(n) ? { name: n, value: jar.cookies.get(n) } : undefined),
    set: (n, v) => jar.cookies.set(n, v),
    delete: (n) => jar.cookies.delete(n),
  }),
  headers: async () => jar.headers,
}));

let s; // @/lib/users/session
let jwt; // @/lib/auth/dashboardSession
let adapter;
let loginPOST;
let logoutPOST;
let workspacePOST;
let sessionsGET;
let sessionDELETE;

async function load() {
  vi.resetModules();
  process.env[ENV] = "off";
  s = await import("@/lib/users/session");
  jwt = await import("@/lib/auth/dashboardSession");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  loginPOST = (await import("@/app/api/auth/login/route.js")).POST;
  logoutPOST = (await import("@/app/api/auth/logout/route.js")).POST;
  workspacePOST = (await import("@/app/api/me/workspace/route.js")).POST;
  sessionsGET = (await import("@/app/api/me/sessions/route.js")).GET;
  sessionDELETE = (await import("@/app/api/me/sessions/[id]/route.js")).DELETE;
}

const sessionCount = () => adapter.get(`SELECT COUNT(*) AS n FROM sessions`).n;
const login = () =>
  loginPOST(
    new NextRequest("http://localhost/api/auth/login", {
      method: "POST",
      headers: new Headers({
        "content-type": "application/json",
        "x-9r-peer-token": PEER,
        "x-9r-real-ip": "10.75.1.1",
        host: "localhost",
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
      }),
      body: JSON.stringify({ password: PASSWORD }),
    }),
  );

afterAll(() => {
  for (const [k, v] of [
    [ENV, savedEnv],
    ["INITIAL_PASSWORD", savedInitial],
  ]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("switch off: device sessions are inert", () => {
  beforeEach(async () => {
    jar.cookies.clear();
    jar.headers = new Headers();
    await load();
  });

  it("login mints today's token: no sid, same claim keys, no sessions row", async () => {
    const res = await login();
    expect(res.status).toBe(200);
    const payload = await jwt.getDashboardAuthSession(jar.cookies.get("auth_token"));
    expect(payload).toBeTruthy();
    expect(Object.hasOwn(payload, "sid")).toBe(false);
    // Pre-users claim set: just the authenticated marker plus the JWT times.
    expect(Object.keys(payload).sort()).toEqual(["authenticated", "exp", "iat"]);
    expect(payload.exp - payload.iat).toBe(24 * 3600);
    expect(sessionCount()).toBe(0);
  });

  it("login, workspace switch and logout never write to sessions", async () => {
    expect((await login()).status).toBe(200);
    expect(sessionCount()).toBe(0);

    // The workspace route is hidden while off (and must not mint or adopt).
    const before = jar.cookies.get("auth_token");
    const switched = await workspacePOST(
      new NextRequest("http://localhost/api/me/workspace", {
        method: "POST",
        headers: new Headers({ "content-type": "application/json" }),
        body: JSON.stringify({ workspaceId: "w" }),
      }),
    );
    expect(switched.status).toBe(404);
    expect(jar.cookies.get("auth_token")).toBe(before);
    expect(sessionCount()).toBe(0);

    const out = await logoutPOST();
    expect(out.status).toBe(200);
    await expect(out.json()).resolves.toEqual({ success: true });
    expect(jar.cookies.has("auth_token")).toBe(false);
    expect(sessionCount()).toBe(0);
  });

  it("GET and DELETE /api/me/sessions answer 404", async () => {
    expect((await sessionsGET()).status).toBe(404);
    const res = await sessionDELETE(
      new Request("http://localhost/api/me/sessions/x", { method: "DELETE" }),
      { params: Promise.resolve({ id: "x" }) },
    );
    expect(res.status).toBe(404);
    for (const file of [
      "src/app/api/me/sessions/route.js",
      "src/app/api/me/sessions/[id]/route.js",
    ]) {
      expect(readFileSync(path.join(REPO_ROOT, file), "utf8")).toContain("requireMultiUser");
    }
  });

  it("validation is signature-only and never queries sessions, even for a sid token", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const plain = await jwt.createDashboardAuthToken({}, exp);
    // D12: the sid claim is not checked while off, so a never-created sid is fine.
    const withSid = await jwt.createDashboardAuthToken({ sid: crypto.randomUUID() }, exp);

    const seen = [];
    const spy = (name) => {
      const orig = adapter[name].bind(adapter);
      return vi.spyOn(adapter, name).mockImplementation((sql, ...rest) => {
        seen.push(String(sql));
        return orig(sql, ...rest);
      });
    };
    const spies = ["get", "all", "run"].map(spy);
    try {
      expect(await s.isLiveSession(plain)).toBe(true);
      expect(await s.isLiveSession(withSid)).toBe(true);
      expect(await s.isLiveSession("not-a-token")).toBe(false);
    } finally {
      for (const sp of spies) sp.mockRestore();
    }
    expect(seen.filter((q) => /\bsessions\b/i.test(q))).toEqual([]);
    expect(sessionCount()).toBe(0);
  });
});
