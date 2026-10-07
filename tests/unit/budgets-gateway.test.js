// YAN-372 gateway budget enforcement (ADR-0007) on the YAN-354 harness:
// per-level blocking with the exact 429 shape, no concurrent overshoot, UTC
// window reset, release on failure/abort, grant budgets only through the
// grant, zero overhead without budgets or with the switch off, and spent
// rebuilt from settled usageHistory rows after a restart.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedTenancy } from "../setup/tenancyHarness.js";

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const NOW = "2026-01-01T00:00:00.000Z";

let db;
let t;
let guard;
let budgets;
let auth;

// wipe=false simulates a process restart: fresh module state, same DB.
async function load(state = "on", { wipe = true } = {}) {
  vi.resetModules();
  process.env[ENV] = state;
  db = await (await import("@/lib/db/driver.js")).getAdapter();
  if (wipe) {
    for (const tbl of ["budgets", "connectionGrants", "usageHistory", "providerConnections"]) {
      db.run(`DELETE FROM ${tbl}`);
    }
    t = await seedTenancy();
  }
  budgets = await import("@/lib/users/budgets.js");
  guard = await import("@/sse/services/budgetGuard.js");
  auth = await import("@/sse/services/auth.js");
}

let seq = 0;
function budget(scopeType, scopeId, limits, { window = "day", workspaceId } = {}) {
  const id = `b${++seq}`;
  db.run(
    `INSERT INTO budgets(id, workspaceId, scopeType, scopeId, window, limitUsd, limitTokens, limitRequests, softLimitPct, resetAt, createdByUserId, createdAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    [
      id,
      scopeType === "user" ? null : (workspaceId ?? t.shared.id),
      scopeType,
      scopeId,
      window,
      limits.usd ?? null,
      limits.tokens ?? null,
      limits.requests ?? null,
      limits.soft ?? null,
      NOW,
    ],
  );
  budgets.bumpBudgetsGeneration();
  return id;
}

const who = (patch = {}) =>
  Object.freeze({
    via: "apiKey",
    workspaceId: t.shared.id,
    userId: t.b.user.id,
    apiKeyId: "key-1",
    ...patch,
  });

// One leaf attempt; `res` is what the upstream would return.
const call = (p, res = () => new Response("ok")) =>
  guard.budgeted(p, { provider: "openai", model: "gpt-x", nonToken: true }, async () => res());

async function usage(p, extra = {}) {
  const { saveRequestUsageUnscoped } = await import("@/lib/usageDb.js");
  await saveRequestUsageUnscoped({
    provider: "openai",
    model: "gpt-x",
    tokens: { prompt_tokens: 10, completion_tokens: 5 },
    cost: 1,
    status: "success",
    // Legacy key storage in the test DB: rows stay keyless (key budgets need
    // hashed storage, where apiKeyId is the principal's id).
    workspaceId: p.workspaceId,
    userId: p.userId,
    ...extra,
  });
}

beforeEach(() => load("on"));
afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("budget levels", () => {
  for (const level of ["key", "user", "membership", "workspace"]) {
    it(`${level} budget blocks with the ADR-0007 429`, async () => {
      const p = who();
      const scopeId = {
        key: p.apiKeyId,
        user: p.userId,
        membership: budgets.membershipScopeId(p.workspaceId, p.userId),
        workspace: p.workspaceId,
      }[level];
      budget(level, scopeId, { requests: 1 });
      const first = await call(p); // body left unread: its reservation is held
      expect(first.status).toBe(200);
      const r = await call(p);
      expect(r.status).toBe(429);
      expect(r.headers.get("Retry-After")).toMatch(/^\d+$/);
      expect((await r.json()).error).toEqual({
        message: expect.stringContaining(`Budget exceeded at ${level} level`),
        type: "insufficient_quota",
        param: null,
        code: "budget_exceeded",
        level,
        window: "day",
      });
      // Another key/user is untouched by a key/user budget.
      if (level === "key") expect((await call(who({ apiKeyId: "key-2" }))).status).toBe(200);
    });
  }

  it("concurrent requests cannot overshoot: N parallel against N-1 → exactly one 429", async () => {
    budget("workspace", t.shared.id, { requests: 4 });
    // Bodies stay unread, so every admitted request keeps its hold.
    const results = await Promise.all(Array.from({ length: 5 }, () => call(who())));
    expect(results.filter((r) => r.status === 429)).toHaveLength(1);
  });

  it("failed attempts and aborted streams release their reservation", async () => {
    budget("workspace", t.shared.id, { requests: 1 });
    const failed = await call(who(), () => new Response("upstream", { status: 502 }));
    expect(failed.status).toBe(502);
    expect((await call(who())).status).toBe(200); // released by the failure
    // A stream cancelled mid-way releases after the grace period.
    await load("on");
    budget("workspace", t.shared.id, { requests: 1 });
    vi.useFakeTimers();
    try {
      const streaming = await call(
        who(),
        () => new Response(new ReadableStream({ pull() {} }), { status: 200 }),
      );
      expect((await call(who())).status).toBe(429); // held while streaming
      await streaming.body.cancel();
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await call(who())).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("thrown attempts release too", async () => {
    budget("workspace", t.shared.id, { requests: 1 });
    await expect(
      call(who(), () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await call(who())).status).toBe(200);
  });
});

describe("settlement", () => {
  it("committed usage counts toward every matching level", async () => {
    budget("membership", budgets.membershipScopeId(t.shared.id, t.b.user.id), { tokens: 20 });
    await usage(who());
    expect((await call(who())).status).toBe(200); // 15 of 20 tokens, non-token request
    await usage(who());
    const r = await call(who());
    expect(r.status).toBe(429);
    expect((await r.json()).error.message).toContain("spent 30 tokens");
    // Another member of the same workspace is unaffected.
    expect((await call(who({ userId: t.a.user.id }))).status).toBe(200);
  });
});

describe("windows and recovery", () => {
  it("a UTC day window resets at midnight UTC", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-03-10T23:59:00Z"));
      budget("workspace", t.shared.id, { requests: 1 });
      await usage(who(), { timestamp: "2026-03-10T23:58:00.000Z" });
      expect((await call(who())).status).toBe(429);
      vi.setSystemTime(new Date("2026-03-11T00:00:01Z"));
      expect((await call(who())).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebuilds spent from settled usage only after a restart", async () => {
    budget("workspace", t.shared.id, { usd: 2 });
    await usage(who());
    await usage(who());
    await usage(who(), { status: "error" }); // failed rows never count
    await load("on", { wipe: false }); // restart: in-memory counters gone
    const r = await call(who());
    expect(r.status).toBe(429);
    expect((await r.json()).error.message).toContain("spent $2.00");
  });
});

describe("grant budgets", () => {
  function conn(id, workspaceId) {
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, priority, isActive, data, createdAt, updatedAt, workspaceId)
       VALUES(?, 'openai', 'apikey', ?, 1, 1, ?, ?, ?, ?)`,
      [id, id, JSON.stringify({ apiKey: `sk-${id}` }), NOW, NOW, workspaceId],
    );
  }
  function grant(id, connectionId, workspaceId) {
    db.run(
      `INSERT INTO connectionGrants(id, connectionId, workspaceId, userId, createdAt) VALUES(?, ?, ?, NULL, ?)`,
      [id, connectionId, workspaceId, Date.now()],
    );
  }

  it("applies only when the request is routed through that grant", async () => {
    conn("src", t.a.personal);
    grant("g1", "src", t.b.personal);
    budget("grant", "g1", { requests: 1 }, { workspaceId: t.a.personal });
    const p = who({ workspaceId: t.b.personal });
    const select = () =>
      guard.budgeted(p, { provider: "openai", model: "gpt-5", nonToken: true }, async () => {
        const c = await auth.getProviderCredentials("openai", null, "gpt-5", { principal: p });
        return c?.budgetLimit ? guard.budgetResponse(c.budgetLimit) : Response.json(c);
      });
    const first = await select();
    expect((await first.json()).grantId).toBe("g1");
    await usage(p, { grantId: "g1" });
    expect((await select()).status).toBe(429);
    // An own connection is preferred and unaffected by the grant's budget.
    conn("own", t.b.personal);
    const own = await select();
    expect((await own.json()).connectionId).toBe("own");
  });
});

describe("zero overhead", () => {
  it("no budgets: passes straight through without a scope", async () => {
    const spy = vi.spyOn(db, "all");
    expect(await call(who())).toBeNull();
    expect(spy.mock.calls.filter(([sql]) => /FROM budgets/.test(sql))).toHaveLength(1);
    await call(who());
    expect(spy.mock.calls.filter(([sql]) => /FROM budgets/.test(sql))).toHaveLength(1); // cached
  });

  it("fails open when budgets or spend can't be read (no 500s)", async () => {
    budget("workspace", t.shared.id, { requests: 0 });
    const all = vi.spyOn(db, "all").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    expect(await call(who())).toBeNull(); // row load failed: pass through
    all.mockRestore();
    const get = vi.spyOn(db, "get").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    expect((await call(who())).status).toBe(200); // spend read failed: unenforced
    get.mockRestore();
    expect((await call(who())).status).toBe(429); // recovers on the next request
  });

  it("switch off or legacy principal: never enforced, even with rows", async () => {
    await load("off");
    budget("workspace", t.shared.id, { requests: 0 });
    expect(await call(who())).toBeNull();
    await load("on");
    budget("workspace", t.shared.id, { requests: 0 });
    expect(await call(null)).toBeNull();
  });
});
