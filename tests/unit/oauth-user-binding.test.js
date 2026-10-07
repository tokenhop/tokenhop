// YAN-366: user-bound provider OAuth flows. Cross-principal negatives on the
// YAN-354 two-user harness (device poll, authorize/exchange, poll-status,
// stop-proxy), workspace landing, loopback-callback binding, host-only
// refusal, and the switch-off regression. Providers and loopback listeners are
// mocked: no network, no sockets.
import { afterAll, describe, expect, it, vi } from "vitest";
import { seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const savedPeer = process.env.TOKENHOP_PEER_TOKEN;
process.env.TOKENHOP_PEER_TOKEN = "peer-secret";

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

vi.mock("@/lib/oauth/providers", () => ({
  getProvider: (p) => ({ flowType: p === "github" ? "device_code" : "authorization_code" }),
  generateAuthData: vi.fn(async (_p, _redirect) => ({
    authUrl: "https://idp.test/auth",
    state: `st-${Math.random().toString(36).slice(2)}`,
    codeVerifier: "cv",
    codeChallenge: "cc",
  })),
  requestDeviceCode: vi.fn(async () => ({
    device_code: `dc-${Math.random().toString(36).slice(2)}`,
    user_code: "ABCD-EFGH",
    verification_uri: "https://idp.test/device",
  })),
  pollForToken: vi.fn(async () => ({
    success: true,
    tokens: { accessToken: "at-dev", email: "dev@oauth.test", expiresIn: 3600 },
  })),
  exchangeTokens: vi.fn(async () => ({
    accessToken: "at-ex",
    refreshToken: "rt-ex",
    email: "ex@oauth.test",
    expiresIn: 3600,
  })),
}));

// Real session/binding helpers; only the listeners and host probes are stubbed.
vi.mock("@/lib/oauth/utils/server", async (orig) => ({
  ...(await orig()),
  startCodexProxy: vi.fn(async () => ({ success: true })),
  startXaiProxy: vi.fn(async () => ({ success: true })),
  startTraeProxy: vi.fn(async () => ({ success: true })),
  startWindsurfProxy: vi.fn(async () => ({ success: true })),
  startZedProxy: vi.fn(async () => ({ success: true })),
  startXiaomiMimoProxy: vi.fn(async () => ({ success: true })),
  stopCodexProxy: vi.fn(),
}));
vi.mock("@/lib/oauth/utils/ideDetect", () => ({ detectIdeInstalled: vi.fn(async () => ({})) }));

let t;
let adapter;
let route;
let server;
let generateAuthData;

async function load(state) {
  vi.resetModules();
  process.env[ENV] = state;
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  adapter.run("DELETE FROM providerConnections");
  adapter.run("INSERT OR REPLACE INTO settings(id, data) VALUES (1, '{}')");
  route = await import("@/app/api/oauth/[provider]/[action]/route.js");
  server = await import("@/lib/oauth/utils/server");
  ({ generateAuthData } = await import("@/lib/oauth/providers"));
  t = await seedTenancy();
  // Harness seeds Shared, not the bootstrap Default marker. Give the legacy
  // writer a real Default target so an ownerless/null landing cannot pass.
  adapter.run("UPDATE workspaces SET name = 'Default' WHERE id = ?", [t.shared.id]);
  adapter.run("INSERT OR REPLACE INTO _meta(key, value) VALUES ('defaultWorkspaceId', ?)", [
    t.shared.id,
  ]);
}

// Loopback peer stamped like custom-server.js does; `remote` adds the proxy hop.
const LOCAL = { "x-9r-peer-token": "peer-secret", "x-9r-real-ip": "127.0.0.1" };
const REMOTE = { ...LOCAL, "x-9r-via-proxy": "1" };

async function call(who, action, provider, { qs = "", body, headers = LOCAL } = {}) {
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  const h = new Headers(headers);
  if (who) {
    const cookie = `auth_token=${await createDashboardAuthToken({
      sub: who.user.id,
      sv: who.user.sessionVersion,
      wid: who.ctx.activeWorkspaceId,
    })}`;
    jar.cookie = cookie;
    h.set("cookie", cookie);
  }
  const method = body === undefined ? "GET" : "POST";
  if (body !== undefined) h.set("content-type", "application/json");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(
    new URL(`/api/oauth/${provider}/${action}${qs}`, "http://localhost"),
    {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  try {
    return await route[method]?.(req, { params: Promise.resolve({ provider, action }) });
  } finally {
    jar.cookie = "";
  }
}

const row = (id) => adapter.get("SELECT * FROM providerConnections WHERE id = ?", [id]);

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  if (savedPeer === undefined) delete process.env.TOKENHOP_PEER_TOKEN;
  else process.env.TOKENHOP_PEER_TOKEN = savedPeer;
});

describe("oauth user binding, switch on", () => {
  it("device poll: B refused on A's deviceCode; A lands in A personal", async () => {
    await load("on");
    const dev = await (await call(t.a, "device-code", "github")).json();
    const poll = (who) => call(who, "poll", "github", { body: { deviceCode: dev.device_code } });
    const denied = await poll(t.b);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "Forbidden" });
    expect(adapter.get("SELECT COUNT(*) AS c FROM providerConnections").c).toBe(0);

    const ok = await poll(t.a);
    expect(ok.status).toBe(200);
    const { success, connection } = await ok.json();
    expect(success).toBe(true);
    expect(row(connection.id)).toMatchObject({
      workspaceId: t.a.personal,
      createdByUserId: t.a.user.id,
    });
  });

  it("chosen workspace: manager picks shared; member refused; default is own personal", async () => {
    await load("on");
    const dev = await (
      await call(t.a, "device-code", "github", { qs: `?workspaceId=${t.shared.id}` })
    ).json();
    const ok = await call(t.a, "poll", "github", { body: { deviceCode: dev.device_code } });
    const { connection } = await ok.json();
    expect(row(connection.id).workspaceId).toBe(t.shared.id);

    const refused = await call(t.b, "device-code", "github", { qs: `?workspaceId=${t.shared.id}` });
    expect(refused.status).toBe(403);

    const own = await (await call(t.b, "device-code", "github")).json();
    const done = await call(t.b, "poll", "github", { body: { deviceCode: own.device_code } });
    expect(row((await done.json()).connection.id).workspaceId).toBe(t.b.personal);
  });

  it("authorize/exchange: B refused on A's state; A lands in A personal", async () => {
    await load("on");
    const auth = await (await call(t.a, "authorize", "claude")).json();
    const payload = {
      code: "c",
      redirectUri: "http://localhost:8080/callback",
      codeVerifier: auth.codeVerifier,
      state: auth.state,
    };
    expect((await call(t.b, "exchange", "claude", { body: payload })).status).toBe(403);
    expect(adapter.get("SELECT COUNT(*) AS c FROM providerConnections").c).toBe(0);

    const ok = await call(t.a, "exchange", "claude", { body: payload });
    expect(ok.status).toBe(200);
    expect(row((await ok.json()).connection.id).workspaceId).toBe(t.a.personal);
  });

  it("poll-status: B refused on A's codex session; A gets 200 without binding", async () => {
    await load("on");
    const binding = { userId: t.a.user.id, workspaceId: t.a.personal, ctx: t.a.ctx };
    server.registerCodexSession({
      state: "cx1",
      codeVerifier: "cv",
      redirectUri: "http://localhost:1455/auth/callback",
      binding,
    });
    server.getCodexSessionStatus("cx1").status = "done";
    expect((await call(t.b, "poll-status", "codex", { qs: "?state=cx1" })).status).toBe(403);

    const ok = await call(t.a, "poll-status", "codex", { qs: "?state=cx1" });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body).toMatchObject({ status: "done", codeVerifier: "cv" });
    expect(body).not.toHaveProperty("binding");
  });

  it("stop-proxy: B cannot kill A's live codex flow; A can", async () => {
    await load("on");
    server.registerCodexSession({
      state: "cx2",
      codeVerifier: "cv",
      redirectUri: "http://localhost:1455/auth/callback",
      binding: { userId: t.a.user.id, workspaceId: t.a.personal, ctx: t.a.ctx },
    });
    expect(server.otherOwnerActive("codex", t.b.user.id)).toBe(true);
    expect((await call(t.b, "stop-proxy", "codex")).status).toBe(403);
    expect(server.stopCodexProxy).not.toHaveBeenCalled();
    const ok = await call(t.a, "stop-proxy", "codex");
    expect(await ok.json()).toEqual({ success: true });

    // A second live flow owned by B: A can no longer stop the shared proxy.
    server.registerCodexSession({
      state: "cx3",
      codeVerifier: "cv",
      redirectUri: "http://localhost:1455/auth/callback",
      binding: { userId: t.b.user.id, workspaceId: t.b.personal, ctx: t.b.ctx },
    });
    expect((await call(t.a, "stop-proxy", "codex")).status).toBe(403);
  });

  it("unbound flows (started before a second user): instance owner only", async () => {
    await load("on");
    server.registerCodexSession({
      state: "cx-legacy",
      codeVerifier: "cv",
      redirectUri: "http://localhost:1455/auth/callback",
    });
    server.getCodexSessionStatus("cx-legacy").status = "done";
    const qs = "?state=cx-legacy";
    expect((await call(t.b, "poll-status", "codex", { qs })).status).toBe(403);
    expect((await call(t.a, "poll-status", "codex", { qs })).status).toBe(200);

    const body = { deviceCode: "dc-never-bound" };
    expect((await call(t.b, "poll", "github", { body })).status).toBe(400);
    const owner = await call(t.a, "poll", "github", { body });
    expect(owner.status).toBe(200);
    expect(row((await owner.json()).connection.id).workspaceId).toBe(t.a.personal);
  });

  it("demoted mid-flow: manage capability is re-checked at completion", async () => {
    await load("on");
    const setRole = (role) =>
      adapter.run("UPDATE memberships SET role = ? WHERE workspaceId = ? AND userId = ?", [
        role,
        t.shared.id,
        t.b.user.id,
      ]);
    setRole("manager");
    const dev = await (
      await call(t.b, "device-code", "github", { qs: `?workspaceId=${t.shared.id}` })
    ).json();
    expect(dev.device_code).toBeTruthy();
    setRole("member");
    const res = await call(t.b, "poll", "github", { body: { deviceCode: dev.device_code } });
    expect(res.status).toBe(403);
    expect(adapter.get("SELECT COUNT(*) AS c FROM providerConnections").c).toBe(0);

    // Loopback path: a binding captured while B was manager works, then fails
    // after the demotion, so the role is reloaded, not read from the snapshot.
    setRole("manager");
    const managerCtx = {
      ...t.b.ctx,
      workspaceRoles: { ...t.b.ctx.workspaceRoles, [t.shared.id]: "manager" },
    };
    const binding = { userId: t.b.user.id, workspaceId: t.shared.id, ctx: managerCtx };
    const data = (email) => ({ provider: "claude", authType: "oauth", email, accessToken: "at" });
    const made = await server.createSessionConnection(binding, data("ok@cb.test"));
    expect(row(made.id).workspaceId).toBe(t.shared.id);
    setRole("member");
    await expect(server.createSessionConnection(binding, data("late@cb.test"))).rejects.toThrow(
      "Forbidden",
    );
  });

  it("binding store: one user's flood can't evict another user's binding", async () => {
    const store = await import("@/lib/oauth/pendingBinding");
    store.rememberBinding("victim", { provider: "github", userId: "u-victim", workspaceId: "w" });
    for (let i = 0; i < 1200; i++) {
      store.rememberBinding(`flood-${i}`, {
        provider: "github",
        userId: "u-flood",
        workspaceId: "w",
      });
    }
    expect(store.bindingFor("victim")?.userId).toBe("u-victim");
    expect(store.bindingFor("flood-0")).toBeNull();
    expect(store.bindingFor("flood-1199")?.userId).toBe("u-flood");
  });

  it("finished or abandoned flows don't lock out other users", async () => {
    await load("on");
    // The mocked server module survives vi.resetModules(): drop earlier live flows.
    for (const s of ["cx2", "cx3"]) server.clearCodexSession(s);
    expect(server.otherOwnerActive("codex", t.b.user.id)).toBe(false);
    const bindA = { userId: t.a.user.id, workspaceId: t.a.personal, ctx: t.a.ctx };
    const reg = (state) =>
      server.registerCodexSession({
        state,
        codeVerifier: "cv",
        redirectUri: "http://localhost:1455/auth/callback",
        binding: bindA,
      });
    reg("cx-done");
    server.getCodexSessionStatus("cx-done").status = "done";
    reg("cx-stale");
    server.getCodexSessionStatus("cx-stale").createdAt = Date.now() - 31 * 60_000;
    expect(server.otherOwnerActive("codex", t.b.user.id)).toBe(false);
    expect((await call(t.b, "stop-proxy", "codex")).status).toBe(200);
  });

  it("xAI manual-code on an unbound session lands in the owner's personal workspace", async () => {
    await load("on");
    server.registerXaiSession({
      state: "xai-legacy",
      codeVerifier: "cv",
      redirectUri: "http://127.0.0.1:56121/callback",
    });
    const body = { code: "c", state: "xai-legacy" };
    expect((await call(t.b, "manual-code", "xai", { body })).status).toBe(403);
    const ok = await call(t.a, "manual-code", "xai", { body });
    expect(ok.status).toBe(200);
    expect(row((await ok.json()).connection.id)).toMatchObject({
      workspaceId: t.a.personal,
      createdByUserId: t.a.user.id,
    });
  });

  it("loopback callback create: binding decides workspace/owner; none = Default", async () => {
    await load("on");
    const data = (name) => ({
      provider: "claude",
      authType: "oauth",
      email: `${name}@cb.test`,
      accessToken: "at",
    });
    const bound = await server.createSessionConnection(
      { userId: t.b.user.id, workspaceId: t.b.personal, ctx: t.b.ctx },
      data("b"),
    );
    expect(row(bound.id)).toMatchObject({
      workspaceId: t.b.personal,
      createdByUserId: t.b.user.id,
    });

    const unbound = await server.createSessionConnection(undefined, data("legacy"));
    expect(row(unbound.id)).toMatchObject({ workspaceId: t.shared.id, createdByUserId: null });
  });

  it("host-only: start-proxy and ide-status refuse remote; device-code stays allowed", async () => {
    await load("on");
    for (const [action, provider] of [
      ["start-proxy", "zed"],
      ["ide-status", "trae"],
    ]) {
      const res = await call(t.a, action, provider, { headers: REMOTE });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ hostOnly: true });
    }
    expect((await call(t.a, "ide-status", "trae", { headers: LOCAL })).status).toBe(200);
    expect((await call(t.a, "device-code", "github", { headers: REMOTE })).status).toBe(200);
  });
});

describe("oauth user binding, switch off", () => {
  it("flows work unscoped: Default workspace, no params, verifier still returned", async () => {
    await load("off");
    const landed = (id) => row(id).workspaceId ?? null;

    // device-code → poll, as different "principals": nobody is refused.
    const dev = await (await call(t.a, "device-code", "github")).json();
    const polled = await call(t.b, "poll", "github", { body: { deviceCode: dev.device_code } });
    expect(polled.status).toBe(200);
    const pj = await polled.json();
    expect(pj).toMatchObject({ success: true, connection: { provider: "github" } });
    expect(landed(pj.connection.id)).toBe(t.shared.id);

    // authorize → exchange, cookie-less local request.
    const auth = await (await call(null, "authorize", "claude")).json();
    expect(generateAuthData).toHaveBeenCalled();
    const ex = await call(t.b, "exchange", "claude", {
      body: {
        code: "c",
        redirectUri: "http://localhost:8080/callback",
        codeVerifier: auth.codeVerifier,
        state: auth.state,
      },
    });
    expect(ex.status).toBe(200);
    expect(landed((await ex.json()).connection.id)).toBe(t.shared.id);

    // poll-status still returns the verifier fields; no 403 for another principal.
    server.registerCodexSession({
      state: "cx-off",
      codeVerifier: "cv-off",
      redirectUri: "http://localhost:1455/auth/callback",
    });
    server.getCodexSessionStatus("cx-off").status = "done";
    const ps = await call(t.b, "poll-status", "codex", { qs: "?state=cx-off" });
    expect(ps.status).toBe(200);
    expect(await ps.json()).toMatchObject({
      codeVerifier: "cv-off",
      redirectUri: expect.any(String),
    });

    // host-only gate is inert, even for a remote request.
    expect((await call(t.a, "ide-status", "trae", { headers: REMOTE })).status).toBe(200);
  });
});
