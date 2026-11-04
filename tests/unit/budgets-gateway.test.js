// YAN-372 gateway budget enforcement (ADR-0007) on the YAN-354 harness:
// per-level blocking with the exact 429 shape, no concurrent overshoot, UTC
// window reset, release on failure/abort, grant budgets only through the
// grant, zero overhead without budgets, switch-off levels (YAN-1829: key and
// workspace only), and spent rebuilt from settled usageHistory rows after a
// restart. Pristine switch-off installs: budgets-switch-off.test.js.
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

  it("hedge abort signal releases a pending attempt hold immediately", async () => {
    budget("workspace", t.shared.id, { requests: 1 });
    const ctrl = new AbortController();
    let finish;
    const pending = guard.budgeted(
      who(),
      { provider: "openai", model: "gpt-x", nonToken: true, signal: ctrl.signal },
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect((await call(who())).status).toBe(429);
    ctrl.abort();
    expect((await call(who())).status).toBe(200);
    finish(new Response("cancelled", { status: 499 }));
    expect((await pending).status).toBe(499);
  });

  it("already aborted hedge never dispatches or holds budget", async () => {
    budget("workspace", t.shared.id, { requests: 1 });
    const ctrl = new AbortController();
    ctrl.abort();
    const run = vi.fn(async () => new Response("must not run"));
    const res = await guard.budgeted(who(), { nonToken: true, signal: ctrl.signal }, run);
    expect(res.status).toBe(499);
    expect(res.localError).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect((await call(who())).status).toBe(200);
  });

  it("abort after streaming response releases held budget and cancels upstream", async () => {
    budget("workspace", t.shared.id, { requests: 1 });
    const ctrl = new AbortController();
    const cancelled = vi.fn();
    const res = await guard.budgeted(
      who(),
      { nonToken: true, signal: ctrl.signal },
      async () => new Response(new ReadableStream({ cancel: cancelled })),
    );
    expect((await call(who())).status).toBe(429);
    ctrl.abort();
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalled());
    expect((await call(who())).status).toBe(200);
    await res.body.cancel();
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

describe("cancelled observed spend", () => {
  it("partial cancelled usage counts identically live and after DB rebuild", async () => {
    budget("workspace", t.shared.id, { usd: 2 });
    const first = await call(who());
    await first.body.cancel();
    await usage(who(), { meta: { cancelled: true, partialUsage: true, billedCost: "unknown" } });
    // Force release grace to finish before checking the live counter.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const live = await call(who());
    expect(live.status).toBe(200);
    await live.body.cancel();
    await load("on", { wipe: false });
    expect((await call(who())).status).toBe(200);
    const b = db.get("SELECT * FROM budgets WHERE scopeType = 'workspace'");
    expect(guard.spentFor(db, b).usd).toBe(1);
  });
});

describe("budget notices (YAN-1830, YAN-1832)", () => {
  const audits = (action) =>
    db.all(`SELECT targetId, after FROM auditEvents WHERE action = ? ORDER BY id`, [action]);
  const settle = () => new Promise((r) => setTimeout(r, 20)); // audit() is fire-and-forget
  let notices;
  const listen = () => {
    notices = [];
    const on = (n) => notices.push(n);
    feedEmitter().on("budgetNotice", on);
    return () => feedEmitter().off("budgetNotice", on);
  };
  const feedEmitter = () => global._statsEmitter;

  it("soft: once per window, survives a restart, fires again in the next window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const stop = listen();
    try {
      vi.setSystemTime(new Date("2026-03-10T12:00:00Z"));
      db.run("DELETE FROM auditEvents");
      const id = budget("workspace", t.shared.id, { tokens: 100, soft: 20 });
      await call(who()); // window state built (spent 0)
      await usage(who()); // 15 tokens: below 20%
      await usage(who()); // 30 tokens: crosses
      await usage(who()); // still over: no second notice
      await settle();
      expect(audits("budget.softLimit")).toHaveLength(1);
      expect(JSON.parse(audits("budget.softLimit")[0].after)).toMatchObject({
        level: "workspace",
        spentTokens: 30,
        windowStart: "2026-03-10T00:00:00.000Z",
      });
      expect(notices.map((n) => n.id)).toEqual([`${id}:soft:2026-03-10T00:00:00.000Z`]);

      // Restart: spend rebuilt from history is past the threshold, the durable
      // claim keeps the notice from firing again in this window.
      await load("on", { wipe: false });
      await call(who());
      await usage(who());
      await settle();
      expect(audits("budget.softLimit")).toHaveLength(1);
      expect(notices).toHaveLength(1);

      // Next UTC window: eligible again.
      vi.setSystemTime(new Date("2026-03-11T00:00:05Z"));
      await usage(who(), { timestamp: "2026-03-11T00:00:01.000Z" });
      await usage(who(), { timestamp: "2026-03-11T00:00:02.000Z" });
      await call(who());
      await settle();
      expect(notices.map((n) => n.id)).toEqual([
        `${id}:soft:2026-03-10T00:00:00.000Z`,
        `${id}:soft:2026-03-11T00:00:00.000Z`,
      ]);
      expect(audits("budget.softLimit")).toHaveLength(2);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it("hard: first budget_exceeded 429 per window notifies once, also after a restart", async () => {
    const stop = listen();
    try {
      db.run("DELETE FROM auditEvents");
      const id = budget("workspace", t.shared.id, { requests: 1 });
      await usage(who());
      expect((await call(who())).status).toBe(429);
      expect((await call(who())).status).toBe(429);
      await load("on", { wipe: false });
      expect((await call(who())).status).toBe(429);
      await settle();
      expect(notices.map((n) => [n.budgetId, n.kind])).toEqual([[id, "hard"]]);
      expect(audits("budget.hardStop")).toHaveLength(1);
      expect(audits("budget.hardStop")[0].targetId).toBe(id);
    } finally {
      stop();
    }
  });

  it("changing a limit or softLimitPct in-window re-arms the notice", async () => {
    const stop = listen();
    try {
      const id = budget("workspace", t.shared.id, { tokens: 100, soft: 20 });
      await usage(who());
      await usage(who()); // 30 tokens
      await call(who());
      expect(notices).toHaveLength(1);
      // Same limits after a restart: still claimed.
      await load("on", { wipe: false });
      await call(who());
      expect(notices).toHaveLength(1);
      // Raise the soft % above the spend: nothing to send yet (not crossed).
      db.run("UPDATE budgets SET softLimitPct = 50 WHERE id = ?", [id]);
      budgets.bumpBudgetsGeneration();
      await call(who());
      expect(notices).toHaveLength(1);
      // Lower the limit so 30 tokens is past 50%: re-armed, sends again.
      db.run("UPDATE budgets SET limitTokens = 50 WHERE id = ?", [id]);
      budgets.bumpBudgetsGeneration();
      await call(who());
      expect(notices.map((n) => [n.kind, n.limitTokens, n.softLimitPct])).toEqual([
        ["soft", 100, 20],
        ["soft", 50, 50],
      ]);
      // Restart again with those limits: no repeat.
      await load("on", { wipe: false });
      await call(who());
      expect(notices).toHaveLength(2);
    } finally {
      stop();
    }
  });

  it("a claim write failure fails open: the request passes and the notice still goes out", async () => {
    const stop = listen();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      budget("workspace", t.shared.id, { requests: 0 });
      const run = db.run.bind(db);
      const spy = vi.spyOn(db, "run").mockImplementation((sql, params) => {
        if (/INTO budgetNotices/.test(sql)) throw new Error("database is locked");
        return run(sql, params);
      });
      const r = await call(who());
      spy.mockRestore();
      expect(r.status).toBe(429); // enforcement unaffected
      expect(notices.map((n) => n.kind)).toEqual(["hard"]);
    } finally {
      warn.mockRestore();
      stop();
    }
  });

  it("deleting a budget deletes its claims", async () => {
    const id = budget("workspace", t.shared.id, { requests: 0 });
    expect((await call(who())).status).toBe(429);
    expect(db.get("SELECT COUNT(*) AS c FROM budgetNotices WHERE budgetId = ?", [id]).c).toBe(1);
    db.run("DELETE FROM budgets WHERE id = ?", [id]);
    expect(db.get("SELECT COUNT(*) AS c FROM budgetNotices WHERE budgetId = ?", [id]).c).toBe(0);
  });

  it("a budget deleted mid-request (claim FK fails) sends no notice", async () => {
    const stop = listen();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const id = budget("workspace", t.shared.id, { requests: 1 });
      expect((await call(who())).status).toBe(200); // window cached; its hold stays reserved
      // Deleted without a generation bump: the guard still holds the old row,
      // as in a request racing the delete; the real FK rejects the claim.
      db.run("DELETE FROM budgets WHERE id = ?", [id]);
      expect((await call(who())).status).toBe(429);
      expect(notices).toEqual([]);
      expect(db.get("SELECT COUNT(*) AS c FROM budgetNotices").c).toBe(0);
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining("notice claim failed"),
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
      stop();
    }
  });

  it("switch off: Default workspace notices persist across a restart too", async () => {
    await load("off");
    db.run(`INSERT OR REPLACE INTO _meta(key, value) VALUES('defaultWorkspaceId', ?)`, [
      t.shared.id,
    ]);
    const stop = listen();
    try {
      budget("workspace", t.shared.id, { requests: 0 });
      expect((await call(who())).status).toBe(429);
      await load("off", { wipe: false });
      expect((await call(who())).status).toBe(429);
      expect(notices.map((n) => [n.kind, n.workspaceId])).toEqual([["hard", t.shared.id]]);
    } finally {
      stop();
    }
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

  it("switch off: Default workspace budgets enforce for a principal (ADR-0007 429)", async () => {
    await load("off");
    db.run(`INSERT OR REPLACE INTO _meta(key, value) VALUES('defaultWorkspaceId', ?)`, [
      t.shared.id,
    ]);
    budget("workspace", t.shared.id, { requests: 0 });
    const r = await call(who());
    expect(r.status).toBe(429);
    expect((await r.json()).error).toMatchObject({ code: "budget_exceeded", level: "workspace" });
  });

  it("switch off: user, membership and grant budgets are never enforced", async () => {
    await load("off");
    db.run(`INSERT OR REPLACE INTO _meta(key, value) VALUES('defaultWorkspaceId', ?)`, [
      t.shared.id,
    ]);
    const p = who();
    budget("user", p.userId, { requests: 0 });
    budget("membership", budgets.membershipScopeId(p.workspaceId, p.userId), { requests: 0 });
    budget("grant", "g-off", { requests: 0 });
    expect(await call(p)).toBeNull(); // no off-mode rows: zero-cost pass-through
    // With an off-mode row the request is scoped, yet only that row applies.
    budget("workspace", t.shared.id, { requests: 100 });
    let ctx = "unset";
    const res = await guard.withBudgetScope(p, { nonToken: true }, async () => {
      ctx = guard.grantBudgetContext();
      return new Response("ok");
    });
    expect(res.status).toBe(200);
    expect(ctx).toBeNull();
  });

  it("switch on: a legacy (null) principal is never enforced, even with rows", async () => {
    budget("workspace", t.shared.id, { requests: 0 });
    expect(await call(null)).toBeNull();
  });
});
