// YAN-1829: workspace budget routes on a pristine switch-off install (legacy
// key storage, no users). The single dashboard admin — a legacy session, or
// login-off local access — manages workspace and key budgets on the pending
// Default, created by the first budget. Gateway credentials never authorize,
// multi-user scopes answer 400 scope_unavailable, and audit/creator ids stay
// NULL (no user row exists).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const NOW = "2026-01-01T00:00:00.000Z";

let adapter;
let routes;
let db;

async function load({ requireLogin = true, env = "off" } = {}) {
  vi.resetModules();
  if (env === null) delete process.env[ENV];
  else process.env[ENV] = env;
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  for (const tbl of [
    "budgets",
    "auditEvents",
    "apiKeys",
    "memberships",
    "identities",
    "workspaces",
    "users",
  ])
    adapter.run(`DELETE FROM ${tbl}`);
  adapter.run(
    `DELETE FROM _meta WHERE key IN ('defaultWorkspaceId', 'pendingDefaultWorkspaceId', 'apiKeysHashedVersion', 'apiKeysHashKid')`,
  );
  adapter.run(
    `INSERT INTO apiKeys(id, key, name, isActive, createdAt) VALUES('legacy-key', 'sk-pristine-raw-0123456789', 'k', 1, ?)`,
    [NOW],
  );
  db = await import("@/lib/db/index.js");
  await db.updateSettings({ requireLogin });
  routes = {
    ws: await import("@/app/api/workspaces/[id]/budgets/route.js"),
    wsOne: await import("@/app/api/workspaces/[id]/budgets/[budgetId]/route.js"),
    user: await import("@/app/api/users/[id]/budgets/route.js"),
  };
}

// Pre-users dashboard session: signed token without `sub`.
async function legacyCookie() {
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  return `auth_token=${await createDashboardAuthToken({})}`;
}

async function call(handler, path, { method = "GET", body, params, cookie, bearer } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  const req = new NextRequest(new URL(path, "http://localhost"), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handler(req, { params: Promise.resolve(params ?? {}) });
}

const post = (body, opts = {}) =>
  call(routes.ws.POST, "/api/workspaces/default/budgets", {
    method: "POST",
    body,
    params: { id: "default" },
    ...opts,
  });
const list = (opts = {}) =>
  call(routes.ws.GET, "/api/workspaces/default/budgets", { params: { id: "default" }, ...opts });
const wsBudget = { scopeType: "workspace", scopeId: "default", window: "day", limitRequests: 5 };

beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("pristine install, switch off", () => {
  it("legacy session: GET before any budget, then workspace + key budgets on the pending Default", async () => {
    await load();
    const cookie = await legacyCookie();
    const empty = await list({ cookie });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ budgets: [], workspaceId: null });
    expect(adapter.get(`SELECT COUNT(*) AS c FROM workspaces`).c).toBe(0); // GET creates nothing

    const ws = await post(wsBudget, { cookie });
    expect(ws.status).toBe(201);
    const pending = adapter.get(
      `SELECT value FROM _meta WHERE key = 'pendingDefaultWorkspaceId'`,
    ).value;
    expect((await ws.json()).budget).toMatchObject({ scopeType: "workspace", scopeId: pending });
    expect(adapter.get(`SELECT value FROM _meta WHERE key = 'defaultWorkspaceId'`)).toBeUndefined();

    const key = await post(
      { scopeType: "key", scopeId: "legacy-key", window: "day", limitRequests: 3 },
      { cookie },
    );
    expect(key.status).toBe(201);
    // An unknown key id is invisible.
    expect(
      (await post({ scopeType: "key", scopeId: "nope", window: "day", limitUsd: 1 }, { cookie }))
        .status,
    ).toBe(404);

    const got = await list({ cookie });
    const body = await got.json();
    expect(body.workspaceId).toBe(pending);
    expect(body.budgets.map((b) => b.scopeType).sort()).toEqual(["key", "workspace"]);
    // The resolved id addresses the same workspace; any other id is 404.
    const byId = await call(routes.ws.GET, `/api/workspaces/${pending}/budgets`, {
      params: { id: pending },
      cookie,
    });
    expect((await byId.json()).budgets).toHaveLength(2);
    expect(
      (
        await call(routes.ws.GET, "/api/workspaces/other/budgets", {
          params: { id: "other" },
          cookie,
        })
      ).status,
    ).toBe(404);

    // No user row: creator and audit actor stay NULL.
    expect(adapter.all(`SELECT createdByUserId FROM budgets`)).toEqual([
      { createdByUserId: null },
      { createdByUserId: null },
    ]);
    const audits = adapter.all(
      `SELECT actorUserId, via, workspaceId FROM auditEvents WHERE action = 'budget.create'`,
    );
    expect(audits).toEqual([
      { actorUserId: null, via: "session", workspaceId: pending },
      { actorUserId: null, via: "session", workspaceId: pending },
    ]);
  });

  it("PATCH and DELETE via the alias", async () => {
    await load();
    const cookie = await legacyCookie();
    const { budget } = await (await post(wsBudget, { cookie })).json();
    const params = { id: "default", budgetId: budget.id };
    const url = `/api/workspaces/default/budgets/${budget.id}`;
    const patched = await call(routes.wsOne.PATCH, url, {
      method: "PATCH",
      body: { limitRequests: 9 },
      params,
      cookie,
    });
    expect(patched.status).toBe(200);
    expect((await patched.json()).budget.limitRequests).toBe(9);
    expect(
      (await call(routes.wsOne.DELETE, url, { method: "DELETE", params, cookie })).status,
    ).toBe(200);
    expect(adapter.get(`SELECT COUNT(*) AS c FROM budgets`).c).toBe(0);
  });

  it("user, membership and grant scopes: 400 scope_unavailable, nothing created", async () => {
    await load();
    const cookie = await legacyCookie();
    for (const scopeType of ["user", "membership", "grant"]) {
      const res = await post({ scopeType, scopeId: "x", window: "day", limitUsd: 1 }, { cookie });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "This budget scope needs Users & teams",
        code: "scope_unavailable",
      });
    }
    expect(adapter.get(`SELECT COUNT(*) AS c FROM budgets`).c).toBe(0);
    expect(adapter.get(`SELECT COUNT(*) AS c FROM workspaces`).c).toBe(0);
  });

  it("user budget routes stay 404", async () => {
    await load();
    const res = await call(routes.user.GET, "/api/users/x/budgets", {
      params: { id: "x" },
      cookie: await legacyCookie(),
    });
    expect(res.status).toBe(404);
  });

  it("gateway credentials and missing sessions are 401; login off admits local access", async () => {
    await load();
    const cookie = await legacyCookie();
    expect((await post(wsBudget, { cookie, bearer: "sk-pristine-raw-0123456789" })).status).toBe(
      401,
    );
    expect((await post(wsBudget)).status).toBe(401);
    expect((await list()).status).toBe(401);

    await load({ requireLogin: false });
    expect((await post(wsBudget, { bearer: "sk-pristine-raw-0123456789" })).status).toBe(401);
    const local = await post(wsBudget);
    expect(local.status).toBe(201);
    expect(
      adapter.get(`SELECT actorUserId, via FROM auditEvents WHERE action = 'budget.create'`),
    ).toEqual({ actorUserId: null, via: "local" });
  });

  it("the switch response does not count the pending Default as a shared workspace", async () => {
    await load();
    expect((await post(wsBudget, { cookie: await legacyCookie() })).status).toBe(201);
    const { multiUserSwitchResponse } = await import("@/app/api/settings/multiUserSwitchPatch.js");
    expect((await multiUserSwitchResponse()).sharedWorkspaces).toBe(0);
  });

  it("the switch turning on after the gate: the write transaction refuses (403)", async () => {
    await load({ env: null }); // stored setting decides
    const cookie = await legacyCookie();
    const setStored = (on) =>
      adapter.run(
        `UPDATE settings SET data = json_set(data, '$.multiUserEnabled', json(?)) WHERE id = 1`,
        [String(on)],
      );
    const tx = adapter.transaction.bind(adapter);
    const spy = vi.spyOn(adapter, "transaction").mockImplementationOnce((fn) => {
      setStored(true); // flip between the gate/assertActor and the transaction
      return tx(fn);
    });
    try {
      const res = await post(wsBudget, { cookie });
      expect(res.status).toBe(403);
      expect(adapter.get(`SELECT COUNT(*) AS c FROM budgets`).c).toBe(0);
      expect(adapter.get(`SELECT COUNT(*) AS c FROM workspaces`).c).toBe(0);
    } finally {
      spy.mockRestore();
      setStored(false);
    }
  });
});
