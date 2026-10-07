// YAN-370: usage readers scoped per workspace/user (plan D1/D10). Switch on:
// member B sees only own rows; B cannot select A's personal workspace (404);
// owner A sees the whole shared workspace; bodies follow canSeeBodies. Switch
// off: every reader stays unscoped (today's behaviour).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute, seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];

// Route handlers resolve the principal via cookies() from next/headers; the
// harness cookie is mirrored into this jar (same shape as scoped-combos.test.js).
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

// One usageHistory + rollup row per (workspace, user, model) via the real writer.
async function writeUsage({ workspaceId, userId, model }) {
  const { saveRequestUsageUnscoped } = await import("@/lib/usageDb.js");
  await saveRequestUsageUnscoped({
    provider: "openai",
    model,
    endpoint: "/v1/chat",
    apiKeyId: null,
    workspaceId,
    userId,
    tokens: { prompt_tokens: 10, completion_tokens: 5 },
    timestamp: new Date().toISOString(),
    status: "success",
  });
}

// One requestDetails row with a real body to redact (the writer is buffered,
// so seed the exact flush output directly).
async function writeDetail(adapter, { id, workspaceId, userId, body }) {
  adapter.run(
    `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data, workspaceId, userId, apiKeyId)
     VALUES(?, ?, 'openai', ?, NULL, 'ok', ?, ?, ?, 'local-no-key')`,
    [
      id,
      new Date().toISOString(),
      id,
      JSON.stringify({ id, request: body, response: body }),
      workspaceId,
      userId,
    ],
  );
}

const adapter = () => import("@/lib/db/driver.js").then((m) => m.getAdapter());

afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("switch on: usage readers follow the caller's scope", () => {
  let statsRoute;
  let logsRoute;
  let detailsRoute;

  beforeEach(async () => {
    await load("on");
    const a = await adapter();
    a.run(`DELETE FROM usageHistory`);
    a.run(`DELETE FROM usageRollup`);
    a.run(`DELETE FROM requestDetails`);
    t = await seedTenancy();
    statsRoute = await import("@/app/api/usage/stats/route.js");
    logsRoute = await import("@/app/api/usage/logs/route.js");
    detailsRoute = await import("@/app/api/usage/request-details/route.js");

    await writeUsage({ workspaceId: t.shared.id, userId: t.a.user.id, model: "model-a" });
    await writeUsage({ workspaceId: t.shared.id, userId: t.b.user.id, model: "model-b" });
    await writeUsage({ workspaceId: t.a.personal, userId: t.a.user.id, model: "model-a-pers" });
    await writeDetail(await adapter(), {
      id: "det-a",
      workspaceId: t.shared.id,
      userId: t.a.user.id,
      body: { secret: "A-body" },
    });
    await writeDetail(await adapter(), {
      id: "det-b",
      workspaceId: t.shared.id,
      userId: t.b.user.id,
      body: { secret: "B-body" },
    });
    await writeDetail(await adapter(), {
      id: "det-a-pers",
      workspaceId: t.a.personal,
      userId: t.a.user.id,
      body: { secret: "A-personal-body" },
    });
  });

  it("member B sees only own shared rows in stats/logs/request-details", async () => {
    const { a, b, shared } = t;
    const ws = `?workspaceId=${shared.id}`;

    const stats = await (await as(b, statsRoute.GET, `/api/usage/stats${ws}&period=24h`)).json();
    expect(stats.totalRequests).toBe(1);
    expect(Object.keys(stats.byModel)).toEqual(["model-b (openai)"]);

    const logs = await (await as(b, logsRoute.GET, `/api/usage/logs${ws}`)).json();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("model-b");

    const details = await (
      await as(b, detailsRoute.GET, `/api/usage/request-details${ws}&pageSize=10`)
    ).json();
    expect(details.details.map((d) => d.id)).toEqual(["det-b"]);
    expect(details.details[0].request).toEqual({ secret: "B-body" }); // own row → bodies
  });

  it("B selecting A's personal workspace gets a 404, never data", async () => {
    const { b, a } = t;
    for (const [route, path] of [
      [statsRoute, `/api/usage/stats?workspaceId=${a.personal}&period=24h`],
      [logsRoute, `/api/usage/logs?workspaceId=${a.personal}`],
      [detailsRoute, `/api/usage/request-details?workspaceId=${a.personal}`],
    ]) {
      expect((await as(b, route.GET, path)).status).toBe(404);
    }
  });

  it("owner A (manager of Shared) sees all shared rows, with bodies", async () => {
    const { a, shared } = t;
    const ws = `?workspaceId=${shared.id}`;

    const stats = await (await as(a, statsRoute.GET, `/api/usage/stats${ws}&period=24h`)).json();
    expect(stats.totalRequests).toBe(2);
    expect(Object.keys(stats.byModel).sort()).toEqual(["model-a (openai)", "model-b (openai)"]);

    const logs = await (await as(a, logsRoute.GET, `/api/usage/logs${ws}`)).json();
    expect(logs).toHaveLength(2);

    const details = await (
      await as(a, detailsRoute.GET, `/api/usage/request-details${ws}&pageSize=10`)
    ).json();
    // canSeeBodies: A owns the workspace, so even B's row keeps its body.
    for (const d of details.details) expect(d.request.secret).toMatch(/-body$/);
  });

  it("canSeeBodies: B is denied A's row, granted own; getRequestDetailById hides A's personal row", async () => {
    const { a, b } = t;
    const { canSeeBodies } = await import("@/lib/usage/scope.js");
    expect(canSeeBodies(b.ctx, { userId: a.user.id, workspaceId: t.shared.id })).toBe(false);
    expect(canSeeBodies(b.ctx, { userId: b.user.id, workspaceId: t.shared.id })).toBe(true);
    // Workspace owner/manager sees members' bodies; an instance owner who is
    // not a manager there gets metadata only (ADR-0002).
    const aManager = { ...a.ctx, workspaceRoles: { [t.shared.id]: "owner" } };
    expect(canSeeBodies(aManager, { userId: b.user.id, workspaceId: t.shared.id })).toBe(true);
    const aOutsider = { ...a.ctx, workspaceRoles: {} };
    expect(canSeeBodies(aOutsider, { userId: b.user.id, workspaceId: t.shared.id })).toBe(false);
    expect(canSeeBodies(null, { userId: b.user.id })).toBe(false); // switch off: always redacted

    const { getRequestDetailById } = await import("@/lib/usageDb.js");
    const scopeForB = { workspaceId: t.shared.id, userId: b.user.id };
    expect(await getRequestDetailById(scopeForB, "det-b")).toMatchObject({ id: "det-b" });
    expect(await getRequestDetailById(scopeForB, "det-a-pers")).toBeNull(); // cross-workspace
    expect(await getRequestDetailById({ workspaceId: t.shared.id }, "det-a-pers")).toBeNull();
  });
});

describe("switch off: usage readers stay unscoped", () => {
  it("stats returns every row regardless of caller", async () => {
    await load("off");
    const a = await adapter();
    a.run(`DELETE FROM usageHistory`);
    a.run(`DELETE FROM usageRollup`);
    a.run(`DELETE FROM requestDetails`);
    t = await seedTenancy();
    const statsRoute = await import("@/app/api/usage/stats/route.js");
    await writeUsage({ workspaceId: t.shared.id, userId: t.a.user.id, model: "model-a" });
    await writeUsage({ workspaceId: t.a.personal, userId: t.a.user.id, model: "model-pers" });

    const stats = await (await as(t.b, statsRoute.GET, "/api/usage/stats?period=24h")).json();
    expect(stats.totalRequests).toBe(2);
    expect(Object.keys(stats.byModel).sort()).toEqual(["model-a (openai)", "model-pers (openai)"]);
  });
});
