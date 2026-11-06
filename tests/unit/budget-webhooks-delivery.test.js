// YAN-1831 budget webhook delivery on the budgets-gateway harness: exactly
// one signed POST per notice and window (soft crossing, first hard 429), none
// after a simulated restart in the same window, again in the next window;
// HMAC verifies; a hanging endpoint adds no latency to gateway calls; retry
// only on retryable failures; deleted/disabled hooks and user budgets send
// nothing; blocked destinations are refused at delivery; logs carry the host
// only.
import { createHmac } from "node:crypto";
import http from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedTenancy } from "../setup/tenancyHarness.js";
import { captureConsole } from "../helpers/secretScan.js";
import { header } from "@/shared/brand/index.js";

// Brand-relative header names (x-tokenhop-* or x-9router-* per CI brand).
const SIGNATURE = header("signature");
const WEBHOOK_ID = header("webhook-id");

// c-ares Resolver stand-in: `dns.a` / `dns.aaaa` are address lists or
// "hang" (never answers).
const dns = vi.hoisted(() => ({ a: ["127.0.0.1"], aaaa: [] }));
vi.mock("node:dns/promises", () => {
  const answer = (v) => (v === "hang" ? new Promise(() => {}) : Promise.resolve(v));
  class Resolver {
    resolve4() {
      return answer(dns.a);
    }
    resolve6() {
      return answer(dns.aaaa);
    }
    cancel() {}
  }
  return { Resolver, lookup: () => Promise.reject(new Error("lookup must not be used")) };
});

const ENV = "TOKENHOP_MULTI_USER";
const savedEnv = process.env[ENV];
const NOW = "2026-01-01T00:00:00.000Z";

let db;
let t;
let guard;
let budgets;
let hook;
let repo;
let secret;

async function load({ wipe = true } = {}) {
  vi.resetModules();
  process.env[ENV] = "on";
  db = await (await import("@/lib/db/driver.js")).getAdapter();
  if (wipe) {
    for (const tbl of ["budgets", "budgetWebhooks", "usageHistory", "auditEvents"]) {
      db.run(`DELETE FROM ${tbl}`);
    }
    t = await seedTenancy();
  }
  budgets = await import("@/lib/users/budgets.js");
  guard = await import("@/sse/services/budgetGuard.js");
  hook = await import("@/sse/services/budgetWebhook.js");
  repo = await import("@/lib/db/repos/budgetWebhooksRepo.js");
  Object.assign(hook.C, {
    delaysMs: [0, 20, 40],
    timeoutMs: 200,
    maxInFlight: 64,
    perWorkspaceInFlight: 2,
    perWorkspaceQueue: 16,
  });
  await (await import("@/lib/db/index.js")).updateSettings({
    budgetWebhookAllowPrivateNetworks: true,
  });
}

// Local endpoint: `replies` is a queue of status codes (or "hang"); default 200.
const servers = [];
async function endpoint(replies = []) {
  const got = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      got.push({ headers: req.headers, body: raw, url: req.url });
      const reply = replies.shift() ?? 200;
      if (reply === "hang") return;
      if (reply === 302) res.writeHead(302, { location: "http://127.0.0.1:1/" });
      else res.statusCode = reply;
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { got, url: `http://hook.test:${server.address().port}/budget?token=pathsecret` };
}

async function saveHook(url, extra = {}) {
  const out = await repo.saveBudgetWebhook(t.a.ctx, { workspaceId: t.shared.id, url, ...extra });
  if (out.secret) secret = out.secret;
  return out;
}

let seq = 0;
function budget(scopeType, scopeId, limits, { window = "day" } = {}) {
  const id = `wb${++seq}`;
  db.run(
    `INSERT INTO budgets(id, workspaceId, scopeType, scopeId, window, limitUsd, limitTokens, limitRequests, softLimitPct, resetAt, createdByUserId, createdAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    [
      id,
      scopeType === "user" ? null : t.shared.id,
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

const who = () =>
  Object.freeze({
    via: "apiKey",
    workspaceId: t.shared.id,
    userId: t.b.user.id,
    apiKeyId: "key-1",
  });
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
    workspaceId: p.workspaceId,
    userId: p.userId,
    ...extra,
  });
}

const settled = () => hook.__test__.settled();

function verify(req) {
  const sig = req.headers[SIGNATURE];
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig);
  expect(m, sig).toBeTruthy();
  const expected = createHmac("sha256", secret).update(`${m[1]}.${req.body}`).digest("hex");
  expect(m[2]).toBe(expected);
  return JSON.parse(req.body);
}

beforeEach(async () => {
  Object.assign(dns, { a: ["127.0.0.1"], aaaa: [] });
  await load();
});
afterEach(async () => {
  vi.useRealTimers();
  await settled();
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise((r) => {
          s.closeAllConnections?.();
          s.close(() => r());
        }),
    ),
  );
});
afterAll(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("once per window crossing, signed", () => {
  it("soft: one POST per window, none after a restart, again next window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-10T12:00:00Z"));
    const ep = await endpoint();
    await saveHook(ep.url);
    const id = budget("workspace", t.shared.id, { tokens: 100, soft: 20 });
    await call(who());
    await usage(who());
    await usage(who()); // crosses 20%
    await usage(who()); // still over
    await settled();
    expect(ep.got).toHaveLength(1);
    const body = verify(ep.got[0]);
    const webhookId = ep.got[0].headers[WEBHOOK_ID];
    expect(webhookId).toMatch(new RegExp(`^${id}:soft:2026-03-10T00:00:00\\.000Z:[0-9a-f]{12}$`));
    expect(ep.got[0].headers["content-type"]).toBe("application/json");
    expect(body).toMatchObject({
      type: "budget.soft_limit",
      id: webhookId,
      budgetId: id,
      workspaceId: t.shared.id,
      scope: { type: "workspace", id: t.shared.id },
      window: "day",
      windowStart: "2026-03-10T00:00:00.000Z",
      limits: { usd: null, tokens: 100, requests: null },
      threshold: { percent: 20 },
    });
    expect(body.spent.tokens).toBe(30);

    await load({ wipe: false }); // restart, same window
    await call(who());
    await usage(who());
    await settled();
    expect(ep.got).toHaveLength(1);

    vi.setSystemTime(new Date("2026-03-11T00:00:05Z"));
    await usage(who(), { timestamp: "2026-03-11T00:00:01.000Z" });
    await usage(who(), { timestamp: "2026-03-11T00:00:02.000Z" });
    await call(who());
    await settled();
    expect(ep.got).toHaveLength(2);
    expect(verify(ep.got[1]).windowStart).toBe("2026-03-11T00:00:00.000Z");
  });

  it("a limit change in the window re-arms the notice with a new webhook id", async () => {
    const ep = await endpoint();
    await saveHook(ep.url);
    const id = budget("workspace", t.shared.id, { tokens: 100, soft: 20 });
    await usage(who());
    await usage(who()); // 30 tokens: past 20 %
    await call(who());
    await settled();
    expect(ep.got).toHaveLength(1);
    // Lower the limit and raise the soft %: 30 of 50 tokens is past 50 %.
    db.run("UPDATE budgets SET limitTokens = 50, softLimitPct = 50 WHERE id = ?", [id]);
    budgets.bumpBudgetsGeneration();
    await call(who());
    await settled();
    expect(ep.got).toHaveLength(2);
    const ids = ep.got.map((r) => r.headers[WEBHOOK_ID]);
    expect(new Set(ids).size).toBe(2);
    expect(ep.got.map((r) => verify(r).id)).toEqual(ids);
    expect(verify(ep.got[1]).limits.tokens).toBe(50);
  });

  it("hard: the first 429 posts once with threshold 100; later 429s do not", async () => {
    const ep = await endpoint();
    await saveHook(ep.url);
    const id = budget("workspace", t.shared.id, { requests: 1 });
    await usage(who());
    expect((await call(who())).status).toBe(429);
    expect((await call(who())).status).toBe(429);
    await settled();
    expect(ep.got).toHaveLength(1);
    expect(verify(ep.got[0])).toMatchObject({
      type: "budget.hard_limit",
      budgetId: id,
      threshold: { percent: 100 },
    });
  });
});

describe("delivery never slows the gateway", () => {
  it("a hanging endpoint adds no latency; each attempt times out", async () => {
    const ep = await endpoint(["hang", "hang", "hang"]);
    await saveHook(ep.url);
    budget("workspace", t.shared.id, { requests: 1 });
    await usage(who());
    expect((await call(who())).status).toBe(429);
    // The gateway answered while the delivery is still pending: nothing was
    // sent yet, so the request never waited on the endpoint.
    expect(ep.got).toHaveLength(0);
    expect(hook.__test__.pending()).toBe(1);
    const cons = captureConsole("warn");
    try {
      await settled();
    } finally {
      cons.restore();
    }
    expect(ep.got).toHaveLength(3);
    expect(cons.lines.filter((l) => l.includes('"reason":"timeout"'))).toHaveLength(3);
    expect(hook.__test__.inFlight()).toBe(0);
  });

  it("a resolver that never answers times out off the request path", async () => {
    const ep = await endpoint();
    await saveHook(ep.url);
    dns.a = "hang";
    dns.aaaa = "hang";
    budget("workspace", t.shared.id, { requests: 1 });
    await usage(who());
    expect((await call(who())).status).toBe(429);
    expect(hook.__test__.pending()).toBe(1);
    const cons = captureConsole("warn");
    try {
      await settled();
    } finally {
      cons.restore();
    }
    expect(ep.got).toHaveLength(0);
    expect(cons.lines.filter((l) => l.includes('"reason":"timeout"'))).toHaveLength(3);
  });
});

describe("concurrency", () => {
  const notice = (workspaceId, n) => ({
    id: `b:${n}:soft:2026-03-10T00:00:00.000Z`,
    kind: "soft",
    budgetId: "b",
    workspaceId,
    scopeType: "workspace",
    scopeId: workspaceId,
    window: "day",
    windowStart: "2026-03-10T00:00:00.000Z",
    spent: { usd: 0, tokens: 0, requests: 0 },
    softLimitPct: 80,
    at: "2026-03-10T12:00:00.000Z",
  });

  it("a hanging workspace cannot hold back another workspace's delivery", async () => {
    // Long enough that every hanging request reaches the server before it aborts.
    Object.assign(hook.C, {
      delaysMs: [0],
      timeoutMs: 1000,
      perWorkspaceInFlight: 2,
      perWorkspaceQueue: 3,
    });
    const slow = await endpoint(Array(6).fill("hang"));
    const fast = await endpoint();
    await saveHook(slow.url);
    const other = t.a.personal;
    await repo.saveBudgetWebhook(t.a.ctx, { workspaceId: other, url: fast.url });
    const cons = captureConsole("warn");
    try {
      for (let n = 0; n < 6; n++) hook.scheduleBudgetWebhook(notice(t.shared.id, n), "sig");
      hook.scheduleBudgetWebhook(notice(other, 0), "sig");
      // 2 running + 3 queued for the slow workspace, the 6th dropped.
      expect(cons.lines.filter((l) => l.includes("workspace delivery queue full"))).toHaveLength(1);
      expect(hook.__test__.pending()).toBe(6);
      await vi.waitFor(() => expect(fast.got).toHaveLength(1));
      expect(slow.got.length).toBeLessThanOrEqual(2);
      await settled();
    } finally {
      cons.restore();
    }
    expect(slow.got).toHaveLength(5);
    expect(hook.__test__.inFlight()).toBe(0);
    expect(hook.__test__.pending()).toBe(0);
  });

  it("the global cap queues instead of dropping", async () => {
    Object.assign(hook.C, { delaysMs: [0], maxInFlight: 1 });
    const ep = await endpoint();
    await saveHook(ep.url);
    hook.scheduleBudgetWebhook(notice(t.shared.id, 0), "sig");
    hook.scheduleBudgetWebhook(notice(t.shared.id, 1), "sig");
    expect(hook.__test__.inFlight()).toBe(1);
    expect(hook.__test__.pending()).toBe(2);
    await settled();
    expect(ep.got).toHaveLength(2);
    expect(hook.__test__.inFlight()).toBe(0);
  });
});

describe("retries and stop conditions", () => {
  const fireHard = async () => {
    budget("workspace", t.shared.id, { requests: 1 });
    await usage(who());
    expect((await call(who())).status).toBe(429);
    await settled();
  };

  it("retries 5xx until success", async () => {
    const ep = await endpoint([500, 503, 200]);
    await saveHook(ep.url);
    await fireHard();
    expect(ep.got).toHaveLength(3);
    expect(new Set(ep.got.map((r) => r.headers[WEBHOOK_ID])).size).toBe(1);
  });

  it("does not retry other 4xx or redirects", async () => {
    const ep = await endpoint([404]);
    await saveHook(ep.url);
    await fireHard();
    expect(ep.got).toHaveLength(1);

    await load();
    const redirect = await endpoint([302]);
    await saveHook(redirect.url);
    await fireHard();
    expect(redirect.got).toHaveLength(1);
  });

  it("stops when the webhook is deleted between attempts", async () => {
    hook.C.delaysMs = [0, 300, 300];
    const ep = await endpoint([500, 500, 500]);
    await saveHook(ep.url);
    budget("workspace", t.shared.id, { requests: 1 });
    await usage(who());
    expect((await call(who())).status).toBe(429);
    await vi.waitFor(() => expect(ep.got).toHaveLength(1));
    await repo.deleteBudgetWebhook(t.a.ctx, { workspaceId: t.shared.id });
    await settled();
    expect(ep.got).toHaveLength(1);
  });

  it("sends nothing for a disabled hook or a user-level budget", async () => {
    const ep = await endpoint();
    await saveHook(ep.url, { enabled: false });
    await fireHard();
    expect(ep.got).toHaveLength(0);

    await load();
    const ep2 = await endpoint();
    await saveHook(ep2.url);
    const p = who();
    budget("user", p.userId, { requests: 1 });
    await usage(p);
    expect((await call(p)).status).toBe(429);
    await settled();
    expect(ep2.got).toHaveLength(0);
  });
});

describe("egress policy at delivery and logging", () => {
  it("refuses blocked records at delivery and logs host only", async () => {
    const ep = await endpoint();
    await saveHook(ep.url);
    dns.a = ["169.254.169.254"];
    const cons = captureConsole("warn", "log", "error");
    try {
      budget("workspace", t.shared.id, { requests: 1 });
      await usage(who());
      expect((await call(who())).status).toBe(429);
      await settled();
    } finally {
      cons.restore();
    }
    expect(ep.got).toHaveLength(0);
    const text = cons.lines.join("\n");
    expect(text).toContain("blocked_destination");
    expect(text).toContain("hook.test");
    expect(text).not.toContain("pathsecret");
    expect(text).not.toContain(secret);
  });

  it("refuses a private record once the opt-in is turned off", async () => {
    const ep = await endpoint();
    // https: the URL itself stays valid without the opt-in, so the refusal
    // comes from the resolved record.
    await saveHook(ep.url.replace("http://", "https://"));
    await (await import("@/lib/db/index.js")).updateSettings({
      budgetWebhookAllowPrivateNetworks: false,
    });
    dns.a = ["10.0.0.5"];
    const cons = captureConsole("warn");
    try {
      budget("workspace", t.shared.id, { requests: 1 });
      await usage(who());
      expect((await call(who())).status).toBe(429);
      await settled();
    } finally {
      cons.restore();
    }
    expect(ep.got).toHaveLength(0);
    expect(cons.lines.filter((l) => l.includes('"reason":"blocked_destination"'))).toHaveLength(1);
  });
});
