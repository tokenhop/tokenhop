// YAN-363 durable-security latch: once the hashed marker is written, security
// semantics are fully enforced even with TOKENHOP_MULTI_USER=off — an active
// owner session stays live, disabled/revoked/foreign is denied, the key
// context route is available, and the CLI peer policy stays enforced; a
// malformed marker fails closed instead of falling back to legacy.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const KID = "0123456789abcdef";
const PEER = "peer-token-yan-363";

process.env.TOKENHOP_PEER_TOKEN = PEER;

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

let s; // @/lib/users/session
let db; // @/lib/db/index.js
let jwt; // @/lib/auth/dashboardSession
let t; // seedTenancy()

async function load(state) {
  vi.resetModules();
  process.env[ENV] = state;
  s = await import("@/lib/users/session");
  db = await import("@/lib/db/index.js");
  jwt = await import("@/lib/auth/dashboardSession");
}

async function adapter() {
  return (await import("@/lib/db/driver.js")).getAdapter();
}

// One isolated DB per file; every phase reseeds tenancy and resets the marker.
// A hashed marker implies the hashed apiKeys schema (activation writes both in
// one transaction), so marker fixtures install the hashed table too.
async function reseed({ marker = false } = {}) {
  t = await seedTenancy();
  const dba = await adapter();
  dba.run(`DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')`);
  dba.exec("DROP TABLE apiKeys");
  if (marker) {
    dba.exec(`CREATE TABLE apiKeys (
      id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      userId TEXT REFERENCES users(id) ON DELETE CASCADE,
      createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
      keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
      machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
      revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
      expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
    dba.run(
      `INSERT INTO _meta(key,value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)`,
      [KID],
    );
  } else {
    dba.exec(`CREATE TABLE apiKeys (
      id TEXT PRIMARY KEY, key TEXT UNIQUE, name TEXT, machineId TEXT,
      isActive INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL)`);
  }
  await db.updateSettings({ requireLogin: true });
}

const req = (headers = {}) =>
  new NextRequest("http://localhost/api/x", { headers: new Headers(headers) });

const cookieReq = (token) => req(token ? { cookie: `auth_token=${token}` } : {});

const tokenFor = (u, extra = {}) =>
  jwt.createDashboardAuthToken({
    sub: u.user.id,
    sv: u.user.sessionVersion,
    wid: u.personal,
    amr: ["pwd"],
    ...extra,
  });

const contextReq = (token, { foreignWorkspace = false, bearer = false } = {}) =>
  new NextRequest(
    `http://localhost/api/keys/context${foreignWorkspace ? `?workspaceId=${t.b.personal}` : ""}`,
    {
      headers: new Headers({
        ...(bearer ? { authorization: "Bearer junk" } : {}),
        cookie: `auth_token=${token}`,
      }),
    },
  );

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("YAN-363 durable-established session security", () => {
  beforeEach(async () => {
    jar.cookies.clear();
    await load("off");
  });

  it("pristine off stays today's legacy behaviour: signature-only, CLI from anywhere", async () => {
    await reseed();
    const stale = await tokenFor(t.a);
    await db.bumpSessionVersion(t.a.user.id); // no revocation while pristine
    expect(await s.hasValidSession(cookieReq(stale))).toBe(true);
    expect(await s.resolvePrincipal(cookieReq(stale))).toBeNull();
    expect(await s.sessionClaims("pwd")).toEqual({});
    const { getCliToken, CLI_TOKEN_HEADER } = await import("@/lib/auth/cliToken");
    const cli = await getCliToken();
    expect(await s.cliTokenAccepted(req({ [CLI_TOKEN_HEADER]: cli }))).toBe(true);
  });

  it("hashed marker retained with the switch back off keeps an active session live", async () => {
    await reseed();
    await load("on"); // rollout on: establishes hashed storage below
    const a = await adapter();
    a.run(
      `INSERT INTO _meta(key,value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)`,
      [KID],
    );
    await load("off"); // same DB, same users, marker retained

    const live = await tokenFor(t.a);
    expect(await s.hasValidSession(cookieReq(live))).toBe(true);
    expect(await s.resolvePrincipal(cookieReq(live))).toMatchObject({
      userId: t.a.user.id,
      instanceRole: "owner",
      via: "session",
    });
    // Logins still mint revocable sub/sv/wid claims while latched off.
    expect(await s.sessionClaims("pwd")).toMatchObject({ sub: t.a.user.id });

    // Revocation applies: a bumped sv kills the session even with rollout off.
    const stale = await tokenFor(t.b);
    await db.bumpSessionVersion(t.b.user.id);
    expect(await s.hasValidSession(cookieReq(stale))).toBe(false);
    expect(await s.resolvePrincipal(cookieReq(stale))).toBeNull();
  });

  it("hashed/off denies a disabled user's session", async () => {
    await reseed({ marker: true });
    const token = await tokenFor(t.b);
    expect(await s.resolvePrincipal(cookieReq(token))).toMatchObject({ userId: t.b.user.id });
    await db.updateUserUnscoped(t.b.user.id, { status: "disabled" });
    expect(await s.resolvePrincipal(cookieReq(token))).toBeNull();
    expect(await s.hasValidSession(cookieReq(token))).toBe(false);
  });

  it("hashed/off: context route works, foreign workspace denied, bearer rejected", async () => {
    await reseed({ marker: true });
    const { GET } = await import("@/app/api/keys/context/route.js");
    const token = await tokenFor(t.a);
    const ok = await GET(contextReq(token));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body).toMatchObject({ storage: "hashed", workspaceId: t.a.personal, canManage: true });
    // A workspace the owner is not a member of stays indistinguishable from a
    // missing one: no existence leak.
    expect((await GET(contextReq(token, { foreignWorkspace: true }))).status).toBe(404);
    // A presented gateway bearer never elevates or falls back for context.
    expect((await GET(contextReq(token, { bearer: true }))).status).toBe(403);
  });

  it("hashed/off keeps the CLI token direct-peer policy (ADR-0003)", async () => {
    await reseed({ marker: true });
    const { getCliToken, CLI_TOKEN_HEADER } = await import("@/lib/auth/cliToken");
    const cli = { [CLI_TOKEN_HEADER]: await getCliToken() };
    // Two active users: only a proven loopback peer, never a proxy hop.
    expect(await s.cliTokenAccepted(req(cli))).toBe(false);
    const loopback = {
      ...cli,
      "x-9r-peer-token": PEER,
      "x-9r-real-ip": "127.0.0.1",
    };
    expect(await s.cliTokenAccepted(req(loopback))).toBe(true);
    expect(await s.resolvePrincipal(req(loopback))).toMatchObject({
      userId: t.a.user.id,
      via: "cli",
    });
    expect(await s.cliTokenAccepted(req({ ...loopback, "x-9r-via-proxy": "1" }))).toBe(false);
  });

  it("a malformed durable marker fails closed, never legacy", async () => {
    await reseed({ marker: true });
    (await adapter()).run(`UPDATE _meta SET value = '2' WHERE key = 'apiKeysHashedVersion'`);
    const token = await tokenFor(t.a);
    expect(await s.hasValidSession(cookieReq(token))).toBe(false);
    // Never null-principal on an invalid durable state: the error propagates
    // so management callers (context/keys routes) map it to 503, and a
    // logged-out response would silently mask the storage corruption.
    await expect(s.resolvePrincipal(cookieReq(token))).rejects.toMatchObject({
      code: "API_KEY_STATE_INVALID",
    });
    expect(await s.principalCan(cookieReq(token), "instance.users.manage")).toBe(false);
    await expect(s.sessionClaims("pwd")).rejects.toMatchObject({
      code: "API_KEY_STATE_INVALID",
    });
    const { getCliToken, CLI_TOKEN_HEADER } = await import("@/lib/auth/cliToken");
    await expect(
      s.cliTokenAccepted(req({ [CLI_TOKEN_HEADER]: await getCliToken() })),
    ).rejects.toMatchObject({ code: "API_KEY_STATE_INVALID" });
    const { GET } = await import("@/app/api/keys/context/route.js");
    expect((await GET(contextReq(token))).status).toBe(503);
  });
});
