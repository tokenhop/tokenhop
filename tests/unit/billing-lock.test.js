// YAN-1041: credit-exhaustion classifier, account-wide skip, probe outcomes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnectionsUnscoped: vi.fn(),
  updateProviderConnectionUnscoped: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/db/index.js", () => ({
  getEffectivePreferences: vi.fn(async () => ({})),
  mutateBillingLockUnscoped: vi.fn(),
  saveRequestDetailUnscoped: vi.fn(async () => {}),
  getPricingForModel: vi.fn(async () => null),
}));
vi.mock("@/lib/auth/gatewayResources.js", () => ({
  requireGatewayWorkspace: vi.fn(async () => {}),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const fallback = await import("../../open-sse/services/accountFallback.js");
const probe = await import("../../src/shared/services/billingProbe.js");
const { mutateBillingLockUnscoped } = await import("@/lib/db/index.js");
const { markAccountUnavailable, getProviderCredentials } = await import(
  "../../src/sse/services/auth.js"
);

const ANTHROPIC_400 = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "Your credit balance is too low to access the Anthropic API.",
  },
});

// Production routes upstream bodies through parseUpstreamError, which surfaces
// structured codes as a `[code=...]` marker for text-based classification.
async function parsed(status, body) {
  const { parseUpstreamError } = await import("../../open-sse/utils/error.js");
  return (await parseUpstreamError(new Response(JSON.stringify(body), { status }))).message;
}
const openaiBody = (code, type = "insufficient_quota") => ({
  error: { message: "Quota hit", type, code },
});

describe("billing classifier", () => {
  it("flags the Anthropic credit 400 as billing (fall back)", () => {
    expect(fallback.isBillingExhausted(400, ANTHROPIC_400, "anthropic")).toBe(true);
    const r = fallback.checkFallbackError(400, ANTHROPIC_400, 0, null, "anthropic");
    expect(r.shouldFallback).toBe(true);
    expect(r.billing).toBe(true);
  });

  it("claude (OAuth subscription) is not an Anthropic API-key billing provider", () => {
    const text = "Your credit balance is too low to access the Anthropic API.";
    // Behavior identical to before the feature for claude: an unmatched 400 does
    // not fall back and nothing is classified as billing.
    expect(fallback.isBillingExhausted(400, text, "claude")).toBe(false);
    expect(fallback.checkFallbackError(400, text, 0, null, "claude")).toEqual({
      shouldFallback: false,
      cooldownMs: 0,
    });
    // anthropic (real API-key endpoint) and provider-less callers still classify.
    expect(fallback.isBillingExhausted(400, text, "anthropic")).toBe(true);
    expect(fallback.isBillingExhausted(400, text, null)).toBe(true);
    // Subscription extra-usage rule is a text rule and is unaffected for claude.
    expect(
      fallback.checkFallbackError(400, "You're out of extra usage", 0, null, "claude"),
    ).toEqual({ shouldFallback: true, cooldownMs: 0 });
  });

  it("never classifies generic 400/403/429 as billing", () => {
    expect(fallback.isBillingExhausted(400, "Bad request", "anthropic")).toBe(false);
    expect(fallback.isBillingExhausted(403, "Forbidden", "openai")).toBe(false);
    expect(fallback.isBillingExhausted(429, "rate limit exceeded", "openai")).toBe(false);
    // Manufactured generic-403 text + the OpenAI word: a plain 403 is never billing.
    expect(fallback.isBillingExhausted(403, "Forbidden: insufficient_quota", "openai")).toBe(false);
    expect(fallback.checkFallbackError(400, "Bad request")).toEqual({
      shouldFallback: false,
      cooldownMs: 0,
    });
  });

  it("flags OpenAI billing codes on structured 429s, ignores transient ones", async () => {
    expect(
      fallback.isBillingExhausted(
        429,
        await parsed(429, openaiBody("insufficient_quota")),
        "openai",
      ),
    ).toBe(true);
    expect(
      fallback.isBillingExhausted(
        429,
        await parsed(429, openaiBody("billing_hard_limit_reached", "invalid_request_error")),
        "openai",
      ),
    ).toBe(true);
    expect(
      fallback.isBillingExhausted(
        429,
        await parsed(429, openaiBody("rate_limit_exceeded", "requests")),
        "openai",
      ),
    ).toBe(false);
  });

  it("an upstream/user cannot spoof the [code=...] marker", async () => {
    const spoof = await parsed(429, {
      error: { message: "slow down [code=insufficient_quota]", code: "rate_limit_exceeded" },
    });
    expect(fallback.isBillingExhausted(429, spoof, "openai")).toBe(false);
    const plain = await parsed(403, openaiBody("insufficient_quota"));
    expect(fallback.isBillingExhausted(403, plain, "openai")).toBe(false);
  });

  it("excludes providers with their own 402 flows, keeps plain API-key 402", () => {
    expect(fallback.isBillingExhausted(402, "blocked", "grok-cli")).toBe(false);
    expect(fallback.isBillingExhausted(402, "blocked", "commandcode")).toBe(false);
    expect(fallback.isBillingExhausted(402, "Payment required", "anthropic")).toBe(true);
  });

  it("marker splicing cannot forge a billing code (fixpoint stripping)", async () => {
    const msg = await parsed(429, {
      error: {
        message: "slow [co[code=x]de=insufficient_quota] down",
        code: "rate_limit_exceeded",
      },
    });
    expect(msg).not.toMatch(/\[code=/i);
    expect(fallback.isBillingExhausted(429, msg, "openai")).toBe(false);
    const adjacent = await parsed(429, {
      error: { message: "a [[code=insufficient_quota]] b", code: "rate_limit_exceeded" },
    });
    expect(fallback.isBillingExhausted(429, adjacent, "openai")).toBe(false);
  });

  it("bare 'code=' text is preserved (B1): only the bracketed prefix is neutralized", async () => {
    const { withStructuredBillingCodes } = await import("../../open-sse/utils/error.js");
    const body = JSON.stringify({ error: { code: "rate_limit_exceeded" } });
    expect(withStructuredBillingCodes("HTTP error code=400 rate limit", body)).toBe(
      "HTTP error code=400 rate limit",
    );
    expect(withStructuredBillingCodes("exit code=1 (code=2) ok", body)).toBe(
      "exit code=1 (code=2) ok",
    );
    // A real structured billing code still appends exactly one marker.
    const billingBody = JSON.stringify({ error: { code: "insufficient_quota" } });
    const out = withStructuredBillingCodes("quota hit", billingBody);
    expect(out).toBe("quota hit [code=insufficient_quota]");
    expect(fallback.isBillingExhausted(429, out, "openai")).toBe(true);
  });

  it("nested marker spoofs at depth >= 6 never become billing (B1)", async () => {
    const { withStructuredBillingCodes } = await import("../../open-sse/utils/error.js");
    const body = JSON.stringify({ error: { code: "rate_limit_exceeded" } });
    // Each pass of fixpoint stripping splices one more marker together; depth 7
    // outlasts the 5-pass cap, so the remainder must be neutralized, not kept.
    let spoof = "[code=insufficient_quota]";
    for (let i = 0; i < 7; i++) spoof = `[co${spoof}de=insufficient_quota]`;
    const msg = withStructuredBillingCodes(`slow ${spoof} down`, body);
    expect(msg).not.toMatch(/\[code=/i);
    expect(fallback.isBillingExhausted(429, msg, "openai")).toBe(false);
    expect(fallback.isBillingExhausted(402, msg, "grok-cli")).toBe(false);
  });

  it("persisted lock carries only fixed text and a valid reason rule", () => {
    const lock = fallback.buildBillingLock(
      400,
      "credit balance is too low sk-ant-SECRET Bearer abc",
      7,
    );
    expect(JSON.stringify(lock)).not.toMatch(/SECRET|sk-ant|Bearer/);
    expect(lock.message).toBe("Upstream reported exhausted credit or spend limit");
    expect(fallback.getBillingLock({ billingLock: lock })).toBe(lock);
    expect(fallback.getBillingLock({ billingLock: { ...lock, reason: "other" } })).toBeNull();
    expect(fallback.getBillingLock({ billingLock: { generation: 1 } })).toBeNull();
  });

  it("keeps extra-usage behavior unchanged", () => {
    expect(
      fallback.checkFallbackError(400, "You're out of extra usage. Add more credits."),
    ).toEqual({ shouldFallback: true, cooldownMs: 0 });
  });
});

function locked(id, provider = "anthropic", generation = 100) {
  return {
    id,
    provider,
    authType: "apikey",
    isActive: true,
    billingLock: {
      reason: "credit_exhausted",
      code: "http_400",
      message: "credit balance is too low",
      lockedAt: new Date().toISOString(),
      nextProbeAt: new Date().toISOString(),
      lastProbeAt: null,
      lastProbeError: null,
      generation,
    },
  };
}

describe("billing lock plumbing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("locks the whole connection on an Anthropic credit 400", async () => {
    const conn = { id: "a1", provider: "anthropic", authType: "apikey", name: "key A" };
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([conn]);
    const lock = fallback.buildBillingLock(400, ANTHROPIC_400, 1000);
    mutateBillingLockUnscoped.mockResolvedValue({ applied: true, billingLock: lock });

    const r = await markAccountUnavailable("a1", 400, ANTHROPIC_400, "anthropic", "claude-x");
    expect(r.shouldFallback).toBe(true);
    expect(mutateBillingLockUnscoped).toHaveBeenCalledWith("a1", expect.any(Function));
    const patch = mutateBillingLockUnscoped.mock.calls[0][1](conn);
    expect(patch.billingLock.reason).toBe("credit_exhausted");
    expect(patch.billingLockGeneration).toBeGreaterThan(0);
    // Transacted floor: same-ms re-lock never repeats the previous generation.
    expect(
      mutateBillingLockUnscoped.mock.calls[0][1]({ ...conn, billingLockGeneration: 2000 })
        .billingLockGeneration,
    ).toBeGreaterThan(2000);
  });

  it("skips billing-locked connections for every model", async () => {
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([
      locked("a1", "anthropic"),
      { id: "a2", provider: "anthropic", authType: "apikey", priority: 2 },
    ]);
    const first = await getProviderCredentials("anthropic", null, "claude-haiku-4-5-20251001");
    expect(first?.connectionId ?? first?.id).toBe("a2");
    const other = await getProviderCredentials("anthropic", null, "claude-opus-5");
    expect(other?.connectionId ?? other?.id).toBe("a2");
  });

  it("does not lock subscription/OAuth connections", async () => {
    const conn = { id: "o1", provider: "anthropic", authType: "oauth" };
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([conn]);
    dbMocks.updateProviderConnectionUnscoped.mockResolvedValue(null);
    await markAccountUnavailable("o1", 400, ANTHROPIC_400, "anthropic", "claude-x");
    expect(mutateBillingLockUnscoped).not.toHaveBeenCalled();
    expect(dbMocks.updateProviderConnectionUnscoped).toHaveBeenCalled();
  });
});

// --- probe outcomes (no real upstream: injected fake executor + in-memory store) ---

const { CLAUDE_OK, OPENAI_OK, lockOf, makeStore, makeDeps } = await import(
  "./billing-probe-fixtures.js"
);

const run = (id, deps, opts = {}) => probe.probeBillingConnection(id, { deps, ...opts });

describe("billing probe", () => {
  it("success with a valid inference clears the lock and retains spend in the detail row", async () => {
    const store = makeStore({ billingLock: lockOf(100) });
    const { deps } = makeDeps(store);
    const r = await run("a1", deps);
    expect(r.result).toBe("cleared");
    expect(r.billingLock).toBeNull();
    expect(store.live.billingLock ?? null).toBeNull();
    // Internal accounting: tagged request-detail row, real tokens + computed cost.
    const detail = deps.saveDetail.mock.calls[0][0];
    expect(detail).toMatchObject({
      connectionId: "a1",
      endpoint: "/internal/billing-probe",
      tokens: expect.objectContaining({ prompt_tokens: 8 }),
    });
    expect(detail.response.cost).toBeGreaterThan(0);
    // No dead per-connection stats storage.
    expect(store.live.billingProbeStats).toBeUndefined();
  });

  it("billing failure keeps the lock, reschedules and records code 'billing'", async () => {
    const body = {
      error: { type: "invalid_request_error", message: "Your credit balance is too low" },
    };
    const store = makeStore({ billingLock: lockOf(100) });
    const r = await run("a1", makeDeps(store, { body, status: 400 }).deps);
    expect(r.result).toBe("still_locked");
    expect(r.billingLock.lastProbeError).toBe("billing");
    expect(r.billingLock.lastProbeAt).toBeTruthy();
    expect(Date.parse(r.billingLock.nextProbeAt)).toBeGreaterThan(Date.now());
  });

  it("ambiguous failures keep the lock and persist ONLY allowlisted codes", async () => {
    const cases = [
      [500, { error: { message: "boom sk-ant-SECRET" } }, "server_error"],
      [401, { error: { message: "bad key sk-ant-SECRET" } }, "auth"],
      [403, { error: { message: "nope" } }, "auth"],
      [429, { error: { message: "slow down", code: "rate_limit_exceeded" } }, "rate_limited"],
      [404, { error: { message: "model gone" } }, "probe_model_unavailable"],
      [400, { error: { message: "max_tokens too small" } }, "probe_model_unavailable"],
    ];
    for (const [status, body, expected] of cases) {
      const store = makeStore({ billingLock: lockOf(100) });
      const r = await run("a1", makeDeps(store, { body, status }).deps);
      expect([r.result, status]).toEqual(["error", status]);
      expect(store.live.billingLock.lastProbeError).toBe(expected);
      expect(JSON.stringify(r)).not.toMatch(/SECRET|sk-ant/);
    }
    const throwing = makeStore({ billingLock: lockOf(100) });
    const t = await run(
      "a1",
      makeDeps(throwing, {
        execute: vi.fn(async () => {
          throw Object.assign(new Error("x"), { name: "AbortError" });
        }),
      }).deps,
    );
    expect(t.result).toBe("error");
    expect(throwing.live.billingLock.lastProbeError).toBe("timeout");
    const net = makeStore({ billingLock: lockOf(100) });
    await run(
      "a1",
      makeDeps(net, {
        execute: vi.fn(async () => {
          throw new TypeError("fetch failed");
        }),
      }).deps,
    );
    expect(net.live.billingLock.lastProbeError).toBe("network");
  });

  it("empty/invalid 200 stays locked with invalid_response", async () => {
    const bad = [
      { type: "message", content: [], usage: { input_tokens: 1, output_tokens: 0 } },
      { type: "message", content: [{ type: "text", text: "ok" }] }, // no usage
      { ok: true },
    ];
    for (const body of bad) {
      const store = makeStore({ billingLock: lockOf(100) });
      const r = await run("a1", makeDeps(store, { body }).deps);
      expect(r.result).toBe("error");
      expect(store.live.billingLock.lastProbeError).toBe("invalid_response");
    }
  });

  it("unavailable probe model: ONE dispatch (no candidate retries), stays locked, escape stays open", async () => {
    const store = makeStore({ billingLock: lockOf(100) });
    const { deps, exec } = makeDeps(store, {
      body: { error: { message: "model not found" } },
      status: 404,
    });
    const r = await run("a1", deps);
    expect(r.result).toBe("error");
    expect(exec).toHaveBeenCalledTimes(1); // bounded spend: no fallback model attempts
    expect(store.live.billingLock.lastProbeError).toBe("probe_model_unavailable");
    // The lock is not cleared by this; recovery is the PUT escape (new key /
    // re-enable), covered in billing-put-escape.test.js.
    expect(store.live.billingLock.reason).toBe("credit_exhausted");
  });

  it("missing pricing never spends: probe_model_unavailable, executor not called", async () => {
    const store = makeStore({ billingLock: lockOf(100) });
    const { deps, exec } = makeDeps(store, { pricing: null });
    const r = await run("a1", deps);
    expect(r.result).toBe("error");
    expect(exec).not.toHaveBeenCalled();
    expect(store.live.billingLock.lastProbeError).toBe("probe_model_unavailable");
  });

  it("a re-lock (new generation) mid-probe is never cleared by the stale probe", async () => {
    const store = makeStore({ billingLock: lockOf(100) });
    const { deps } = makeDeps(store, {
      execute: vi.fn(async () => {
        store.live.billingLock = lockOf(101); // re-locked while the probe was in flight
        return { response: new Response(JSON.stringify(CLAUDE_OK), { status: 200 }) };
      }),
    });
    const r = await run("a1", deps);
    expect(r.result).toBe("still_locked");
    expect(store.live.billingLock.generation).toBe(101);
  });

  it("disabled: pre-check returns 'disabled' and never dispatches; mid-probe disable is never re-enabled", async () => {
    const off = makeStore({ billingLock: lockOf(100), isActive: false });
    const a = makeDeps(off);
    expect((await run("a1", a.deps)).result).toBe("disabled");
    expect(a.exec).not.toHaveBeenCalled();

    const mid = makeStore({ billingLock: lockOf(100) });
    const { deps } = makeDeps(mid, {
      execute: vi.fn(async () => {
        mid.live.isActive = false; // user disables during the probe
        return { response: new Response(JSON.stringify(CLAUDE_OK), { status: 200 }) };
      }),
    });
    const r = await run("a1", deps);
    expect(r.result).toBe("disabled");
    expect(mid.live.isActive).toBe(false);
    expect(mid.live.billingLock).toBeTruthy();
  });

  it("deleted connection reports not_found", async () => {
    const store = makeStore({ billingLock: lockOf(100) });
    store.live.__deleted = true;
    expect((await run("a1", makeDeps(store).deps)).result).toBe("not_found");
  });

  it("openai probe: valid chat body in, chat completion validated, spend recorded", async () => {
    const store = makeStore({ provider: "openai", billingLock: lockOf(100) });
    const { deps, exec } = makeDeps(store, { body: OPENAI_OK });
    const r = await run("a1", deps);
    expect(r.result).toBe("cleared");
    const call = exec.mock.calls[0][0];
    expect(call.stream).toBe(false);
    expect(call.model).toBe("gpt-4o-mini");
    expect(call.body).toEqual({
      model: "gpt-4o-mini",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    expect(call.body.tools).toBeUndefined();
    expect(deps.saveDetail.mock.calls[0][0].response.cost).toBeGreaterThan(0);
    // An OpenAI refusal / empty choice is not proof.
    const bad = makeStore({ provider: "openai", billingLock: lockOf(100) });
    const rb = await run(
      "a1",
      makeDeps(bad, {
        body: {
          choices: [{ message: { content: "" } }],
          usage: { prompt_tokens: 3, completion_tokens: 0 },
        },
      }).deps,
    );
    expect(rb.result).toBe("error");
  });
});

describe("claim lease (cross-process single-flight)", () => {
  it("scheduler claim only when due; second claim loses", async () => {
    const store = makeStore({ billingLock: lockOf(100) });
    const first = makeDeps(store);
    // Two "processes": separate in-flight state is simulated by calling runProbe
    // sequentially against the same store; the DB claim alone must refuse #2.
    const r1 = await run("a1", first.deps);
    expect(r1.result).toBe("cleared"); // first claim won and cleared
    // Re-lock then race two claims while the first one is still "in flight":
    store.live.billingLock = lockOf(200);
    let release;
    const gate = new Promise((res) => (release = res));
    const slow = makeDeps(store, {
      execute: vi.fn(async () => {
        await gate;
        return { response: new Response(JSON.stringify(CLAUDE_OK), { status: 200 }) };
      }),
    });
    const p1 = run("a1", slow.deps); // wins the claim (now nextProbeAt moved forward)
    await new Promise((r) => setTimeout(r, 5));
    // A second process sees the in-process set empty (simulated by a fresh module
    // state): emulate by clearing the fast path and attempting the claim directly.
    global.__billingProbe.inFlight.clear();
    const second = makeDeps(store);
    const r2 = await run("a1", second.deps);
    expect(r2.result).toBe("still_locked"); // lease held: not due
    expect(second.exec).not.toHaveBeenCalled();
    release();
    expect((await p1).result).toBe("cleared");
  });

  it("manual probe is rate limited server-side; first-ever probe allowed", async () => {
    const store = makeStore({ billingLock: lockOf(100, { lastProbeAt: null }) });
    const ok = await run(
      "a1",
      makeDeps(store, { body: { error: { message: "boom" } }, status: 500 }).deps,
      {
        manual: true,
      },
    );
    expect(ok.result).toBe("error"); // first manual allowed
    const again = await run("a1", makeDeps(store).deps, { manual: true });
    expect(again.result).toBe("rate_limited");
    expect(again.retryAfterMs).toBeGreaterThan(0);
    expect(again.retryAfterMs).toBeLessThanOrEqual(5 * 60 * 1000);
    // Older than the window: allowed again.
    store.live.billingLock.lastProbeAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const later = await run("a1", makeDeps(store).deps, { manual: true });
    expect(later.result).toBe("cleared");
  });
});

describe("combo falls through on a billing 400", () => {
  it("checkFallbackError returns billing=true so combo advances", async () => {
    const { handleComboChat } = await import("../../open-sse/services/combo.js");
    const replies = [
      new Response(JSON.stringify({ error: { message: "Your credit balance is too low" } }), {
        status: 400,
      }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ];
    const seen = [];
    const res = await handleComboChat({
      body: {},
      models: ["anthropic/m1", "anthropic/m2"],
      handleSingleModel: async (_b, m) => {
        seen.push(m);
        return replies.shift();
      },
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["anthropic/m1", "anthropic/m2"]);
  });

  it("is provider-gated: the same text on a non-anthropic member still stops the combo", async () => {
    const { handleComboChat } = await import("../../open-sse/services/combo.js");
    const res = await handleComboChat({
      body: {},
      models: ["openai/m1", "anthropic/m2"],
      handleSingleModel: async (_b, m) =>
        m === "openai/m1"
          ? new Response(JSON.stringify({ error: { message: "Your credit balance is too low" } }), {
              status: 400,
            })
          : new Response(JSON.stringify({ ok: true }), { status: 200 }),
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    });
    expect(res.status).toBe(400); // openai/m1 400 stops; anthropic/m2 never tried
  });

  it("classifyProbeError tags billing only for gated providers; other errors unchanged", async () => {
    const { classifyProbeError } = await import("../../open-sse/services/combo.js");
    expect(classifyProbeError(400, "credit balance is too low", "anthropic")).toBe("billing");
    expect(classifyProbeError(400, "credit balance is too low", "openai")).toBe("error 400");
    expect(classifyProbeError(429, "rate limit")).toBe("rate limited");
    expect(classifyProbeError(401, "nope")).toBe("auth error");
    expect(classifyProbeError(503, "x")).toBe("upstream error");
  });
});
