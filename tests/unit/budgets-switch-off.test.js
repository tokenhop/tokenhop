// YAN-1829: gateway budgets with the users & teams switch off. Pristine
// installs (legacy key storage, no owner) budget legacy requests on the
// pending Default: workspace and key budgets return the ADR-0007 429 and settle
// on the same subject the usage writer stores. Established installs keep
// their principal. User/membership/grant budgets never apply, the no-budget
// path makes no DB call, and the switch-on legacy path is unchanged.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const NOW = "2026-01-01T00:00:00.000Z";
const RAW_A = "sk-switch-off-key-a-0123456789abcdef";
const RAW_B = "sk-switch-off-key-b-0123456789abcdef";

let db;
let guard;
let budgets;
let ownership;

async function load(state, { pristine = true } = {}) {
  vi.resetModules();
  process.env[ENV] = state;
  db = await (await import("@/lib/db/driver.js")).getAdapter();
  for (const tbl of [
    "budgets",
    "usageHistory",
    "usageRollup",
    "usageBudgetCarry",
    "apiKeys",
    "memberships",
    "identities",
    "workspaces",
    "users",
  ])
    db.run(`DELETE FROM ${tbl}`);
  db.run(
    `DELETE FROM _meta WHERE key IN ('defaultWorkspaceId', 'pendingDefaultWorkspaceId', 'usageAdoptedAt')`,
  );
  for (const [id, raw] of [
    ["key-a", RAW_A],
    ["key-b", RAW_B],
  ])
    db.run("INSERT INTO apiKeys(id, key, name, isActive, createdAt) VALUES(?, ?, ?, 1, ?)", [
      id,
      raw,
      id,
      NOW,
    ]);
  budgets = await import("@/lib/users/budgets.js");
  guard = await import("@/sse/services/budgetGuard.js");
  ownership = await import("@/lib/db/repos/ownership.js");
  return pristine ? null : seedTenancy();
}

let seq = 0;
function budget(scopeType, scopeId, workspaceId, limits) {
  const id = `off-b${++seq}`;
  db.run(
    `INSERT INTO budgets(id, workspaceId, scopeType, scopeId, window, limitUsd, limitTokens, limitRequests, softLimitPct, resetAt, createdByUserId, createdAt)
     VALUES(?, ?, ?, ?, 'day', ?, ?, ?, NULL, NULL, NULL, ?)`,
    [
      id,
      scopeType === "user" ? null : workspaceId,
      scopeType,
      scopeId,
      limits.usd ?? null,
      limits.tokens ?? null,
      limits.requests ?? null,
      NOW,
    ],
  );
  budgets.bumpBudgetsGeneration();
  return id;
}

// One leaf attempt as a legacy (null-principal) or principal request.
const call = (principal, apiKey = null, res = () => new Response("ok")) =>
  guard.budgeted(principal, { provider: "openai", model: "gpt-x", nonToken: true, apiKey }, () =>
    Promise.resolve(res()),
  );

const pendingDefault = () =>
  db.transaction(() => ownership.ensurePendingDefaultWorkspaceUnscoped(db));

async function expect429(res, level) {
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
  expect((await res.json()).error).toEqual({
    message: expect.stringContaining(`Budget exceeded at ${level} level`),
    type: "insufficient_quota",
    param: null,
    code: "budget_exceeded",
    level,
    window: "day",
  });
}

// The adapter survives module reloads: drop spies (and their calls) per test.
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("pristine install, switch off", () => {
  it("the pending Default never sets _meta.defaultWorkspaceId", async () => {
    await load("off");
    const ws = pendingDefault();
    expect(ws).toEqual(expect.any(String));
    expect(db.get(`SELECT value FROM _meta WHERE key = 'defaultWorkspaceId'`)).toBeUndefined();
    expect(ownership.defaultWorkspaceIdUnscoped(db)).toBeNull();
    expect(ownership.pendingDefaultWorkspaceIdUnscoped(db)).toBe(ws);
    expect(db.get(`SELECT kind, createdBy FROM workspaces WHERE id = ?`, [ws])).toEqual({
      kind: "shared",
      createdBy: null,
    });
    expect(db.get(`SELECT COUNT(*) AS c FROM memberships`).c).toBe(0);
    // Idempotent: one pending row.
    expect(pendingDefault()).toBe(ws);
    expect(db.get(`SELECT COUNT(*) AS c FROM workspaces`).c).toBe(1);
  });

  it("workspace budget: legacy requests get the ADR-0007 429", async () => {
    await load("off");
    const ws = pendingDefault();
    budget("workspace", ws, ws, { requests: 1 });
    expect((await call(null, RAW_A)).status).toBe(200); // body unread: hold kept
    await expect429(await call(null, RAW_A), "workspace");
    // Keyless legacy requests are workspace traffic too.
    await expect429(await call(null, null), "workspace");
  });

  it("key budget on apiKeys.id: blocks that key only; keyless is not keyed", async () => {
    await load("off");
    const ws = pendingDefault();
    budget("key", "key-a", ws, { requests: 1 });
    expect((await call(null, RAW_A)).status).toBe(200);
    await expect429(await call(null, RAW_A), "key");
    expect((await call(null, RAW_B)).status).toBe(200);
    expect((await call(null, null)).status).toBe(200);
  });

  it("settles on the pending Default and the legacy key id", async () => {
    await load("off");
    const ws = pendingDefault();
    const id = budget("key", "key-a", ws, { requests: 1 });
    const res = await call(null, RAW_A);
    await res.text(); // consumed: the reservation drops once usage settles
    const { saveRequestUsageUnscoped } = await import("@/lib/usageDb.js");
    await saveRequestUsageUnscoped({
      provider: "openai",
      model: "gpt-x",
      apiKey: RAW_A,
      cost: 1,
      status: "success",
    });
    expect(db.get(`SELECT workspaceId, apiKeyId, userId FROM usageHistory`)).toEqual({
      workspaceId: ws,
      apiKeyId: "key-a",
      userId: null,
    });
    const row = db.get(`SELECT * FROM budgets WHERE id = ?`, [id]);
    expect(guard.spentFor(db, row).requests).toBe(1);
    await expect429(await call(null, RAW_A), "key");
  });

  it("existing ownerless usage joins the pending Default (requestDetails stay NULL)", async () => {
    await load("off");
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, cost, status, apiKeyId) VALUES(?, 'openai', 'gpt-x', 1, 'success', 'key-a')`,
      [new Date().toISOString()],
    );
    db.run(`DELETE FROM requestDetails`);
    db.run(
      `INSERT INTO requestDetails(id, timestamp, provider, model, status, data) VALUES('rd1', ?, 'openai', 'gpt-x', 'ok', '{}')`,
      [NOW],
    );
    const ws = pendingDefault();
    expect(db.get(`SELECT workspaceId FROM usageHistory`).workspaceId).toBe(ws);
    expect(db.get(`SELECT workspaceId FROM requestDetails`).workspaceId).toBeNull();
    budget("workspace", ws, ws, { requests: 1 });
    await expect429(await call(null, RAW_B), "workspace");
  });

  it("no pending Default yet: legacy usage stays ownerless", async () => {
    await load("off");
    const { saveRequestUsageUnscoped } = await import("@/lib/usageDb.js");
    await saveRequestUsageUnscoped({ provider: "openai", model: "gpt-x", apiKey: RAW_A, cost: 1 });
    expect(db.get(`SELECT workspaceId FROM usageHistory`).workspaceId).toBeNull();
  });

  it("user, membership and grant rows are never enforced", async () => {
    await load("off");
    const ws = pendingDefault();
    budget("membership", `${ws}:nobody`, ws, { requests: 0 });
    budget("grant", "g1", ws, { requests: 0 });
    expect(await call(null, RAW_A)).toBeNull();
  });
});

describe("established install, switch off", () => {
  it("key and owner principals hit workspace and key budgets; membership/grant ignored", async () => {
    const t = await load("off", { pristine: false });
    const ws = t.shared.id;
    const key = Object.freeze({
      via: "apiKey",
      workspaceId: ws,
      userId: t.b.user.id,
      apiKeyId: "key-a",
    });
    const owner = Object.freeze({
      via: "local",
      workspaceId: ws,
      userId: t.a.user.id,
      apiKeyId: null,
    });
    budget("membership", budgets.membershipScopeId(ws, t.b.user.id), ws, { requests: 0 });
    budget("user", t.b.user.id, null, { requests: 0 });
    budget("grant", "g1", ws, { requests: 0 });
    budget("key", "key-a", ws, { requests: 1 });
    expect((await call(key)).status).toBe(200);
    await expect429(await call(key), "key");
    expect((await call(owner)).status).toBe(200); // owners carry no key id
    budget("workspace", ws, ws, { requests: 0 });
    await expect429(await call(owner), "workspace");
  });
});

describe("no-budget fast path", () => {
  for (const pristine of [true, false]) {
    it(`${pristine ? "pristine" : "established"}, switch off: zero DB calls per request`, async () => {
      const t = await load("off", { pristine });
      const p = pristine
        ? null
        : Object.freeze({ via: "apiKey", workspaceId: t.shared.id, userId: null, apiKeyId: "k" });
      expect(await call(p, RAW_A)).toBeNull(); // first call loads the (empty) cache
      const all = vi.spyOn(db, "all");
      const get = vi.spyOn(db, "get");
      expect(await call(p, RAW_A)).toBeNull();
      expect(await call(p, RAW_A)).toBeNull();
      expect(all.mock.calls.filter(([sql]) => /FROM budgets/.test(sql))).toHaveLength(0);
      expect(get).not.toHaveBeenCalled();
    });
  }

  it("switch off with only multi-user rows: still zero DB calls", async () => {
    await load("off");
    budget("grant", "g1", pendingDefault(), { requests: 0 });
    expect(await call(null, RAW_A)).toBeNull();
    const get = vi.spyOn(db, "get");
    expect(await call(null, RAW_A)).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("switch on: a legacy request never reads budgets or the pending Default", async () => {
    await load("on");
    budget("workspace", pendingDefault(), ownership.pendingDefaultWorkspaceIdUnscoped(db), {
      requests: 0,
    });
    const all = vi.spyOn(db, "all");
    const get = vi.spyOn(db, "get");
    expect(await call(null, RAW_A)).toBeNull();
    expect(all.mock.calls.filter(([sql]) => /FROM budgets/.test(sql))).toHaveLength(0);
    expect(get.mock.calls.filter(([sql]) => /_meta/.test(sql))).toHaveLength(0);
  });
});
