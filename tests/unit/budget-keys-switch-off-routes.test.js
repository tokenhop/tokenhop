// YAN-1912: the switch-off key picker for key budgets. On an established
// install (hashed keys) with login off, the local owner lists Default's keys
// from GET /api/workspaces/:id/budget-keys and creates a key budget, while
// GET /api/keys keeps refusing `local` and no other principal or mode gains
// access: bearers, non-admin sessions, foreign workspaces and the switch on.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const KID = "0123456789abcdef";
const NOW = "2026-01-01T00:00:00.000Z";

const jar = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n) => {
      const m = jar.cookie.match(new RegExp(`(?:^|; )${n}=([^;]*)`));
      return m ? { name: n, value: m[1] } : undefined;
    },
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(jar.cookie ? { cookie: jar.cookie } : {}),
}));

let adapter;
let db;
let routes;
let t;

const HASHED_DDL = `CREATE TABLE apiKeys (
  id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  userId TEXT REFERENCES users(id) ON DELETE CASCADE,
  createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
  keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
  machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
  revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
  expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`;

function hashedKey(id, workspaceId, { revokedAt = null, name = id } = {}) {
  adapter.run(
    `INSERT INTO apiKeys(id, workspaceId, keyHash, hashKid, prefix, name, revokedAt, createdAt)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, workspaceId, id.padEnd(64, "0"), KID, `th_${id}…`, name, revokedAt, NOW],
  );
}

// Established switch-off install: hashed storage, Default set, one active user
// (owner A), so login off resolves the `local` principal.
async function load({ env = "off", requireLogin = false } = {}) {
  vi.resetModules();
  process.env[ENV] = env;
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  db = await import("@/lib/db/index.js");
  for (const tbl of ["budgets", "auditEvents"]) adapter.run(`DELETE FROM ${tbl}`);
  await db.updateSettings({ requireLogin: true }); // seeding adds a second user
  t = await seedTenancy();
  adapter.run(`DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')`);
  adapter.exec("DROP TABLE apiKeys");
  adapter.exec(HASHED_DDL);
  adapter.run(
    `INSERT INTO _meta(key,value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid',?)`,
    [KID],
  );
  await db.setMeta("defaultWorkspaceId", t.shared.id);
  hashedKey("k-default", t.shared.id, { name: "Laptop" });
  hashedKey("k-revoked", t.shared.id, { revokedAt: NOW });
  hashedKey("k-foreign", t.b.personal);
  await db.updateSettings({ requireLogin });
  routes = {
    keys: await import("@/app/api/workspaces/[id]/budget-keys/route.js"),
    budgets: await import("@/app/api/workspaces/[id]/budgets/route.js"),
    apiKeys: await import("@/app/api/keys/route.js"),
  };
}

const singleUser = () =>
  adapter.run(`UPDATE users SET status = 'disabled' WHERE id != ?`, [t.a.user.id]);

async function cookieFor(u) {
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  return `auth_token=${await createDashboardAuthToken({
    sub: u.user.id,
    sv: u.user.sessionVersion,
    wid: t.shared.id,
  })}`;
}

async function call(handler, url, { method = "GET", body, cookie, bearer, id = "default" } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  jar.cookie = cookie ?? "";
  try {
    const req = new NextRequest(new URL(url, "http://localhost"), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return await handler(req, { params: Promise.resolve({ id }) });
  } finally {
    jar.cookie = "";
  }
}

const listKeys = (opts = {}) =>
  call(routes.keys.GET, `/api/workspaces/${opts.id ?? "default"}/budget-keys`, opts);

beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("budget key picker, switch off, established install", () => {
  it("login off: the local owner lists Default's live keys and creates a key budget", async () => {
    await load();
    singleUser();
    const res = await listKeys();
    expect(res.status).toBe(200);
    const { keys } = await res.json();
    // Live Default keys only; metadata projection, never the hash.
    expect(keys).toEqual([{ id: "k-default", name: "Laptop", prefix: "th_k-default…" }]);
    // The resolved Default id addresses the same list.
    expect((await listKeys({ id: t.shared.id })).status).toBe(200);

    const created = await call(routes.budgets.POST, "/api/workspaces/default/budgets", {
      method: "POST",
      body: { scopeType: "key", scopeId: "k-default", window: "day", limitRequests: 3 },
    });
    expect(created.status).toBe(201);
    expect((await created.json()).budget).toMatchObject({ scopeType: "key", scopeId: "k-default" });
    expect(adapter.get(`SELECT workspaceId FROM budgets WHERE scopeId = 'k-default'`)).toEqual({
      workspaceId: t.shared.id,
    });
  });

  it("GET /api/keys still refuses the local principal (authority not widened)", async () => {
    await load();
    singleUser();
    const res = await call(
      routes.apiKeys.GET,
      `/api/keys?workspaceId=${encodeURIComponent(t.shared.id)}`,
    );
    expect(res.status).toBe(403);
  });

  it("refuses gateway credentials, non-admin sessions and other workspaces", async () => {
    await load();
    singleUser();
    for (const bearer of ["th_anything", "sk-off-raw-0123456789"])
      expect((await listKeys({ bearer })).status).toBe(401);
    expect((await listKeys({ id: t.b.personal })).status).toBe(404);
    expect((await listKeys({ id: "nope" })).status).toBe(404);
  });

  it("login on: an owner session lists them, a plain user session is refused", async () => {
    await load({ requireLogin: true });
    expect((await listKeys()).status).toBe(401); // no credentials, no local access
    const owner = await listKeys({ cookie: await cookieFor(t.a) });
    expect(owner.status).toBe(200);
    expect((await owner.json()).keys.map((k) => k.id)).toEqual(["k-default"]);
    expect((await listKeys({ cookie: await cookieFor(t.b) })).status).toBe(401);
  });

  it("an instance admin outside Default gets 404; cross-site is 403", async () => {
    await load({ requireLogin: true });
    const admin = await db.createUserUnscoped({ email: "adm@keys.test", instanceRole: "admin" });
    const seeded = { user: admin };
    const res = await listKeys({ cookie: await cookieFor(seeded) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found", code: "not_found" });
    const headers = new Headers({ cookie: await cookieFor(t.a), origin: "https://evil.test" });
    headers.set("sec-fetch-site", "cross-site");
    jar.cookie = headers.get("cookie");
    try {
      const req = new NextRequest(
        new URL("/api/workspaces/default/budget-keys", "http://localhost"),
        {
          headers,
        },
      );
      const cross = await routes.keys.GET(req, { params: Promise.resolve({ id: "default" }) });
      expect(cross.status).toBe(403);
    } finally {
      jar.cookie = "";
    }
  });

  it("GET /api/keys authority is unchanged for sessions and bearers", async () => {
    await load({ requireLogin: true });
    const url = `/api/keys?workspaceId=${encodeURIComponent(t.shared.id)}`;
    const owner = await call(routes.apiKeys.GET, url, { cookie: await cookieFor(t.a) });
    expect(owner.status).toBe(200);
    expect((await call(routes.apiKeys.GET, url, { bearer: "th_anything" })).status).toBe(403);
    expect((await call(routes.apiKeys.GET, url)).status).toBe(401);
  });

  it("two active users with login off: no local principal, nothing listed", async () => {
    await load();
    expect((await listKeys()).status).toBe(401);
  });
});

describe("budget key picker, switch on", () => {
  it("is hidden (404) for every caller; the picker uses /api/keys there", async () => {
    await load({ env: "on", requireLogin: true });
    expect((await listKeys()).status).toBe(404);
    expect((await listKeys({ cookie: await cookieFor(t.a) })).status).toBe(404);
  });
});

describe("budget key picker, pristine install (legacy keys)", () => {
  it("lists the global legacy keys without raw key material", async () => {
    vi.resetModules();
    process.env[ENV] = "off";
    adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    for (const tbl of ["budgets", "memberships", "identities", "workspaces", "users"])
      adapter.run(`DELETE FROM ${tbl}`);
    adapter.exec("DROP TABLE apiKeys");
    adapter.exec(`CREATE TABLE apiKeys (
      id TEXT PRIMARY KEY, key TEXT UNIQUE, name TEXT, machineId TEXT,
      isActive INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL)`);
    adapter.run(
      `DELETE FROM _meta WHERE key IN ('defaultWorkspaceId', 'pendingDefaultWorkspaceId', 'apiKeysHashedVersion', 'apiKeysHashKid')`,
    );
    adapter.run(
      `INSERT INTO apiKeys(id, key, name, isActive, createdAt) VALUES('legacy-key', 'sk-pristine-raw-0123456789', 'k', 1, ?)`,
      [NOW],
    );
    db = await import("@/lib/db/index.js");
    await db.updateSettings({ requireLogin: false });
    routes = { keys: await import("@/app/api/workspaces/[id]/budget-keys/route.js") };
    const res = await listKeys();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keys).toEqual([{ id: "legacy-key", name: "k", prefix: null }]);
    expect(JSON.stringify(body)).not.toContain("sk-pristine");
    expect(adapter.get(`SELECT COUNT(*) AS c FROM workspaces`).c).toBe(0); // GET creates nothing
  });
});
