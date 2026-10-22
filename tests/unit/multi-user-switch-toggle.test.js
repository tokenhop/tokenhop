// YAN-1547: dedicated instance switch, authorization and startup-only activation.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute, seedTenancy } from "../setup/tenancyHarness.js";

const jar = vi.hoisted(() => ({ cookie: "", headers: {} }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name) => {
      const match = jar.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
      return match ? { name, value: match[1] } : undefined;
    },
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(jar.headers),
}));

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const STARTUP = Symbol.for("tokenhop.gatewayKeyStartup");
const savedStartup = globalThis[STARTUP];
let db;
let adapter;
let route;
let feature;
let t;

async function load(env) {
  vi.resetModules();
  if (env === undefined) delete process.env[ENV];
  else process.env[ENV] = env;
  delete globalThis[STARTUP];
  // Owner bootstrap is process-memoised; isolate the fixture between cases.
  delete globalThis.__tokenhopOwnerBootstrap;
  jar.cookie = "";
  jar.headers = {};
  db = await import("@/lib/db/index.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  await db.updateSettings({ multiUserEnabled: false, requireLogin: true });
  t = await seedTenancy();
  adapter.run("DELETE FROM _meta WHERE key = 'defaultWorkspaceId'");
  const defaultWs = await db.createSharedWorkspace(t.a.ctx, { name: "Default" });
  await db.setMeta("defaultWorkspaceId", defaultWs.id);
  adapter.run("DELETE FROM auditEvents");
  route = await import("@/app/api/settings/route.js");
  feature = await import("@/lib/users/featureSwitch.js");
}

async function as(user, handler, opts = {}) {
  if (user) {
    const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
    jar.cookie = `auth_token=${await createDashboardAuthToken({
      sub: user.user.id,
      sv: user.user.sessionVersion,
      wid: user.personal,
    })}`;
  }
  try {
    return await callRoute(handler, "/api/settings", opts);
  } finally {
    jar.cookie = "";
  }
}
const patch = (user, body) => as(user, route.PATCH, { method: "PATCH", body });
const stored = async () => (await feature.getMultiUserSwitchState()).stored;
const counts = () =>
  ["users", "workspaces", "memberships"].map(
    (table) => adapter.get(`SELECT COUNT(*) AS n FROM ${table}`).n,
  );

beforeEach(() => load());
afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  if (savedStartup === undefined) delete globalThis[STARTUP];
  else globalThis[STARTUP] = savedStartup;
});

describe("dedicated multi-user switch control", () => {
  it("owner can toggle immediately without startup and keeps all tenancy rows", async () => {
    // Switch-on principal resolution bootstraps the existing owner's Default
    // invariants first; establish them before measuring the off/on invariant.
    await db.updateSettings({ multiUserEnabled: true });
    const { ensureOwnerBootstrap } = await import("@/lib/users/bootstrap.js");
    await ensureOwnerBootstrap({ throwOnError: true });
    const before = counts();
    let res = await patch(t.a, { multiUserEnabled: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      multiUserSwitch: { stored: false, effective: false, pendingRestart: false },
    });
    expect(await feature.isMultiUserEnabled()).toBe(false);
    const offCounts = counts();
    expect(offCounts).toEqual(before);
    res = await patch(t.a, { multiUserEnabled: true });
    expect(res.status).toBe(200);
    expect(await feature.isMultiUserEnabled()).toBe(true);
    expect(counts()).toEqual(offCounts);
    expect(before[0]).toBe(2);
    res = await patch(t.a, { multiUserEnabled: false });
    expect(res.status).toBe(200);
    expect(await feature.isMultiUserEnabled()).toBe(false);
    expect(counts()).toEqual(offCounts);
  });

  it("off→on in one process adopts connections created while off into Default", async () => {
    await db.updateSettings({ multiUserEnabled: true });
    const { ensureOwnerBootstrap } = await import("@/lib/users/bootstrap.js");
    await ensureOwnerBootstrap({ throwOnError: true });
    expect((await patch(t.a, { multiUserEnabled: false })).status).toBe(200);
    const now = new Date().toISOString();
    adapter.run(
      `INSERT INTO providerConnections(id, provider, authType, name, priority, isActive, data, createdAt, updatedAt)
       VALUES('pc-while-off', 'anthropic', 'apikey', 'while-off', 1, 1, '{}', ?, ?)`,
      [now, now],
    );
    // Deleted teams leave history detached, not available for re-adoption.
    adapter.run("INSERT INTO usageHistory(timestamp, workspaceId) VALUES(?, ?)", [
      now,
      t.shared.id,
    ]);
    adapter.run(
      "INSERT INTO requestDetails(id, timestamp, data, workspaceId) VALUES('detached', ?, '{}', ?)",
      [now, t.shared.id],
    );
    adapter.run("DELETE FROM workspaces WHERE id = ?", [t.shared.id]);
    expect((await patch(t.a, { multiUserEnabled: true })).status).toBe(200);
    expect(
      adapter.get("SELECT workspaceId FROM usageHistory WHERE timestamp = ?", [now]).workspaceId,
    ).toBeNull();
    expect(
      adapter.get("SELECT workspaceId FROM requestDetails WHERE id = 'detached'").workspaceId,
    ).toBeNull();
    const row = adapter.get(
      "SELECT workspaceId FROM providerConnections WHERE id = 'pc-while-off'",
    );
    expect(row.workspaceId).toBe(await db.getMeta("defaultWorkspaceId"));
  });

  it("single-user session owner sees the control and can enable it while login is required", async () => {
    adapter.run("DELETE FROM users WHERE id = ?", [t.b.user.id]);
    const get = await as(t.a, route.GET);
    expect(get.status).toBe(200);
    const payload = await get.json();
    expect(payload).not.toHaveProperty("multiUserEnabled");
    expect(payload.multiUserSwitch).toEqual({
      stored: false,
      effective: false,
      envLocked: false,
      envValue: null,
      pendingRestart: false,
      activeUsers: 1,
      sharedWorkspaces: 1,
    });
    expect((await patch(t.a, { multiUserEnabled: true })).status).toBe(200);
    expect(await feature.isMultiUserEnabled()).toBe(true);
  });

  it("member and viewer cannot change the setting or see the metadata", async () => {
    await db.updateSettings({ multiUserEnabled: true, multiUserSwitch: { stored: "spoofed" } });
    for (const role of ["member", "viewer"]) {
      adapter.run("UPDATE memberships SET role = ? WHERE userId = ?", [role, t.b.user.id]);
      expect((await patch(t.b, { multiUserEnabled: false })).status).toBe(403);
      expect(await stored()).toBe(true);
      expect(await (await as(t.b, route.GET)).json()).not.toHaveProperty("multiUserSwitch");
    }
  });

  it("does not promote a member's signed session while the switch is off", async () => {
    expect((await patch(t.b, { multiUserEnabled: true })).status).toBe(401);
    expect(await stored()).toBe(false);
  });

  it("hashed switch-off rejects manager sessions at the dashboard edge until enabled again", async () => {
    // Mark established storage without running any activation in this test.
    adapter.run(
      "INSERT OR REPLACE INTO _meta(key,value) VALUES('apiKeysHashedVersion','1'),('apiKeysHashKid','0123456789abcdef')",
    );
    adapter.run("UPDATE memberships SET role = 'manager' WHERE userId = ?", [t.b.user.id]);
    const before = counts();
    const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
    const { NextRequest } = await import("next/server");
    const s = await import("@/lib/users/session.js");
    const { proxy } = await import("@/dashboardGuard.js");
    const request = async (user) =>
      new NextRequest("http://localhost/api/providers", {
        headers: {
          cookie: `auth_token=${await createDashboardAuthToken({ sub: user.user.id, sv: user.user.sessionVersion })}`,
        },
      });
    try {
      const member = await request(t.b);
      const owner = await request(t.a);
      expect(await s.hasValidSession(member)).toBe(false);
      expect(
        await s.principalCan(member, "workspace.connections.manage", { anyWorkspace: true }),
      ).toBe(false);
      expect(await s.resolvePrincipal(member)).toBeNull();
      expect((await proxy(member)).status).toBe(401);
      expect(await s.hasValidSession(owner)).toBe(true);
      expect((await proxy(owner)).status).toBe(200);
      await db.updateSettings({ multiUserEnabled: true });
      expect(await s.hasValidSession(member)).toBe(true);
      expect(
        await s.principalCan(member, "workspace.connections.manage", { anyWorkspace: true }),
      ).toBe(true);
      expect((await proxy(member)).status).toBe(200);
      expect(counts()).toEqual(before);
    } finally {
      adapter.run("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
    }
  });

  it("accepts the legacy single-admin session without creating tenancy rows before restart", async () => {
    adapter.run("DELETE FROM users");
    adapter.run("DELETE FROM workspaces");
    const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
    jar.cookie = `auth_token=${await createDashboardAuthToken()}`;
    globalThis[STARTUP] = { multiUserAtBoot: false, activation: { status: "skipped-off" } };
    const before = counts();
    const res = await patch(null, { multiUserEnabled: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ multiUserSwitch: { pendingRestart: true } });
    expect(counts()).toEqual(before);
    expect(before).toEqual([0, 0, 0]);
  });

  it("accepts single-user local authority with login disabled", async () => {
    adapter.run("DELETE FROM users WHERE id = ?", [t.b.user.id]);
    await db.updateSettings({ requireLogin: false });
    expect((await patch(null, { multiUserEnabled: true })).status).toBe(200);
    expect(await stored()).toBe(true);
  });

  it("accepts the single-user CLI owner while the switch is off", async () => {
    adapter.run("DELETE FROM users WHERE id = ?", [t.b.user.id]);
    const { getCliToken } = await import("@/lib/auth/cliToken.js");
    jar.headers = { "x-9r-cli-token": await getCliToken() };
    expect((await patch(null, { multiUserEnabled: true })).status).toBe(200);
    expect(await stored()).toBe(true);
  });

  it("rejects unauthenticated and workspace-key bearer callers without changing the setting", async () => {
    expect((await patch(null, { multiUserEnabled: true })).status).toBe(401);
    expect(await stored()).toBe(false);
    const { seedGatewayWorld, TOKEN_B } = await import(
      "../helpers/tenantIsolation/gatewayWorld.js"
    );
    const master = process.env.TOKENHOP_MASTER_KEY;
    try {
      await seedGatewayWorld();
      await db.updateSettings({ multiUserEnabled: false, requireLogin: true });
      jar.headers = { authorization: `Bearer ${TOKEN_B}` };
      const res = await callRoute(route.PATCH, "/api/settings", {
        method: "PATCH",
        apiKey: TOKEN_B,
        body: { multiUserEnabled: true },
      });
      expect(res.status).toBe(401);
      expect(await stored()).toBe(false);
    } finally {
      jar.headers = {};
      if (master === undefined) delete process.env.TOKENHOP_MASTER_KEY;
      else process.env.TOKENHOP_MASTER_KEY = master;
      // The gateway fixture installs hashed storage; restore this file's legacy
      // schema for later tests (no real migrations are triggered here).
      adapter.exec("DROP TABLE apiKeys");
      adapter.exec(
        "CREATE TABLE apiKeys (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT, isActive INTEGER DEFAULT 1, createdAt TEXT)",
      );
      adapter.run("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
    }
  });

  it.each(["on", "off"])("env %s locks the switch", async (env) => {
    await load(env);
    adapter.run("DELETE FROM users WHERE id = ?", [t.b.user.id]);
    const res = await patch(t.a, { multiUserEnabled: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Set by TOKENHOP_MULTI_USER",
      code: "MULTI_USER_ENV_LOCKED",
    });
    expect(await stored()).toBe(false);
    expect(await feature.getMultiUserSwitchState()).toMatchObject({
      stored: false,
      effective: env === "on",
      envLocked: true,
      envValue: env,
      pendingRestart: false,
    });
  });

  it("rejects cross-site requests before validating or writing the switch", async () => {
    const res = await route.PATCH(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        headers: { "sec-fetch-site": "cross-site" },
        body: JSON.stringify({ multiUserEnabled: "invalid" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await stored()).toBe(false);
  });

  it("rejects mixed bodies and non-booleans", async () => {
    const res = await patch(t.a, { multiUserEnabled: true, requireLogin: false });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "multiUserEnabled must be the only setting" });
    expect((await patch(t.a, { multiUserEnabled: "true" })).status).toBe(400);
    expect(await stored()).toBe(false);
  });

  it("audits enabled before/after with the owner actor", async () => {
    adapter.run("DELETE FROM users WHERE id = ?", [t.b.user.id]);
    expect((await patch(t.a, { multiUserEnabled: true })).status).toBe(200);
    const event = adapter.get("SELECT * FROM auditEvents WHERE action = 'settings.multi_user'");
    expect(event.actorUserId).toBe(t.a.user.id);
    expect(event.via).toBe("session");
    expect(JSON.parse(event.before)).toEqual({ enabled: false });
    expect(JSON.parse(event.after)).toEqual({ enabled: true });
  });

  it("excludes Default by stable id even after a rename", async () => {
    await db.updateSettings({ multiUserEnabled: true });
    const { ensureOwnerBootstrap } = await import("@/lib/users/bootstrap.js");
    await ensureOwnerBootstrap({ throwOnError: true });
    const id = await db.getMeta("defaultWorkspaceId");
    adapter.run("UPDATE workspaces SET name = 'Renamed' WHERE id = ?", [id]);
    const payload = await (await as(t.a, route.GET)).json();
    expect(payload.multiUserSwitch.sharedWorkspaces).toBe(1);
  });
});

describe("pending first activation", () => {
  it("gates legacy skipped-off boots, but not hashed/activated boots or absent startup", async () => {
    await db.updateSettings({ multiUserEnabled: true });
    for (const [status, pendingRestart] of [
      ["skipped-off", true],
      ["already-hashed", false],
      ["ready", false],
    ]) {
      globalThis[STARTUP] = { multiUserAtBoot: false, activation: { status } };
      expect(await feature.isMultiUserEnabled()).toBe(!pendingRestart);
      expect(await feature.getMultiUserSwitchState()).toMatchObject({
        stored: true,
        effective: !pendingRestart,
        pendingRestart,
      });
    }
    delete globalThis[STARTUP];
    expect(await feature.isMultiUserEnabled()).toBe(true);
  });

  it("saves first enable but exposes pending restart without activating storage", async () => {
    adapter.run("DELETE FROM users WHERE id = ?", [t.b.user.id]);
    globalThis[STARTUP] = { multiUserAtBoot: false, activation: { status: "skipped-off" } };
    const before = counts();
    const res = await patch(t.a, { multiUserEnabled: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      multiUserSwitch: { stored: true, effective: false, pendingRestart: true },
    });
    expect(counts()).toEqual(before);
    expect(await feature.isMultiUserEnabled()).toBe(false);
    expect(adapter.get("SELECT value FROM _meta WHERE key = 'apiKeysHashedVersion'")).toBeFalsy();
  });
});
