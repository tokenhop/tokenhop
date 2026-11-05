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

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup: (...a) => lookupMock(...a) }));

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
  Object.assign(hook.C, { delaysMs: [0, 20, 40], timeoutMs: 200, maxInFlight: 64 });
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
  const sig = req.headers["x-tokenhop-signature"];
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig);
  expect(m, sig).toBeTruthy();
  const expected = createHmac("sha256", secret).update(`${m[1]}.${req.body}`).digest("hex");
  expect(m[2]).toBe(expected);
  return JSON.parse(req.body);
}

beforeEach(async () => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
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
    expect(ep.got[0].headers["x-tokenhop-webhook-id"]).toBe(`${id}:soft:2026-03-10T00:00:00.000Z`);
    expect(ep.got[0].headers["content-type"]).toBe("application/json");
    expect(body).toMatchObject({
      type: "budget.soft_limit",
      id: `${id}:soft:2026-03-10T00:00:00.000Z`,
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
    const started = performance.now();
    expect((await call(who())).status).toBe(429);
    expect(performance.now() - started).toBeLessThan(100);
    expect(hook.__test__.inFlight()).toBe(1);
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
    expect(new Set(ep.got.map((r) => r.headers["x-tokenhop-webhook-id"])).size).toBe(1);
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

  it("drops beyond the in-flight cap with one warning", async () => {
    hook.C.maxInFlight = 0;
    const cons = captureConsole("warn");
    try {
      hook.scheduleBudgetWebhook({ id: "x", workspaceId: t.shared.id, kind: "soft" });
    } finally {
      cons.restore();
    }
    expect(cons.lines.filter((l) => l.includes("too many deliveries"))).toHaveLength(1);
    expect(hook.__test__.inFlight()).toBe(0);
  });
});

describe("egress policy at delivery and logging", () => {
  it("refuses blocked records at delivery and logs host only", async () => {
    const ep = await endpoint();
    await saveHook(ep.url);
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
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
    await saveHook(ep.url);
    await (await import("@/lib/db/index.js")).updateSettings({
      budgetWebhookAllowPrivateNetworks: false,
    });
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
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
    expect(cons.lines.join("\n")).toMatch(/blocked_destination|invalid_url/);
  });
});
