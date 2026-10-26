// YAN-1288: revoked access-token-only codex rows are flagged after one
// conclusive 401 (structured code or rejection wording), not locked for 2 min.
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnectionsUnscoped: vi.fn(),
  updateProviderConnectionUnscoped: vi.fn(),
}));

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
  resolveProviderId: (provider) => provider,
}));

vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { mutateProviderConnectionUnscoped } = await import("@/lib/db/index.js");
const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");
const { classifyAccessTokenRejection } = await import(
  "../../open-sse/services/earlyTokenExpiry.js"
);

const HOUR = 3600 * 1000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

const accessTokenRow = (id, extra = {}) => ({
  id,
  provider: "codex",
  authType: "access_token",
  accessToken: `at-${id}`,
  expiresAt: iso(HOUR),
  priority: 1,
  ...extra,
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

describe("classifyAccessTokenRejection (YAN-1288)", () => {
  const structured = (code) => JSON.stringify({ error: { code } });
  const message = (text) => JSON.stringify({ error: { message: text } });

  it("maps allowlisted structured codes", () => {
    expect(classifyAccessTokenRejection(structured("token_invalidated"))).toBe("token_invalidated");
    expect(classifyAccessTokenRejection(structured("token_revoked"))).toBe("token_revoked");
    expect(classifyAccessTokenRejection(structured("invalid_token"))).toBe("invalid_token");
    expect(classifyAccessTokenRejection(structured("invalid_api_key"))).toBe("invalid_api_key");
  });

  it("maps account_deactivated to unknown; other structured codes are inconclusive", () => {
    expect(classifyAccessTokenRejection(structured("account_deactivated"))).toBe("unknown");
    // An unknown structured code must NOT flag: only the allowlist is conclusive.
    expect(classifyAccessTokenRejection(structured("some_other_code"))).toBeNull();
    expect(classifyAccessTokenRejection(structured("never_heard_of_it"))).toBeNull();
  });

  it("matches rejection wording in messages", () => {
    expect(classifyAccessTokenRejection(message("Your token was revoked."))).toBe("unknown");
    expect(classifyAccessTokenRejection(message("token has been invalidated"))).toBe("unknown");
    expect(classifyAccessTokenRejection(message("Invalid token provided"))).toBe("unknown");
    expect(classifyAccessTokenRejection(message("Incorrect API key"))).toBe("unknown");
    expect(classifyAccessTokenRejection(message("That token was REVOKED upstream"))).toBe(
      "unknown",
    );
  });

  it("ignores bare/plain 401 bodies and non-rejection wording", () => {
    expect(classifyAccessTokenRejection("Unauthorized")).toBeNull();
    expect(classifyAccessTokenRejection(message("Missing permissions"))).toBeNull();
    expect(classifyAccessTokenRejection("")).toBeNull();
    expect(classifyAccessTokenRejection(null)).toBeNull();
  });

  it("parses the production formatProviderError shape [401]: {raw body}", () => {
    // handleReauthOnFailure receives "[401]: " + JSON.stringify(body) in production.
    const wrapped = (body) => `[401]: ${JSON.stringify(body)}`;
    expect(classifyAccessTokenRejection(wrapped({ error: { code: "token_invalidated" } }))).toBe(
      "token_invalidated",
    );
    expect(classifyAccessTokenRejection(wrapped({ error: { code: "account_deactivated" } }))).toBe(
      "unknown",
    );
    expect(
      classifyAccessTokenRejection(wrapped({ error: { code: "some_other_code" } })),
    ).toBeNull();
    // Wording must be scanned only in the message field of a parsed body, never
    // across the whole JSON string (a code field mentioning e.g. "revoked"
    // elsewhere must not match by accident of serialization).
    expect(
      classifyAccessTokenRejection(wrapped({ error: { code: "unrelated", other: "revoked" } })),
    ).toBeNull();
    expect(classifyAccessTokenRejection(wrapped({ error: { message: "token was revoked" } }))).toBe(
      "unknown",
    );
    expect(
      classifyAccessTokenRejection(
        JSON.stringify({
          error: { code: "token_expired", message: "your authentication token has expired" },
        }),
      ),
    ).toBeNull();
  });

  it("does not mistake an expired-token body for a rejection", () => {
    expect(
      classifyAccessTokenRejection(
        JSON.stringify({
          error: { code: "token_expired", message: "your authentication token has expired" },
        }),
      ),
    ).toBeNull();
  });
});

describe("handleReauthOnFailure: conclusive rejection flags the row (YAN-1288)", () => {
  it("flags with accessTokenRejected + code on a structured token_invalidated 401", async () => {
    const conn = accessTokenRow("a1");
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([conn]);
    mutateProviderConnectionUnscoped.mockResolvedValue({ applied: true, missing: false });

    const r = await markAccountUnavailable(
      "a1",
      401,
      JSON.stringify({ error: { code: "token_invalidated" } }),
      "codex",
      "gpt-5",
    );
    expect(r).toEqual({ shouldFallback: true, cooldownMs: 0 });
    expect(dbMocks.updateProviderConnectionUnscoped).not.toHaveBeenCalled();

    const decide = mutateProviderConnectionUnscoped.mock.calls[0][1];
    const patch = decide(conn);
    expect(patch.reauthRequired).toMatchObject({
      reason: "access_token_rejected",
      code: "token_invalidated",
    });
    expect(patch).toMatchObject({ testStatus: "error", lastError: "Token invalid or revoked" });
  });

  it("flags with code unknown on rejection wording without a structured code", async () => {
    const conn = accessTokenRow("a2");
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([conn]);
    mutateProviderConnectionUnscoped.mockResolvedValue({ applied: true, missing: false });

    const r = await markAccountUnavailable(
      "a2",
      401,
      JSON.stringify({ error: { message: "This token was revoked by the owner" } }),
      "codex",
      "gpt-5",
    );
    expect(r).toEqual({ shouldFallback: true, cooldownMs: 0 });

    const decide = mutateProviderConnectionUnscoped.mock.calls[0][1];
    expect(decide(conn).reauthRequired).toMatchObject({
      reason: "access_token_rejected",
      code: "unknown",
    });
  });

  it("keeps the 2-minute model lock for a bare unrecognized 401", async () => {
    const conn = accessTokenRow("a3");
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([conn]);
    dbMocks.updateProviderConnectionUnscoped.mockResolvedValue(null);

    const r = await markAccountUnavailable("a3", 401, "Unauthorized", "codex", "gpt-5");
    expect(r.shouldFallback).toBe(true);
    expect(r.cooldownMs).toBeGreaterThan(0);
    expect(mutateProviderConnectionUnscoped).not.toHaveBeenCalled();
  });

  it("never flags an oauth row with a refresh token on a rejection 401", async () => {
    const conn = oauth("c1");
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([conn]);
    dbMocks.updateProviderConnectionUnscoped.mockResolvedValue(null);

    const r = await markAccountUnavailable(
      "c1",
      401,
      JSON.stringify({ error: { code: "token_revoked" } }),
      "codex",
      "gpt-5",
    );
    expect(r.shouldFallback).toBe(true);
    expect(r.cooldownMs).toBeGreaterThan(0);
    expect(mutateProviderConnectionUnscoped).not.toHaveBeenCalled();
  });

  it("guards the conditional write against a re-imported token or an existing flag", async () => {
    const conn = accessTokenRow("a4");
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([conn]);
    mutateProviderConnectionUnscoped.mockResolvedValue({ applied: true, missing: false });

    await markAccountUnavailable(
      "a4",
      401,
      JSON.stringify({ error: { code: "invalid_token" } }),
      "codex",
      "gpt-5",
    );

    const decide = mutateProviderConnectionUnscoped.mock.calls[0][1];
    expect(decide({ ...conn, accessToken: "reimported" })).toBeNull();
    expect(
      decide({
        ...conn,
        reauthRequired: { reason: "access_token_rejected", code: "unknown", at: iso(0) },
      }),
    ).toBeNull();
    expect(decide({ ...conn, refreshToken: "rt-new" })).toBeNull();
  });
});
