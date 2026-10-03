// YAN-361: workspace ownership of provider connections and nodes. Migration
// fixture, cross-workspace negatives on the YAN-354 two-user harness (repos and
// routes), per-workspace dedup/priority/prefixes, and the switch-off regression.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute, denied, seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const FIXTURE = fs.readFileSync(path.join(__dirname, "../fixtures/db/v1.0.0.sql"), "utf-8");

// Route handlers read cookies(); the harness cookie is mirrored into this jar.
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

let db;
let t;

async function load(state) {
  vi.resetModules();
  process.env[ENV] = state;
  db = await import("@/lib/db/index.js");
}

// Call a route as a seeded user: the session goes to both the request and next/headers.
async function as(seeded, handler, url, opts = {}) {
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  const token = await createDashboardAuthToken({
    sub: seeded.user.id,
    sv: seeded.user.sessionVersion,
    wid: seeded.ctx.activeWorkspaceId,
  });
  jar.cookie = `auth_token=${token}`;
  try {
    return await callRoute(handler, url, { as: seeded, ...opts });
  } finally {
    jar.cookie = "";
  }
}

const apiKeyConn = (name, extra = {}) => ({
  provider: "openai",
  authType: "apikey",
  name,
  apiKey: `sk-${name}`,
  ...extra,
});

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("migration 005 connection-ownership", () => {
  it("adds nullable owner columns to a v1.0.0 DB, keeps rows, reruns as a no-op", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
    const { runVersionedMigrations } = await import("@/lib/db/migrate.js");
    const m005 = (await import("@/lib/db/migrations/005-connection-ownership.js")).default;
    const { adoptOwnerlessRowsUnscoped } = await import("@/lib/db/repos/ownership.js");
    const fx = await createSqlJsAdapter(path.join(process.env.TOKENHOP_TEST_ROOT, "v1.sqlite"));
    fx.exec(FIXTURE);
    runVersionedMigrations(fx);
    m005.up(fx);
    expect(fx.get(`SELECT id, workspaceId, createdByUserId FROM providerConnections`)).toEqual({
      id: "pc1",
      workspaceId: null,
      createdByUserId: null,
    });
    // Before any bootstrap there is nothing to adopt into.
    expect(fx.transaction(() => adoptOwnerlessRowsUnscoped(fx))).toBe(0);
    fx.close();
  });
});

describe("switch on: two users", () => {
  beforeEach(async () => {
    await load("on");
    const a = await (await import("@/lib/db/driver.js")).getAdapter();
    a.run(`DELETE FROM providerConnections`);
    a.run(`DELETE FROM providerNodes`);
    t = await seedTenancy();
    await db.updateSettings({ requireLogin: true });
  });

  it("bootstrap adopts ownerless rows into Default, idempotently", async () => {
    const a = await (await import("@/lib/db/driver.js")).getAdapter();
    const legacy = await db.createProviderConnectionUnscoped(apiKeyConn("legacy"));
    expect(legacy.workspaceId).toBeUndefined();
    a.run(`INSERT INTO _meta(key, value) VALUES('defaultWorkspaceId', ?)`, [t.shared.id]);
    expect(await db.adoptOwnerlessUnscoped()).toBe(1);
    expect(await db.adoptOwnerlessUnscoped()).toBe(0);
    const row = await db.getConnection(t.a.ctx, legacy.id);
    expect(row).toMatchObject({ workspaceId: t.shared.id, createdByUserId: t.a.user.id });
    // Unscoped writers (OAuth flows) now land in Default too.
    const later = await db.createProviderConnectionUnscoped(apiKeyConn("oauth-flow"));
    expect(later.workspaceId).toBe(t.shared.id);
  });

  it("B cannot get, update, delete or list A's personal connection", async () => {
    const { a, b } = t;
    const c = await db.createConnection(a.ctx, a.personal, apiKeyConn("mine"));
    expect(c).toMatchObject({ workspaceId: a.personal, createdByUserId: a.user.id });
    expect(await denied(db.getConnection(b.ctx, c.id))).toBe(true);
    expect(await denied(db.updateConnection(b.ctx, c.id, { name: "x" }))).toBe(true);
    expect(await denied(db.deleteConnection(b.ctx, c.id))).toBe(true);
    expect(await denied(db.listConnections(b.ctx, a.personal))).toBe(true);
    expect(await denied(db.createConnection(b.ctx, a.personal, apiKeyConn("x")))).toBe(true);
    expect((await db.listConnections(b.ctx, b.personal)).map((r) => r.id)).not.toContain(c.id);
    expect((await db.getConnection(a.ctx, c.id)).name).toBe("mine");
  });

  it("same account email in two workspaces is two rows; priority is per workspace", async () => {
    const { a, b } = t;
    const oauth = { provider: "claude", authType: "oauth", email: "me@x.test", accessToken: "t" };
    const ca = await db.createConnection(a.ctx, a.personal, oauth);
    const cb = await db.createConnection(b.ctx, b.personal, { ...oauth, accessToken: "u" });
    expect(cb.id).not.toBe(ca.id);
    expect(cb.priority).toBe(1);
    // Re-login inside one workspace still merges.
    const again = await db.createConnection(a.ctx, a.personal, { ...oauth, accessToken: "v" });
    expect(again.id).toBe(ca.id);
    const a2 = await db.createConnection(a.ctx, a.personal, { ...oauth, email: "two@x.test" });
    expect(a2.priority).toBe(2);
    expect((await db.getConnection(b.ctx, cb.id)).priority).toBe(1);
  });

  it("node prefixes are unique per workspace; nodes are IDOR-safe", async () => {
    const { a, b } = t;
    const node = { type: "openai-compatible", name: "N", prefix: "my", baseUrl: "http://x" };
    const na = await db.createNode(a.ctx, a.personal, { ...node, id: "openai-compatible-a" });
    await db.createNode(b.ctx, b.personal, { ...node, id: "openai-compatible-b" });
    await expect(db.createNode(a.ctx, a.personal, { ...node, id: "dup" })).rejects.toMatchObject({
      code: "PREFIX_TAKEN",
    });
    expect(await denied(db.getNode(b.ctx, na.id))).toBe(true);
    expect(await denied(db.updateNode(b.ctx, na.id, { name: "x" }))).toBe(true);
    expect(await denied(db.deleteNode(b.ctx, na.id))).toBe(true);
    expect((await db.listNodes(b.ctx, b.personal)).map((n) => n.id)).toEqual([
      "openai-compatible-b",
    ]);
  });

  it("routes: B gets 404 on A's rows, a member gets 403 on manage, secrets never leak", async () => {
    const { a, b, shared } = t;
    const item = await import("@/app/api/providers/[id]/route.js");
    const test = await import("@/app/api/providers/[id]/test/route.js");
    const list = await import("@/app/api/providers/route.js");
    const nodes = await import("@/app/api/provider-nodes/[id]/route.js");
    const c = await db.createConnection(a.ctx, a.personal, apiKeyConn("a-key"));
    const sc = await db.createConnection(a.ctx, shared.id, apiKeyConn("team"));
    const n = await db.createNode(a.ctx, a.personal, {
      id: "openai-compatible-chat-n1",
      type: "openai-compatible",
      name: "N",
      prefix: "n1",
      apiType: "chat",
      baseUrl: "http://x",
    });
    const p = { id: c.id };
    expect((await as(b, item.GET, `/api/providers/${c.id}`, { params: p })).status).toBe(404);
    const put = { method: "PUT", body: { name: "x" }, params: p };
    expect((await as(b, item.PUT, `/api/providers/${c.id}`, put)).status).toBe(404);
    const del = { method: "DELETE", params: p };
    expect((await as(b, item.DELETE, `/api/providers/${c.id}`, del)).status).toBe(404);
    const tst = { method: "POST", params: p };
    expect((await as(b, test.POST, `/api/providers/${c.id}/test`, tst)).status).toBe(404);
    const usage = await import("@/app/api/usage/[connectionId]/route.js");
    const reset = await import("@/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const up = { params: { connectionId: c.id } };
    expect((await as(b, usage.GET, `/api/usage/${c.id}?force=1`, up)).status).toBe(404);
    const rp = { method: "POST", params: { connectionId: c.id } };
    expect((await as(b, reset.POST, `/api/usage/${c.id}/codex-reset-credits`, rp)).status).toBe(
      404,
    );
    const np = { method: "DELETE", params: { id: n.id } };
    expect((await as(b, nodes.DELETE, `/api/provider-nodes/${n.id}`, np)).status).toBe(404);
    expect(await db.getNode(a.ctx, n.id)).not.toBeNull();

    // B is a plain member of the shared workspace: may not manage or read metadata.
    const sp = { method: "DELETE", params: { id: sc.id } };
    expect((await as(b, item.DELETE, `/api/providers/${sc.id}`, sp)).status).toBe(403);
    const other = `/api/providers?workspaceId=${a.personal}`;
    expect((await as(b, list.GET, other)).status).toBe(404);

    // A lists the shared workspace: own rows only, never secret fields.
    const res = await as(a, list.GET, `/api/providers?workspaceId=${shared.id}`);
    const { connections } = await res.json();
    expect(connections.map((x) => x.id)).toEqual([sc.id]);
    expect(connections[0].apiKey).toBeUndefined();
    const one = await (
      await as(a, item.GET, `/api/providers/${sc.id}`, { params: { id: sc.id } })
    ).json();
    expect(one.connection.apiKey).toBeUndefined();
    expect(one.connection.name).toBe("team");
  }, 30_000); // cold imports of the route modules (open-sse) under a loaded run
});

describe("switch off: single-user regression", () => {
  it("routes and repos behave as today: unscoped, no owner columns", async () => {
    await load("off");
    const list = await import("@/app/api/providers/route.js");
    const res = await callRoute(list.POST, "/api/providers", {
      method: "POST",
      body: { provider: "openai", apiKey: "sk-off", name: "off" },
    });
    expect(res.status).toBe(201);
    const { connection } = await res.json();
    expect(connection.workspaceId).toBeUndefined();
    const all = await (await callRoute(list.GET, "/api/providers")).json();
    expect(all.connections.map((c) => c.id)).toContain(connection.id);
    expect(all.connections.every((c) => c.apiKey === undefined)).toBe(true);
  }, 30_000);
});
