// YAN-378: real dashboard handlers, real sessions, isolated A/B/shared DB.
import crypto from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute, seedTenancy } from "../setup/tenancyHarness.js";

const savedEnv = process.env.TOKENHOP_MULTI_USER;
const MASTER = crypto.randomBytes(32);
const jar = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name) => (name === "auth_token" && jar.cookie ? { value: jar.cookie } : undefined),
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(jar.cookie ? { cookie: `auth_token=${jar.cookie}` } : {}),
}));

let db;
let adapter;
let t;
let rows;
let upstream;
const tables = [
  "connectionGrants",
  "providerConnections",
  "providerNodes",
  "combos",
  "apiKeys",
  "budgets",
  "usageHistory",
  "usageRollup",
  "requestDetails",
  "workspaceSettings",
  "kv",
];
// Zero resource mutation permits only the required auth.denied audit append.
const auditRows = () => adapter.all("SELECT * FROM auditEvents ORDER BY rowid");
const snapshot = () =>
  Object.fromEntries(
    [...tables, "users", "workspaces", "memberships"].map((table) => [
      table,
      adapter.all(`SELECT * FROM ${table} ORDER BY rowid`),
    ]),
  );
const conn = (name) => ({ provider: "openai", authType: "apikey", name, apiKey: `sk-${name}` });

async function as(who, handler, url, opts = {}) {
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  jar.cookie = await createDashboardAuthToken({
    sub: who.user.id,
    sv: who.user.sessionVersion,
    wid: who.personal,
  });
  try {
    return await callRoute(handler, url, { as: who, ...opts });
  } finally {
    jar.cookie = "";
  }
}

// Literal specifiers: Vite cannot resolve bracketed dynamic-import variables.
const ROUTES = {
  providers: () => import("@/app/api/providers/route.js"),
  "providers/[id]": () => import("@/app/api/providers/[id]/route.js"),
  "providers/[id]/test": () => import("@/app/api/providers/[id]/test/route.js"),
  "providers/[id]/grants": () => import("@/app/api/providers/[id]/grants/route.js"),
  "providers/[id]/grants/[grantId]": () =>
    import("@/app/api/providers/[id]/grants/[grantId]/route.js"),
  "provider-nodes": () => import("@/app/api/provider-nodes/route.js"),
  "provider-nodes/[id]": () => import("@/app/api/provider-nodes/[id]/route.js"),
  combos: () => import("@/app/api/combos/route.js"),
  "combos/[id]": () => import("@/app/api/combos/[id]/route.js"),
  "combos/[id]/test": () => import("@/app/api/combos/[id]/test/route.js"),
  "combos/[id]/headroom": () => import("@/app/api/combos/[id]/headroom/route.js"),
  keys: () => import("@/app/api/keys/route.js"),
  "keys/[id]": () => import("@/app/api/keys/[id]/route.js"),
  models: () => import("@/app/api/models/route.js"),
  "models/alias": () => import("@/app/api/models/alias/route.js"),
  "models/custom": () => import("@/app/api/models/custom/route.js"),
  "models/disabled": () => import("@/app/api/models/disabled/route.js"),
  "usage/stats": () => import("@/app/api/usage/stats/route.js"),
  "usage/logs": () => import("@/app/api/usage/logs/route.js"),
  "usage/request-details": () => import("@/app/api/usage/request-details/route.js"),
  "usage/[connectionId]": () => import("@/app/api/usage/[connectionId]/route.js"),
  "usage/[connectionId]/codex-reset-credits": () =>
    import("@/app/api/usage/[connectionId]/codex-reset-credits/route.js"),
  audit: () => import("@/app/api/audit/route.js"),
  grants: () => import("@/app/api/grants/route.js"),
  "workspaces/[id]": () => import("@/app/api/workspaces/[id]/route.js"),
  "workspaces/[id]/settings": () => import("@/app/api/workspaces/[id]/settings/route.js"),
  "workspaces/[id]/budgets": () => import("@/app/api/workspaces/[id]/budgets/route.js"),
  "workspaces/[id]/budgets/[budgetId]": () =>
    import("@/app/api/workspaces/[id]/budgets/[budgetId]/route.js"),
  "workspaces/[id]/move": () => import("@/app/api/workspaces/[id]/move/route.js"),
};

// Exact status/body equality is stronger than matching error shape. Denials
// must occur before any persistence or upstream work. No principal mocking.
async function sameDenial(route, method, foreign, missing, status = 404) {
  const handler = (await ROUTES[route]())[method];
  const before = { ...snapshot(), audit: auditRows() };
  const results = [];
  for (const spec of [foreign, missing]) {
    const response = await as(t.b, handler, spec.url, { method, ...spec });
    results.push([response.status, await response.json()]);
    expect(response.status, `${method} ${spec.url}`).toBe(status);
  }
  expect(results[0]).toEqual(results[1]);
  expect(JSON.stringify(results[0])).not.toMatch(/A-private|a-private-model|a-private-body/);
  const after = snapshot();
  // Only auth.denied audit rows may differ.
  expect({ ...after, audit: undefined }).toEqual({ ...before, audit: undefined });
  for (const row of after.audit ?? []) expect(row.action).toBe("auth.denied");
  expect(upstream).not.toHaveBeenCalled();
}

beforeEach(async () => {
  vi.resetModules();
  process.env.TOKENHOP_MULTI_USER = "on";
  db = await import("@/lib/db/index.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  for (const table of [...tables, "auditEvents"]) adapter.run(`DELETE FROM ${table}`);
  adapter.run("DELETE FROM _meta WHERE key IN ('apiKeysHashedVersion','apiKeysHashKid')");
  t = await seedTenancy();
  await db.updateSettings({ requireLogin: true });
  rows = {};
  for (const [tag, who] of [
    ["a", t.a],
    ["b", t.b],
  ]) {
    rows[`${tag}Conn`] = await db.createConnection(
      who.ctx,
      who.personal,
      conn(`${tag.toUpperCase()}-private-connection`),
    );
    rows[`${tag}Combo`] = await db.createCombo(who.ctx, who.personal, {
      name: `${tag.toUpperCase()}-private-combo`,
      models: ["openai/gpt-4o"],
    });
    rows[`${tag}Node`] = await db.createNode(who.ctx, who.personal, {
      id: `openai-compatible-${tag}`,
      type: "openai-compatible",
      name: `${tag.toUpperCase()}-private-node`,
      prefix: tag,
      baseUrl: "https://upstream.invalid/v1",
      apiType: "chat",
    });
    await db.setModelAlias(who.ctx, who.personal, `${tag}-private-alias`, "openai/gpt-4o");
    await db.addCustomModel(who.ctx, who.personal, {
      providerAlias: "openai",
      id: `${tag}-private-model`,
      type: "llm",
      name: `${tag.toUpperCase()}-private-model`,
    });
    await db.disableModels(who.ctx, who.personal, "openai", [`${tag}-private-model`]);
  }
  // Same hashed fixture contract as gateway-key-routes: exercise metadata
  // management, not key activation/migration (covered by dedicated tests).
  adapter.exec("DROP TABLE apiKeys");
  adapter.exec(`CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    userId TEXT REFERENCES users(id) ON DELETE CASCADE, createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL,
    keyHash TEXT UNIQUE NOT NULL, hashKid TEXT NOT NULL, prefix TEXT NOT NULL, name TEXT,
    machineId TEXT, legacy INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
    revokedAt TEXT, allowedModels TEXT NOT NULL DEFAULT '[]', allowedCombos TEXT NOT NULL DEFAULT '[]',
    expiresAt TEXT, lastUsedAt TEXT, createdAt TEXT NOT NULL)`);
  const { masterKeyId } = await import("@/lib/security/masterKey.js");
  process.env.TOKENHOP_MASTER_KEY = MASTER.toString("base64");
  adapter.run(
    "INSERT INTO _meta(key, value) VALUES ('apiKeysHashedVersion','1'), ('apiKeysHashKid', ?)",
    [masterKeyId(MASTER)],
  );
  for (const [tag, who] of [
    ["a", t.a],
    ["b", t.b],
  ]) {
    adapter.run(
      `INSERT INTO apiKeys(id,workspaceId,userId,createdByUserId,keyHash,hashKid,prefix,name,createdAt)
      VALUES(?, ?, ?, ?, ?, ?, 'sk-test', ?, ?)`,
      [
        `${tag}-key`,
        who.personal,
        who.user.id,
        who.user.id,
        tag.repeat(64),
        masterKeyId(MASTER),
        `${tag.toUpperCase()}-private-key`,
        new Date().toISOString(),
      ],
    );
    adapter.run(
      `INSERT INTO requestDetails(id,timestamp,provider,model,status,data,workspaceId,userId,apiKeyId)
      VALUES(?, ?, 'openai', ?, 'ok', ?, ?, ?, ?)`,
      [
        `${tag}-detail`,
        new Date().toISOString(),
        `${tag}-private-model`,
        JSON.stringify({ id: `${tag}-detail`, request: { secret: `${tag}-private-body` } }),
        who.personal,
        who.user.id,
        `${tag}-key`,
      ],
    );
    const { saveRequestUsageUnscoped } = await import("@/lib/usageDb.js");
    await saveRequestUsageUnscoped({
      provider: "openai",
      model: `${tag}-private-model`,
      endpoint: "/v1/chat",
      apiKeyId: `${tag}-key`,
      workspaceId: who.personal,
      userId: who.user.id,
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      timestamp: new Date().toISOString(),
      status: "success",
    });
    await db.auditRepo.insert({
      action: "connection.create",
      result: "success",
      actorUserId: who.user.id,
      workspaceId: who.personal,
      targetType: "connection",
      targetId: rows[`${tag}Conn`].id,
    });
  }
  const { createBudget } = await import("@/lib/db/repos/budgetsRepo.js");
  rows.budget = await createBudget(t.a.ctx, {
    workspaceId: t.a.personal,
    scopeType: "workspace",
    scopeId: t.a.personal,
    window: "day",
    limitUsd: 10,
  });
  // Incoming grants belong only to A, not B or their shared workspace.
  adapter.run(
    `INSERT INTO connectionGrants(id,connectionId,userId,createdByUserId,createdAt)
    VALUES('a-grant', ?, ?, ?, ?)`,
    [rows.aConn.id, t.a.user.id, t.a.user.id, Date.now()],
  );
  upstream = vi.fn(() => {
    throw new Error("Unexpected upstream call");
  });
  vi.stubGlobal("fetch", upstream);
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  delete process.env.TOKENHOP_MASTER_KEY;
  if (savedEnv === undefined) delete process.env.TOKENHOP_MULTI_USER;
  else process.env.TOKENHOP_MULTI_USER = savedEnv;
});

describe("dashboard IDOR denials", () => {
  it("connection, node, combo and key path ids match nonexistent ids on reads/writes/probes", async () => {
    const items = [
      ["providers/[id]", "providers", rows.aConn.id, ["GET", "PUT", "DELETE"]],
      ["provider-nodes/[id]", "provider-nodes", rows.aNode.id, ["PUT", "DELETE"]],
      ["combos/[id]", "combos", rows.aCombo.id, ["GET", "PUT", "DELETE"]],
      ["keys/[id]", "keys", "a-key", ["GET", "PUT", "DELETE"]],
    ];
    for (const [route, path, id, methods] of items)
      for (const method of methods) {
        const spec = (target) => ({
          url: `/api/${path}/${target}?workspaceId=${t.b.personal}`,
          params: { id: target },
          ...(method === "PUT" ? { body: { name: "hijacked" } } : {}),
        });
        await sameDenial(route, method, spec(id), spec("missing-id"));
      }
    for (const [route, path, id, method] of [
      ["providers/[id]/test", "providers", rows.aConn.id, "POST"],
      ["combos/[id]/test", "combos", rows.aCombo.id, "POST"],
      ["combos/[id]/headroom", "combos", rows.aCombo.id, "GET"],
    ]) {
      const spec = (target) => ({ url: `/api/${path}/${target}/test`, params: { id: target } });
      await sameDenial(route, method, spec(id), spec("missing-id"));
    }
    for (const route of ["usage/[connectionId]", "usage/[connectionId]/codex-reset-credits"]) {
      const spec = (target) => ({ url: `/api/usage/${target}`, params: { connectionId: target } });
      await sameDenial(
        route,
        route.endsWith("credits") ? "POST" : "GET",
        spec(rows.aConn.id),
        spec("missing-id"),
      );
    }
  }, 30_000);

  it("foreign workspace query selectors deny collections and model-map writes", async () => {
    const cases = [
      ["providers", "GET"],
      ["combos", "GET"],
      ["provider-nodes", "GET"],
      ["keys", "GET"],
      ["models", "GET"],
      ["models/alias", "GET"],
      ["models/custom", "GET"],
      ["models/disabled", "GET"],
      ["usage/stats", "GET"],
      ["usage/logs", "GET"],
      ["usage/request-details", "GET"],
      ["audit", "GET"],
      ["models/alias", "PUT", { model: "openai/x", alias: "a-private-alias" }],
      ["models", "PUT", { model: "openai/gpt-4o", alias: "hijacked" }],
      ["models/alias", "DELETE"],
      ["models/custom", "POST", { providerAlias: "openai", id: "a-private-model", type: "llm" }],
      ["models/custom", "DELETE"],
      [
        "models/disabled",
        "POST",
        { providerAlias: "openai", ids: ["b-private-model", "a-private-model"] },
      ],
      ["models/disabled", "DELETE"],
      ["keys", "POST", { name: "hijacked", type: "user" }],
      ["keys", "PATCH", { acknowledgeMigration: true }],
    ];
    for (const [route, method, body] of cases) {
      const spec = (workspaceId) => ({
        url: `/api/${route}?workspaceId=${workspaceId}&alias=a-private-alias&providerAlias=openai&id=a-private-model`,
        body,
      });
      await sameDenial(route, method, spec(t.a.personal), spec("missing-workspace"));
    }
    for (const [filter, id] of [
      ["userId", t.a.user.id],
      ["apiKeyId", "a-key"],
    ]) {
      const spec = (target) => ({
        url: `/api/usage/stats?workspaceId=${t.b.personal}&${filter}=${target}`,
      });
      await sameDenial("usage/stats", "GET", spec(id), spec("missing-id"));
    }
  }, 30_000);

  it("budget, settings, grant and workspace move path/body targets remain isolated", async () => {
    for (const [route, method, body, status] of [
      ["workspaces/[id]", "GET", undefined, 403],
      ["workspaces/[id]/settings", "GET"],
      [
        "workspaces/[id]/settings",
        "PATCH",
        { comboStrategyPatch: { id: rows.aCombo.id, strategy: "fallback" } },
      ],
      ["workspaces/[id]/budgets", "GET"],
      [
        "workspaces/[id]/budgets",
        "POST",
        { scopeType: "workspace", scopeId: t.a.personal, window: "day", limitUsd: 1 },
      ],
      // Foreign and missing source both 403: capability gate runs before any lookup.
      [
        "workspaces/[id]/move",
        "POST",
        { targetWorkspaceId: t.b.personal, items: [{ type: "combo", id: rows.aCombo.id }] },
        403,
      ],
    ]) {
      const spec = (id) => ({ url: `/api/workspaces/${id}`, params: { id }, body });
      await sameDenial(route, method, spec(t.a.personal), spec("missing-workspace"), status ?? 404);
    }
    for (const method of ["PATCH", "DELETE"]) {
      const spec = (budgetId) => ({
        url: `/api/workspaces/${t.b.personal}/budgets/${budgetId}`,
        params: { id: t.b.personal, budgetId },
        ...(method === "PATCH" ? { body: { limitUsd: 1 } } : {}),
      });
      await sameDenial(
        "workspaces/[id]/budgets/[budgetId]",
        method,
        spec(rows.budget.id),
        spec("missing-budget"),
      );
    }
    // Valid B workspace path, but A workspace/key ids injected into body scope.
    for (const [scopeType, scopeId] of [
      ["workspace", t.a.personal],
      ["key", "a-key"],
    ]) {
      const spec = (id) => ({
        url: `/api/workspaces/${t.b.personal}/budgets`,
        params: { id: t.b.personal },
        body: { scopeType, scopeId: id, window: "day", limitUsd: 1 },
      });
      await sameDenial("workspaces/[id]/budgets", "POST", spec(scopeId), spec("missing-scope"));
    }
    for (const method of ["GET", "POST"]) {
      const spec = (id) => ({
        url: `/api/providers/${id}/grants`,
        params: { id },
        ...(method === "POST" ? { body: { userId: t.b.user.id } } : {}),
      });
      await sameDenial(
        "providers/[id]/grants",
        method,
        spec(rows.aConn.id),
        spec("missing-connection"),
      );
    }
    const spec = (grantId) => ({
      url: `/api/providers/${rows.bConn.id}/grants/${grantId}`,
      params: { id: rows.bConn.id, grantId },
    });
    await sameDenial(
      "providers/[id]/grants/[grantId]",
      "DELETE",
      spec("a-grant"),
      spec("missing-grant"),
    );
  }, 30_000);

  it("mixed own/foreign move batch is atomic and matches missing-item conflicts", async () => {
    // B must manage both workspaces, otherwise target-role denial masks item checks.
    adapter.run("UPDATE memberships SET role = 'manager' WHERE workspaceId = ? AND userId = ?", [
      t.shared.id,
      t.b.user.id,
    ]);
    const { POST } = await import("@/app/api/workspaces/[id]/move/route.js");
    for (const preview of [true, false]) {
      const before = snapshot();
      const results = [];
      for (const id of [rows.aCombo.id, "missing-combo"]) {
        const response = await as(t.b, POST, `/api/workspaces/${t.b.personal}/move`, {
          method: "POST",
          params: { id: t.b.personal },
          body: {
            targetWorkspaceId: t.shared.id,
            preview,
            items: [
              { type: "combo", id: rows.bCombo.id },
              { type: "combo", id },
            ],
          },
        });
        expect(response.status).toBe(preview ? 200 : 409);
        const result = await response.json();
        expect(result.conflicts).toEqual([
          { type: "combo", id, code: "NOT_FOUND", message: expect.any(String) },
        ]);
        expect(JSON.stringify(result)).not.toContain("A-private-combo");
        // Caller-supplied id echoes are not existence disclosure.
        results.push(JSON.parse(JSON.stringify(result).replaceAll(id, "redacted-id")));
      }
      expect(results[0]).toEqual(results[1]);
      expect(snapshot()).toEqual(before);
      expect(upstream).not.toHaveBeenCalled();
    }
  });

  it("B collection reads contain only B rows and incoming grants never disclose A", async () => {
    for (const [route, field, expected] of [
      ["providers", "connections", [rows.bConn.id]],
      ["provider-nodes", "nodes", [rows.bNode.id]],
      ["combos", "combos", [rows.bCombo.id]],
      ["keys", "keys", ["b-key"]],
      ["usage/request-details", "details", ["b-detail"], "details"],
    ]) {
      const { GET } = await ROUTES[route]();
      const response = await as(t.b, GET, `/api/${route}?workspaceId=${t.b.personal}`);
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload[field].map((row) => row.id)).toEqual(expected);
    }
    for (const route of [
      "models/alias",
      "models/custom",
      "models/disabled",
      "usage/stats",
      "usage/logs",
      "audit",
      "grants",
    ]) {
      const { GET } = await ROUTES[route]();
      const response = await as(t.b, GET, `/api/${route}?workspaceId=${t.b.personal}`);
      expect(response.status).toBe(200);
      const text = JSON.stringify(await response.json());
      expect(text).not.toMatch(/A-private|a-private-model|a-private-alias|a-key|a-grant/);
      expect(text).not.toContain(rows.aConn.id);
      if (route === "grants") expect(text).toBe('{"grants":[]}');
    }
    expect(upstream).not.toHaveBeenCalled();
  }, 30_000);
});
