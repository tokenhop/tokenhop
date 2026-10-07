// YAN-366: host auto-import guard, workspace-scoped imports/dedup and
// cross-principal Kiro social exchange. Real DB/session/guard; no network.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const savedPeer = process.env.TOKENHOP_PEER_TOKEN;
const LOCAL = { "x-9r-peer-token": "oauth-import-peer", "x-9r-real-ip": "127.0.0.1" };

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

const mocks = vi.hoisted(() => ({
  exchangeSocialCode: vi.fn(async () => ({
    accessToken: "kiro-access",
    refreshToken: "kiro-refresh",
    expiresIn: 3600,
  })),
}));
vi.mock("@/lib/oauth/services/kiro", () => ({
  KiroService: class {
    buildSocialLoginUrl(_provider, _challenge, state) {
      return `https://idp.test/auth?state=${state}`;
    }
    exchangeSocialCode = mocks.exchangeSocialCode;
    extractEmailFromJWT() {
      return "social@oauth.test";
    }
  },
}));

let adapter;
let fetchSpy;
let t;
let routes;

async function load(state) {
  vi.resetModules();
  vi.clearAllMocks();
  process.env[ENV] = state;
  process.env.TOKENHOP_PEER_TOKEN = LOCAL["x-9r-peer-token"];
  // Xiaomi validates /models with fetch; Cursor import validates locally only.
  // open-sse/utils/proxyFetch.js swaps globalThis.fetch for its wrapper on
  // import and forwards to this stub, so assertions target the stub itself.
  fetchSpy = vi.fn(async () => Response.json({ data: [{ id: "mimo" }] }));
  vi.stubGlobal("fetch", fetchSpy);
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  adapter.run("DELETE FROM providerConnections");
  adapter.run("INSERT OR REPLACE INTO settings(id, data) VALUES (1, '{}')");
  t = await seedTenancy();
  // Seed the bootstrap Default marker so null/unowned landing cannot pass.
  adapter.run("UPDATE workspaces SET name = 'Default' WHERE id = ?", [t.shared.id]);
  adapter.run("INSERT OR REPLACE INTO _meta(key, value) VALUES ('defaultWorkspaceId', ?)", [
    t.shared.id,
  ]);
  routes = {
    cursor: await import("@/app/api/oauth/cursor/import/route.js"),
    mimo: await import("@/app/api/oauth/xiaomi-mimo/api-key/route.js"),
    authorize: await import("@/app/api/oauth/kiro/social-authorize/route.js"),
    exchange: await import("@/app/api/oauth/kiro/social-exchange/route.js"),
    gitlab: await import("@/app/api/oauth/gitlab/pat/route.js"),
  };
}

async function as(who, handler, path, { body } = {}) {
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  const { NextRequest } = await import("next/server");
  const headers = new Headers(LOCAL);
  if (who) {
    jar.cookie = `auth_token=${await createDashboardAuthToken({
      sub: who.user.id,
      sv: who.user.sessionVersion,
      wid: who.ctx.activeWorkspaceId,
    })}`;
    headers.set("cookie", jar.cookie);
  }
  if (body !== undefined) headers.set("content-type", "application/json");
  const req = new NextRequest(new URL(path, "http://localhost"), {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    return await handler(req);
  } finally {
    jar.cookie = "";
  }
}

// Real Cursor format validation: sufficiently long JWT plus UUID machine ID.
const cursorBody = {
  accessToken: `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(
    JSON.stringify({ email: "cursor@oauth.test", sub: "cursor-user" }),
  ).toString("base64url")}.signature`,
  machineId: "01234567-89ab-cdef-0123-456789abcdef",
};
const row = (id) => adapter.get("SELECT * FROM providerConnections WHERE id = ?", [id]);

async function imported(who, route, path, body) {
  const res = await as(who, route.POST, path, { body });
  expect(res.status).toBe(200);
  const payload = await res.json();
  expect(payload.success).toBe(true);
  return payload;
}

afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  if (savedPeer === undefined) delete process.env.TOKENHOP_PEER_TOKEN;
  else process.env.TOKENHOP_PEER_TOKEN = savedPeer;
});

describe("OAuth imports, switch on", () => {
  it("auto-import guard denies non-admin B; local owner passes hostOps", async () => {
    await load("on");
    const { proxy } = await import("@/dashboardGuard.js");
    const { resolveRoutePolicy } = await import("@/lib/auth/routePolicy.js");
    const { can } = await import("@/lib/users/principal.js");
    expect(can(t.b.ctx, "instance.hostOps")).toBe(false);
    expect(can(t.a.ctx, "instance.hostOps")).toBe(true);
    for (const provider of ["cursor", "kiro", "xiaomi-mimo"]) {
      const path = `/api/oauth/${provider}/auto-import`;
      expect(resolveRoutePolicy(path, "GET")).toMatchObject({
        capability: "instance.hostOps",
        localOnly: true,
        alwaysProtected: true,
      });
      const denied = await as(t.b, proxy, path);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: "Forbidden" });
      const allowed = await as(t.a, proxy, path);
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("Cursor imports land in personal or selected shared workspace; B cannot target A", async () => {
    await load("on");
    const path = "/api/oauth/cursor/import";
    const personal = await imported(t.a, routes.cursor, path, cursorBody);
    expect(row(personal.connection.id)).toMatchObject({
      workspaceId: t.a.personal,
      createdByUserId: t.a.user.id,
    });
    const shared = await imported(
      t.a,
      routes.cursor,
      `${path}?workspaceId=${t.shared.id}`,
      cursorBody,
    );
    expect(shared.connection.id).not.toBe(personal.connection.id);
    expect(row(shared.connection.id)).toMatchObject({
      workspaceId: t.shared.id,
      createdByUserId: t.a.user.id,
    });
    const denied = await as(t.b, routes.cursor.POST, `${path}?workspaceId=${t.a.personal}`, {
      body: cursorBody,
    });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: "Workspace not found" });
    expect(adapter.get("SELECT COUNT(*) AS n FROM providerConnections").n).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Xiaomi uid dedup updates only its workspace; another workspace keeps its key", async () => {
    await load("on");
    const path = "/api/oauth/xiaomi-mimo/api-key";
    const a = await imported(t.a, routes.mimo, path, { uid: "same", apiKey: "sk-a" });
    const b = await imported(t.b, routes.mimo, path, { uid: "same", apiKey: "sk-b" });
    expect(b.connection.id).not.toBe(a.connection.id);
    expect(row(a.connection.id).workspaceId).toBe(t.a.personal);
    expect(row(b.connection.id).workspaceId).toBe(t.b.personal);
    const updated = await imported(t.a, routes.mimo, path, { uid: "same", apiKey: "sk-a-new" });
    expect(updated).toMatchObject({ updated: true, connection: { id: a.connection.id } });
    expect(adapter.get("SELECT COUNT(*) AS n FROM providerConnections").n).toBe(2);
    const { getConnection } = await import("@/lib/db/index.js");
    expect((await getConnection(t.a.ctx, a.connection.id)).accessToken).toBe("sk-a-new");
    expect((await getConnection(t.b.ctx, b.connection.id)).accessToken).toBe("sk-b");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("GitLab PAT from B lands in B personal; A's Default row with the same email is untouched", async () => {
    await load("on");
    fetchSpy.mockImplementation(async () =>
      Response.json({ email: "dup@oauth.test", name: "Dup", username: "dup" }),
    );
    const path = "/api/oauth/gitlab/pat";
    await imported(t.a, routes.gitlab, `${path}?workspaceId=${t.shared.id}`, { token: "pat-a" });
    await imported(t.b, routes.gitlab, path, { token: "pat-b" });
    const rows = adapter.all("SELECT id, workspaceId FROM providerConnections");
    expect(rows.map((r) => r.workspaceId).sort()).toEqual([t.b.personal, t.shared.id].sort());
    const { getConnection } = await import("@/lib/db/index.js");
    const aRow = rows.find((r) => r.workspaceId === t.shared.id);
    expect((await getConnection(t.a.ctx, aRow.id)).accessToken).toBe("pat-a");
  });

  it("Kiro social state belongs to A: B cannot exchange, A can still finish", async () => {
    await load("on");
    const start = await as(
      t.a,
      routes.authorize.GET,
      "/api/oauth/kiro/social-authorize?provider=google",
    );
    expect(start.status).toBe(200);
    const { state, codeVerifier } = await start.json();
    expect(state).toEqual(expect.any(String));
    const body = { code: "social-code", codeVerifier, provider: "google", state };
    const denied = await as(t.b, routes.exchange.POST, "/api/oauth/kiro/social-exchange", { body });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "Forbidden" });
    expect(mocks.exchangeSocialCode).not.toHaveBeenCalled();
    expect(adapter.get("SELECT COUNT(*) AS n FROM providerConnections").n).toBe(0);
    const done = await imported(t.a, routes.exchange, "/api/oauth/kiro/social-exchange", body);
    expect(row(done.connection.id)).toMatchObject({
      workspaceId: t.a.personal,
      createdByUserId: t.a.user.id,
    });
    expect(mocks.exchangeSocialCode).toHaveBeenCalledWith("social-code", codeVerifier);
  });
});

describe("OAuth imports, switch off", () => {
  it("Cursor import without workspace params lands in Default, even without cookie", async () => {
    await load("off");
    const result = await imported(null, routes.cursor, "/api/oauth/cursor/import", cursorBody);
    expect(row(result.connection.id)).toMatchObject({
      workspaceId: t.shared.id,
      createdByUserId: null,
    });
    expect(result.connection).not.toHaveProperty("workspaceId");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
