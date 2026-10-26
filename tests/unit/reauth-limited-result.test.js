// YAN-1286: when every account of a provider needs re-authentication, the
// caller gets a clear 503 re-auth message instead of a bare 404 — and combos
// still fall through to the next member immediately.
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnectionsUnscoped: vi.fn(),
  updateProviderConnectionUnscoped: vi.fn(),
}));

dbMocks.updateSettings = vi.fn(async () => {});
dbMocks.getSettings = vi.fn(async () => ({ requireApiKey: false }));
vi.mock("@/lib/localDb", () => dbMocks);

vi.mock("@/lib/db/index.js", () => ({
  getEffectivePreferences: vi.fn(async () => ({})),
  mutateBillingLockUnscoped: vi.fn(),
  mutateProviderConnectionUnscoped: vi.fn(),
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
  AI_PROVIDERS: { codex: { id: "codex", label: "Codex" } },
  resolveProviderId: (provider) => provider,
}));

vi.mock("@/lib/usageDb.js", () => ({
  recordFallbackHop: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetailUnscoped: vi.fn(async () => {}),
}));

vi.mock("@/lib/auth/gatewayAuth.js", () => ({
  ALLOW_KEYLESS_SETTING: "allowKeylessGatewayRequests",
  resolveGatewayAuth: vi.fn(async () => ({ principal: null, legacy: true })),
  authorizeGatewayTarget: vi.fn(() => null),
  gatewayKeyContext: vi.fn(() => null),
  sanitizeGatewayCapture: vi.fn((x) => x),
}));
vi.mock("@/lib/db/repos/settingsRepo.js", () => ({
  getSettings: vi.fn(async () => ({ requireApiKey: false })),
  getEffectivePreferences: vi.fn(async () => ({})),
}));

vi.mock("@/sse/utils/logger.js", () => ({
  nextTag: vi.fn(() => "t"),
  tagForSession: vi.fn(() => "t"),
  line: vi.fn(),
  errorLine: vi.fn(),
  fmtThink: vi.fn(() => ""),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  request: vi.fn(),
}));

const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
const { reauthRequiredResponse, REAUTH_ALL_MESSAGE } = await import(
  "../../open-sse/services/reauthState.js"
);
const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");

const HOUR = 3600 * 1000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const flag = () => ({
  reason: "refresh_token_rejected",
  code: "refresh_token_reused",
  at: iso(0),
});

const oauth = (id, extra = {}) => ({
  id,
  provider: "codex",
  authType: "oauth",
  accessToken: `at-${id}`,
  refreshToken: `rt-${id}`,
  expiresAt: iso(-HOUR),
  priority: 1,
  ...extra,
});

beforeEach(() => vi.clearAllMocks());

describe("reauthLimitedResult (YAN-1286)", () => {
  it("returns a reauthRequired result instead of null when every row is flagged", async () => {
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([
      oauth("c1", { reauthRequired: flag() }),
      oauth("c2", { reauthRequired: flag() }),
    ]);
    const r = await getProviderCredentials("codex", null, "gpt-5");
    expect(r).toMatchObject({
      allRateLimited: true,
      reauthRequired: { provider: "codex", count: 2 },
    });
    expect(r.retryAfterHuman).toBe("reconnect required");
    expect(Date.parse(r.retryAfter)).toBeGreaterThan(Date.now());
    expect(r.lastErrorCode).toBe(503);
  });

  it("message never contains backoff wording that would delay combo fallthrough", () => {
    const msg = REAUTH_ALL_MESSAGE("codex");
    expect(msg).toBe(
      "All codex accounts need re-authentication. Reconnect them on the Providers page.",
    );
    const lower = msg.toLowerCase();
    for (const banned of [
      "rate limit",
      "quota exceeded",
      "too many requests",
      "capacity",
      "overloaded",
    ]) {
      expect(lower).not.toContain(banned);
    }
  });

  it("mixed flagged + model-locked still lets the earliest blocker win", async () => {
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([
      oauth("c1", { reauthRequired: flag() }),
      oauth("c2", { modelLock___all: iso(10 * 60 * 1000), lastError: "model locked" }),
    ]);
    const r = await getProviderCredentials("codex", null, "gpt-5");
    expect(r.allRateLimited).toBe(true);
    expect(r.reauthRequired).toBeUndefined();
    expect(r.lastError).toBe("model locked");
  });

  it("still returns null when no rows exist at all", async () => {
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([]);
    expect(await getProviderCredentials("codex", null, "gpt-5")).toBeNull();
  });

  it("a retry after a healthy account failed returns null, so its real error surfaces", async () => {
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([
      oauth("c1"),
      oauth("c2", { reauthRequired: flag() }),
    ]);
    expect(await getProviderCredentials("codex", new Set(["c1"]), "gpt-5")).toBeNull();
  });
});

describe("reauthRequiredResponse (YAN-1286)", () => {
  it("is a 503 authentication_error with the reauth_required code and no Retry-After", async () => {
    const res = reauthRequiredResponse({ provider: "codex", count: 2 });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBeNull();
    const body = await res.json();
    expect(body.error).toMatchObject({
      message: REAUTH_ALL_MESSAGE("codex"),
      type: "authentication_error",
      code: "reauth_required",
    });
    // F7: no account count leaks to the client.
    expect(body.error.count).toBeUndefined();
  });

  it("carries no request-scoped flags (F8: nothing reads localError on this path)", () => {
    const res = reauthRequiredResponse({ provider: "codex", count: 1 });
    expect(res.localError).toBeUndefined();
    // Combos advance via checkFallbackError on the 503 + message, not via a flag.
  });

  it("checkFallbackError falls through immediately (no transient wait)", () => {
    const res = reauthRequiredResponse({ provider: "codex", count: 2 });
    const { shouldFallback, cooldownMs } = checkFallbackError(
      res.status,
      REAUTH_ALL_MESSAGE("codex"),
    );
    expect(shouldFallback).toBe(true);
    // The transient 503 wait only triggers for cooldownMs <= 5000; the default
    // transient cooldown is 30s, so a combo advances with no wait.
    expect(cooldownMs).toBeGreaterThan(5000);
  });
});

describe("combo skips the transient-503 wait for a reauth_required body (F8)", () => {
  it("does not wait before advancing when the body code is reauth_required", async () => {
    const { handleComboChat } = await import("../../open-sse/services/combo.js");
    const reauthRes = reauthRequiredResponse({ provider: "codex", count: 1 });
    const ok = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    let first = true;
    const handleSingleModel = vi.fn(async () => {
      if (first) {
        first = false;
        return reauthRes;
      }
      return ok;
    });

    const startedAt = Date.now();
    const result = await handleComboChat({
      body: {},
      models: ["codex/gpt-5", "claude/sonnet"],
      handleSingleModel,
      log: { info: () => {}, warn: () => {} },
    });

    expect(result.ok).toBe(true);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    // A policy with transientMs <= 5000 would otherwise wait; a reauth answer
    // must advance immediately whatever the policy says.
    expect(Date.now() - startedAt).toBeLessThan(4000);
  });
});

describe("handleComboChat advances past an all-flagged member (YAN-1286)", () => {
  it("serves the next member when the first answers 503 reauth_required", async () => {
    const { handleComboChat } = await import("../../open-sse/services/combo.js");
    const reauthRes = reauthRequiredResponse({ provider: "codex", count: 3 });
    const ok = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const handleSingleModel = vi.fn(async () =>
      handleSingleModel.mock.calls.length === 1 ? reauthRes : ok,
    );

    const result = await handleComboChat({
      body: {},
      models: ["codex/gpt-5", "claude/sonnet"],
      handleSingleModel,
      log: { info: () => {}, warn: () => {} },
    });

    expect(result.ok).toBe(true);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
  });
});
