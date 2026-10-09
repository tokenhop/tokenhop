// YAN-372 budget routes on the YAN-354 harness: switch-off 404, manager may
// create/lower but not raise or delete (ADR-0007), admin may, cross-workspace
// 404, duplicate scope+window 409, user-level budgets admin only, audit rows.
import { afterAll, describe, expect, it, vi } from "vitest";
import { callRoute, seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];

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
let t;
let mgr;
let routes;

async function load(state) {
  vi.resetModules();
  process.env[ENV] = state;
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  for (const tbl of ["budgets", "auditEvents", "usageHistory"]) adapter.run(`DELETE FROM ${tbl}`);
  routes = {
    ws: await import("@/app/api/workspaces/[id]/budgets/route.js"),
    wsOne: await import("@/app/api/workspaces/[id]/budgets/[budgetId]/route.js"),
    user: await import("@/app/api/users/[id]/budgets/route.js"),
  };
  t = await seedTenancy();
  // C: plain instance user, manager of Shared (not an admin).
  const db = await import("@/lib/db/index.js");
  const uc = await db.createUserUnscoped({ email: "c@tenancy.test", instanceRole: "user" });
  await db.addMembership(t.a.ctx, t.shared.id, { userId: uc.id, role: "manager" });
  mgr = { user: uc, ctx: { ...t.b.ctx, userId: uc.id, activeWorkspaceId: uc.personalWorkspaceId } };
}

async function as(seeded, handler, url, opts = {}) {
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  jar.cookie = `auth_token=${await createDashboardAuthToken({
    sub: seeded.user.id,
    sv: seeded.user.sessionVersion,
    wid: seeded.ctx.activeWorkspaceId,
  })}`;
  try {
    return await callRoute(handler, url, { as: seeded, ...opts });
  } finally {
    jar.cookie = "";
  }
}

const create = (who, ws, body) =>
  as(who, routes.ws.POST, `/api/workspaces/${ws}/budgets`, {
    method: "POST",
    body,
    params: { id: ws },
  });
const patch = (who, ws, id, body) =>
  as(who, routes.wsOne.PATCH, `/api/workspaces/${ws}/budgets/${id}`, {
    method: "PATCH",
    body,
    params: { id: ws, budgetId: id },
  });
const del = (who, ws, id) =>
  as(who, routes.wsOne.DELETE, `/api/workspaces/${ws}/budgets/${id}`, {
    method: "DELETE",
    params: { id: ws, budgetId: id },
  });
const wsBudget = (ws, extra = {}) => ({
  scopeType: "workspace",
  scopeId: ws,
  window: "month",
  limitUsd: 50,
  ...extra,
});

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("budget routes, switch off", () => {
  it("hides every route (404)", async () => {
    await load("off");
    const params = { id: "x", budgetId: "b" };
    for (const [h, url] of [
      [routes.ws.GET, "/api/workspaces/x/budgets"],
      [routes.wsOne.DELETE, "/api/workspaces/x/budgets/b"],
      [routes.user.GET, "/api/users/x/budgets"],
    ]) {
      expect((await callRoute(h, url, { params })).status).toBe(404);
    }
  });
});

describe("budget routes, switch on", () => {
  it("manager creates and lowers; raise and delete need an instance admin", async () => {
    await load("on");
    const ws = t.shared.id;
    const res = await create(mgr, ws, wsBudget(ws, { softLimitPct: 80 }));
    expect(res.status).toBe(201);
    const { budget } = await res.json();
    expect(budget).toMatchObject({ scopeType: "workspace", window: "month", limitUsd: 50 });
    expect(budget.resetAt).toMatch(/T00:00:00\.000Z$/);
    expect(budget).not.toHaveProperty("createdByUserId");

    expect((await patch(mgr, ws, budget.id, { limitUsd: 40 })).status).toBe(200);
    expect((await patch(mgr, ws, budget.id, { limitUsd: 60 })).status).toBe(403);
    // Removing a limit (NULL = unlimited) is a raise too.
    expect((await patch(mgr, ws, budget.id, { limitTokens: 10 })).status).toBe(200);
    expect((await patch(mgr, ws, budget.id, { limitTokens: null })).status).toBe(403);
    expect((await del(mgr, ws, budget.id)).status).toBe(403);
    expect((await patch(t.a, ws, budget.id, { limitUsd: 60 })).status).toBe(200);
    expect((await del(t.a, ws, budget.id)).status).toBe(200);

    const actions = adapter
      .all(`SELECT action, after FROM auditEvents WHERE action LIKE 'budget.%' ORDER BY rowid`)
      .map((r) => r.action);
    expect(actions).toEqual([
      "budget.create",
      "budget.update",
      "budget.update",
      "budget.update",
      "budget.delete",
    ]);
    const first = adapter.get(`SELECT after FROM auditEvents WHERE action = 'budget.create'`);
    expect(JSON.parse(first.after)).toMatchObject({ scopeType: "workspace", limitUsd: 50 });
  });

  it("member cannot create; non-member gets 404; foreign budget ids are invisible", async () => {
    await load("on");
    const ws = t.shared.id;
    expect((await create(t.b, ws, wsBudget(ws))).status).toBe(403);
    // B is not a member of A's personal workspace.
    expect((await create(t.b, t.a.personal, wsBudget(t.a.personal))).status).toBe(404);
    const { budget } = await (await create(t.a, ws, wsBudget(ws))).json();
    // Same id addressed through another workspace: 404, never a leak.
    expect((await patch(t.b, t.b.personal, budget.id, { limitUsd: 1 })).status).toBe(404);
    const list = await as(t.b, routes.ws.GET, `/api/workspaces/${ws}/budgets`, {
      params: { id: ws },
    });
    expect(list.status).toBe(200); // viewer+ reads
  });

  it("rejects bad input, a mismatched scope and a duplicate scope+window", async () => {
    await load("on");
    const ws = t.shared.id;
    expect((await create(t.a, ws, wsBudget(ws, { limitUsd: -1 }))).status).toBe(400);
    expect((await create(t.a, ws, wsBudget(ws, { limitUsd: null }))).status).toBe(400);
    expect((await create(t.a, ws, wsBudget(ws, { extra: 1 }))).status).toBe(400);
    expect((await create(t.a, ws, wsBudget(t.a.personal))).status).toBe(404);
    expect((await create(t.a, ws, wsBudget(ws))).status).toBe(201);
    expect((await create(t.a, ws, wsBudget(ws))).status).toBe(409);
  });

  it("user-level budgets are instance-admin only", async () => {
    await load("on");
    const url = `/api/users/${t.b.user.id}/budgets`;
    const body = { window: "day", limitTokens: 1000 };
    const params = { id: t.b.user.id };
    expect((await as(mgr, routes.user.POST, url, { method: "POST", body, params })).status).toBe(
      403,
    );
    expect((await as(t.a, routes.user.POST, url, { method: "POST", body, params })).status).toBe(
      201,
    );
  });

  it("GET appends settled spent per scope; notional subset; window/status filtering; foreign workspace denied", async () => {
    await load("on");
    const ws = t.shared.id;
    const ins = (id, scopeType, scopeId) =>
      adapter.run(
        `INSERT INTO budgets(id, workspaceId, scopeType, scopeId, window, limitUsd, limitTokens, limitRequests, softLimitPct, resetAt, createdByUserId, createdAt)
         VALUES(?, ?, ?, ?, 'month', 100, NULL, NULL, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z')`,
        [id, scopeType === "user" ? null : ws, scopeType, scopeId],
      );
    ins("bk", "key", "k1");
    ins("bu", "user", t.b.user.id);
    ins("bm", "membership", `${ws}:${t.b.user.id}`);
    ins("bw", "workspace", ws);
    ins("bg", "grant", "g1");
    const uh = (e) =>
      adapter.run(
        `INSERT INTO usageHistory(timestamp, provider, promptTokens, completionTokens, cost, status, meta, workspaceId, userId, apiKeyId, grantId)
         VALUES(?, 'openai', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          e.ts ?? "2026-01-05T10:00:00.000Z",
          e.tok ?? 10,
          5,
          e.cost ?? 1,
          e.status ?? "success",
          e.meta ? JSON.stringify(e.meta) : null,
          e.ws ?? null,
          e.uid ?? null,
          e.key ?? null,
          e.grant ?? null,
        ],
      );
    uh({ key: "k1", ws, cost: 1, meta: { notional: true } });
    uh({ uid: t.b.user.id, ws: t.b.personal, cost: 2 }); // user-level only
    uh({ ws, uid: t.b.user.id, cost: 3 });
    uh({ ws, cost: 4 });
    uh({ grant: "g1", cost: 5 });
    uh({ ws, cost: 6, status: null }); // legacy NULL status still settled
    uh({ ws: t.b.personal, cost: 100 }); // foreign workspace
    uh({ ws, cost: 50, status: "error" }); // failed: never counted
    uh({ ws, cost: 50, ts: "2025-12-05T10:00:00.000Z" }); // prior window
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-01-09T12:00:00Z"));
      const res = await as(t.a, routes.ws.GET, `/api/workspaces/${ws}/budgets`, {
        params: { id: ws },
      });
      expect(res.status).toBe(200);
      const byScope = Object.fromEntries((await res.json()).budgets.map((b) => [b.scopeType, b]));
      expect(byScope.key.spent).toEqual({ usd: 1, tokens: 15, requests: 1, notionalUsd: 1 });
      expect(byScope.user).toBeUndefined(); // user-level rows live on the user route
      expect(byScope.membership.spent).toEqual({ usd: 3, tokens: 15, requests: 1, notionalUsd: 0 });
      expect(byScope.workspace.spent).toEqual({ usd: 14, tokens: 60, requests: 4, notionalUsd: 1 });
      expect(byScope.grant.spent).toEqual({ usd: 5, tokens: 15, requests: 1, notionalUsd: 0 });
      expect(JSON.stringify(byScope)).not.toContain("@tenancy.test"); // no raw user emails
      // Non-member GET on a foreign workspace: 404, never a leak.
      expect(
        (
          await as(t.b, routes.ws.GET, `/api/workspaces/${t.a.personal}/budgets`, {
            params: { id: t.a.personal },
          })
        ).status,
      ).toBe(404);
      // User-level spent via the admin user route.
      const userRes = await as(t.a, routes.user.GET, `/api/users/${t.b.user.id}/budgets`, {
        params: { id: t.b.user.id },
      });
      expect(userRes.status).toBe(200);
      expect((await userRes.json()).budgets[0].spent).toEqual({
        usd: 5,
        tokens: 30,
        requests: 2,
        notionalUsd: 0,
      }); // user scope spans workspaces
    } finally {
      vi.useRealTimers();
    }
  });
});
