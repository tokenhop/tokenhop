// YAN-1035: learn a connection's real access-token lifetime from an early
// `token_expired` 401 (stored expiry still in the future) and refresh sooner.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, refreshCredentialsMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  refreshCredentialsMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: false,
    supportsRefresh: true,
    execute: executeMock,
    refreshCredentials: refreshCredentialsMock,
  }),
}));

vi.mock("../../open-sse/services/tokenRefresh.js", async (importOriginal) => ({
  ...(await importOriginal()),
  refreshWithRetry: async (fn) => fn(),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetailUnscoped: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const mgr = await import("../../open-sse/services/oauthCredentialManager.js");
const life = await import("../../open-sse/services/tokenLifetime.js");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const TOKEN_EXPIRED_BODY = {
  error: { message: "Your authentication token has expired.", code: "token_expired" },
};

function respond401(body) {
  return {
    response: new Response(JSON.stringify(body), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
    url: "https://chatgpt.com/backend-api/codex/responses",
    headers: {},
    transformedBody: null,
  };
}

async function run({ provider = "codex", credentials, upstream = TOKEN_EXPIRED_BODY }) {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  executeMock.mockResolvedValue(respond401(upstream));
  const onCredentialsRefreshed = vi.fn(async () => {});
  await handleChatCore({
    body: { model: "gpt-5", stream: false, messages: [{ role: "user", content: "hi" }] },
    modelInfo: { provider, model: "gpt-5" },
    credentials,
    log,
    connectionId: "conn-1",
    onCredentialsRefreshed,
    rtkEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: {} },
  });
  return { log, onCredentialsRefreshed };
}

const storedCreds = (ageMs, expiresInMs, extra = {}) => ({
  accessToken: "at-old",
  refreshToken: "rt-old",
  lastRefreshAt: new Date(Date.now() - ageMs).toISOString(),
  expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  providerSpecificData: { chatgptAccountId: "acc" },
  ...extra,
});

const refreshed = {
  accessToken: "at-new",
  refreshToken: "rt-new",
  expiresAt: "2099-01-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  refreshCredentialsMock.mockResolvedValue({ ...refreshed });
});

describe("chatCore 401 token_expired → observed lifetime", () => {
  it("records now - lastRefreshAt when the stored expiry was still in the future", async () => {
    const { log, onCredentialsRefreshed } = await run({
      credentials: storedCreds(20 * MIN, 9 * DAY),
    });

    const patch = onCredentialsRefreshed.mock.calls[0][0].providerSpecificData;
    expect(patch.observedLifetimeMs).toBeGreaterThan(19.9 * MIN);
    expect(patch.observedLifetimeMs).toBeLessThan(20.5 * MIN);
    expect(Date.parse(patch.observedLifetimeAt)).toBeGreaterThan(Date.now() - 5000);
    // sibling PSD keys are not re-sent in the delta
    expect(patch.chatgptAccountId).toBeUndefined();
    const warns = log.warn.mock.calls.filter((c) =>
      /observed|early|token_expired/i.test(c.join(" ")),
    );
    expect(warns).toHaveLength(1);
  });

  it("keeps sibling providerSpecificData on the in-memory credentials for the retry", async () => {
    const credentials = storedCreds(20 * MIN, 9 * DAY, {
      providerSpecificData: { chatgptAccountId: "acc", strictProxy: true },
    });
    await run({ credentials });
    expect(credentials.providerSpecificData).toMatchObject({
      chatgptAccountId: "acc",
      strictProxy: true,
    });
    expect(credentials.providerSpecificData.observedLifetimeMs).toBeGreaterThan(0);
    expect(credentials.accessToken).toBe("at-new");
  });

  it("matches the error by message alone (no code field)", async () => {
    const { onCredentialsRefreshed } = await run({
      credentials: storedCreds(HOUR, 9 * DAY),
      upstream: {
        error: { message: "Your authentication token has expired. Please try signing in again." },
      },
    });
    expect(
      onCredentialsRefreshed.mock.calls[0][0].providerSpecificData.observedLifetimeMs,
    ).toBeGreaterThan(0);
  });

  it("treats a token age under the 15 minute minimum as unknown (no record)", async () => {
    expect(life.MIN_OBSERVED_LIFETIME_MS).toBe(15 * MIN);
    for (const age of [10 * 1000, 5 * MIN, 14 * MIN]) {
      const { onCredentialsRefreshed, log } = await run({
        credentials: storedCreds(age, 9 * DAY),
      });
      expect(
        onCredentialsRefreshed.mock.calls[0]?.[0].providerSpecificData?.observedLifetimeMs,
      ).toBeUndefined();
      expect(
        log.warn.mock.calls.filter((c) => /recording observed/i.test(c.join(" "))),
      ).toHaveLength(0);
    }
  });

  it("records exactly at the minimum", async () => {
    const { onCredentialsRefreshed } = await run({ credentials: storedCreds(16 * MIN, 9 * DAY) });
    expect(
      onCredentialsRefreshed.mock.calls[0][0].providerSpecificData.observedLifetimeMs,
    ).toBeGreaterThanOrEqual(15 * MIN);
  });

  it("a freshly imported connection (lastRefreshAt = now) never records", async () => {
    const { onCredentialsRefreshed } = await run({ credentials: storedCreds(0, 9 * DAY) });
    expect(
      onCredentialsRefreshed.mock.calls[0]?.[0].providerSpecificData?.observedLifetimeMs,
    ).toBeUndefined();
  });

  it("keeps sibling providerSpecificData untouched for non-lifetime-aware providers", async () => {
    const credentials = storedCreds(HOUR, 9 * DAY);
    refreshCredentialsMock.mockResolvedValue({
      ...refreshed,
      providerSpecificData: { extra: 1 },
    });
    await run({ provider: "claude", credentials });
    // prior behaviour: plain Object.assign replaces the object
    expect(credentials.providerSpecificData).toEqual({ extra: 1 });
  });

  it("does not record when the stored expiry already passed (genuinely expired)", async () => {
    const { log, onCredentialsRefreshed } = await run({ credentials: storedCreds(2 * HOUR, -MIN) });
    expect(
      onCredentialsRefreshed.mock.calls[0]?.[0].providerSpecificData?.observedLifetimeMs,
    ).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.stringMatching(/./),
      expect.stringMatching(/observed/i),
    );
  });

  it("does not record for a revoked / other 401", async () => {
    const { onCredentialsRefreshed } = await run({
      credentials: storedCreds(HOUR, 9 * DAY),
      upstream: { error: { message: "Token revoked", code: "token_revoked" } },
    });
    expect(
      onCredentialsRefreshed.mock.calls[0]?.[0].providerSpecificData?.observedLifetimeMs,
    ).toBeUndefined();
  });

  it("does not record (or persist) when the refresh fails", async () => {
    refreshCredentialsMock.mockResolvedValue(null);
    const { onCredentialsRefreshed } = await run({ credentials: storedCreds(HOUR, 9 * DAY) });
    expect(onCredentialsRefreshed).not.toHaveBeenCalled();
  });

  it("does not record when lastRefreshAt is unknown", async () => {
    const { onCredentialsRefreshed } = await run({
      credentials: storedCreds(HOUR, 9 * DAY, { lastRefreshAt: undefined }),
    });
    expect(
      onCredentialsRefreshed.mock.calls[0]?.[0].providerSpecificData?.observedLifetimeMs,
    ).toBeUndefined();
  });

  it("ignores providers that are not lifetime-aware", async () => {
    const { onCredentialsRefreshed } = await run({
      provider: "claude",
      credentials: storedCreds(HOUR, 9 * DAY),
    });
    expect(
      onCredentialsRefreshed.mock.calls[0]?.[0].providerSpecificData?.observedLifetimeMs,
    ).toBeUndefined();
  });
});

describe("observed lifetime shortens the refresh lead", () => {
  const now = Date.now();
  const psd = (ms, at = now) => ({
    observedLifetimeMs: ms,
    observedLifetimeAt: new Date(at).toISOString(),
  });
  const base = (ageMs, extraPsd) => ({
    refreshToken: "rt",
    lastRefreshAt: new Date(now - ageMs).toISOString(),
    expiresAt: new Date(now - ageMs + 10 * DAY).toISOString(),
    providerSpecificData: extraPsd,
  });

  it("lead = observed / 2: a 10-day token that dies at 20 min refreshes after 10 min", () => {
    expect(mgr.shouldRefreshCredentials("codex", base(5 * MIN, psd(20 * MIN)), now)).toBe(false);
    // refreshed 11 min ago, past the 5 min interval floor and inside observed/2
    expect(mgr.shouldRefreshCredentials("codex", base(11 * MIN, psd(20 * MIN)), now)).toBe(true);
  });

  it("without an observation the same token is not due", () => {
    expect(mgr.shouldRefreshCredentials("codex", base(11 * MIN, undefined), now)).toBe(false);
  });

  it("is bounded below by the 5 minute lead and the refresh interval", () => {
    expect(mgr.getEffectiveRefreshLeadMs("codex", base(0, psd(5 * MIN)), now)).toBe(5 * MIN);
    expect(mgr.getEffectiveRefreshLeadMs("codex", base(0, psd(MIN)), now)).toBe(5 * MIN);
    expect(mgr.shouldRefreshCredentials("codex", base(2 * MIN, psd(MIN)), now)).toBe(false);
  });

  it("an observation older than the TTL is ignored (recovery is TTL + replacement)", () => {
    const old = psd(20 * MIN, now - life.OBSERVED_LIFETIME_TTL_MS - HOUR);
    expect(life.getObservedLifetimeMs(old, now)).toBeNull();
    expect(mgr.shouldRefreshCredentials("codex", base(11 * MIN, old), now)).toBe(false);
  });

  it("a newer, longer observation replaces the old one", () => {
    const next = { ...psd(20 * MIN), ...psd(3 * HOUR) };
    expect(mgr.getEffectiveRefreshLeadMs("codex", base(0, next), now)).toBe(90 * MIN);
  });

  it("an idle account's proactive refresh (token age > observed) keeps the record", () => {
    const current = base(25 * MIN, psd(20 * MIN, now - 25 * MIN));
    const merged = mgr.mergeRefreshedCredentials(
      "codex",
      current,
      { accessToken: "x", refreshToken: "rt2", expiresIn: 3600 },
      now,
    );
    expect(merged.providerSpecificData).toBeUndefined();
    const idle = base(3 * DAY, psd(20 * MIN, now - HOUR));
    expect(
      mgr.mergeRefreshedCredentials(
        "codex",
        idle,
        { accessToken: "x", refreshToken: "rt2", expiresIn: 3600 },
        now,
      ).providerSpecificData,
    ).toBeUndefined();
  });

  it("a proactive refresh at half the recorded lifetime keeps the observation", () => {
    const current = base(10 * MIN, psd(20 * MIN, now - 10 * MIN));
    const merged = mgr.mergeRefreshedCredentials(
      "codex",
      current,
      { accessToken: "x", refreshToken: "rt2", expiresIn: 3600 },
      now,
    );
    expect(merged.providerSpecificData).toBeUndefined();
  });
});

describe("tokenExpired body detection", () => {
  it("recognises code and message forms only", async () => {
    const { isTokenExpiredBody } = await import("../../open-sse/services/earlyTokenExpiry.js");
    expect(isTokenExpiredBody(JSON.stringify(TOKEN_EXPIRED_BODY))).toBe(true);
    expect(isTokenExpiredBody(JSON.stringify({ error: "token_expired" }))).toBe(true);
    expect(isTokenExpiredBody("Your authentication token has expired")).toBe(true);
    expect(isTokenExpiredBody(JSON.stringify({ error: { code: "token_revoked" } }))).toBe(false);
    expect(isTokenExpiredBody("")).toBe(false);
  });
});
