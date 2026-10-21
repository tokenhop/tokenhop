// YAN-1038: re-authentication state in account selection and failure handling.
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
const { markAccountUnavailable, getProviderCredentials } = await import(
  "../../src/sse/services/auth.js"
);
const logger = await import("@/sse/utils/logger.js");
const { buildReauthRequired } = await import("../../open-sse/services/reauthState.js");

const HOUR = 3600 * 1000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const flag = () =>
  buildReauthRequired({ reason: "refresh_token_rejected", code: "refresh_token_reused" });

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
const accessTokenRow = (id, extra = {}) => ({
  id,
  provider: "codex",
  authType: "access_token",
  accessToken: `at-${id}`,
  expiresAt: iso(HOUR),
  priority: 1,
  ...extra,
});
const idOf = (c) => c?.connectionId ?? c?.id;

beforeEach(() => vi.clearAllMocks());

describe("account selection skips connections that need re-authentication", () => {
  it("skips a flagged row and picks the next one", async () => {
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([
      oauth("c1", { reauthRequired: flag() }),
      oauth("c2", { priority: 2 }),
    ]);
    expect(idOf(await getProviderCredentials("codex", null, "gpt-5"))).toBe("c2");
  });

  it("returns null when every row is flagged (chat.js 404, combo falls through)", async () => {
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([
      oauth("c1", { reauthRequired: flag() }),
      oauth("c2", { reauthRequired: flag() }),
    ]);
    expect(await getProviderCredentials("codex", null, "gpt-5")).toBeNull();
  });

  it("skips a flagged row even as preferredConnectionId", async () => {
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([
      oauth("c1", { reauthRequired: flag() }),
      oauth("c2", { priority: 2 }),
    ]);
    const r = await getProviderCredentials("codex", null, "gpt-5", {
      preferredConnectionId: "c1",
    });
    expect(idOf(r)).toBe("c2");
  });

  it("skips an expired access_token row without a flag; keeps an unexpired one", async () => {
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([
      accessTokenRow("old", { expiresAt: iso(-HOUR) }),
      accessTokenRow("live", { priority: 2 }),
    ]);
    expect(idOf(await getProviderCredentials("codex", null, "gpt-5"))).toBe("live");
  });

  it("keeps an oauth row with an expired access token but a live refresh token", async () => {
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([oauth("c1")]);
    expect(idOf(await getProviderCredentials("codex", null, "gpt-5"))).toBe("c1");
  });

  it("leaves a non-lifetime-aware provider with an expired access token alone", async () => {
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([
      accessTokenRow("k1", { provider: "kimi", expiresAt: iso(-HOUR) }),
    ]);
    expect(idOf(await getProviderCredentials("kimi", null, "k2"))).toBe("k1");
  });
});

describe("markAccountUnavailable with the re-authentication state", () => {
  const TOKEN_EXPIRED = JSON.stringify({ error: { code: "token_expired" } });

  it("flags an access_token codex row on a token_expired 401, with no model lock", async () => {
    const conn = accessTokenRow("a1");
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([conn]);
    mutateProviderConnectionUnscoped.mockResolvedValue({ applied: true, missing: false });

    const r = await markAccountUnavailable("a1", 401, TOKEN_EXPIRED, "codex", "gpt-5");
    expect(r).toEqual({ shouldFallback: true, cooldownMs: 0 });
    expect(dbMocks.updateProviderConnectionUnscoped).not.toHaveBeenCalled();

    const decide = mutateProviderConnectionUnscoped.mock.calls[0][1];
    const patch = decide(conn);
    expect(patch.reauthRequired).toMatchObject({
      reason: "access_token_expired",
      code: "token_expired",
    });
    expect(patch).toMatchObject({ testStatus: "error", lastError: "Token expired" });
    // A re-imported / rotated token, or an already flagged row, is left alone.
    expect(decide({ ...conn, accessToken: "newer" })).toBeNull();
    expect(decide({ ...conn, reauthRequired: flag() })).toBeNull();
  });

  it("falls back with no writes for an already flagged oauth row", async () => {
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([
      oauth("c1", { reauthRequired: flag() }),
    ]);
    const r = await markAccountUnavailable("c1", 401, "unauthorized", "codex", "gpt-5");
    expect(r).toEqual({ shouldFallback: true, cooldownMs: 0 });
    expect(mutateProviderConnectionUnscoped).not.toHaveBeenCalled();
    expect(dbMocks.updateProviderConnectionUnscoped).not.toHaveBeenCalled();
  });

  it("keeps the 2-minute model lock for a plain codex oauth 401", async () => {
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([oauth("c1")]);
    dbMocks.updateProviderConnectionUnscoped.mockResolvedValue(null);
    const r = await markAccountUnavailable("c1", 401, "unauthorized", "codex", "gpt-5");
    expect(r.shouldFallback).toBe(true);
    expect(r.cooldownMs).toBeGreaterThan(0);
    expect(mutateProviderConnectionUnscoped).not.toHaveBeenCalled();
    expect(dbMocks.updateProviderConnectionUnscoped).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ testStatus: "unavailable" }),
    );
  });

  it("never writes the owner's row for a grantee failure", async () => {
    const r = await markAccountUnavailable("a1", 401, TOKEN_EXPIRED, "codex", "gpt-5", null, {
      grantId: "g1",
    });
    expect(r.shouldFallback).toBe(true);
    expect(mutateProviderConnectionUnscoped).not.toHaveBeenCalled();
    expect(dbMocks.updateProviderConnectionUnscoped).not.toHaveBeenCalled();
  });
});

const fakeJwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
const expiredJwt = () => fakeJwt({ exp: Math.floor((Date.now() - HOUR) / 1000) });
const liveJwt = () => fakeJwt({ exp: Math.floor((Date.now() + HOUR) / 1000) });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("H1: selection lazily persists the flag for expired access-token-only rows", () => {
  it("schedules a conditional flag write (no expiresAt, expired JWT) without blocking selection", async () => {
    const dead = accessTokenRow("dead", { accessToken: expiredJwt(), expiresAt: undefined });
    const live = accessTokenRow("live", { accessToken: liveJwt(), priority: 2 });
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([dead, live]);
    mutateProviderConnectionUnscoped.mockResolvedValue({ applied: true, missing: false });

    expect(idOf(await getProviderCredentials("codex", null, "gpt-5"))).toBe("live");
    await flush();

    expect(mutateProviderConnectionUnscoped).toHaveBeenCalledTimes(1);
    expect(mutateProviderConnectionUnscoped.mock.calls[0][0]).toBe("dead");
    const decide = mutateProviderConnectionUnscoped.mock.calls[0][1];
    const patch = decide(dead);
    expect(patch.reauthRequired).toMatchObject({ reason: "access_token_expired" });
    expect(patch).toMatchObject({ testStatus: "error", lastError: "Token expired" });
    // Guards: re-imported token, already flagged, or a refresh token appeared.
    expect(decide({ ...dead, accessToken: liveJwt() })).toBeNull();
    expect(decide({ ...dead, reauthRequired: flag() })).toBeNull();
    expect(decide({ ...dead, refreshToken: "rt-new" })).toBeNull();
  });

  it("never fails or rejects selection when the lazy write throws", async () => {
    const dead = accessTokenRow("dead", { accessToken: expiredJwt(), expiresAt: undefined });
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([dead, accessTokenRow("live")]);
    mutateProviderConnectionUnscoped.mockRejectedValue(new Error("db down"));
    expect(idOf(await getProviderCredentials("codex", null, "gpt-5"))).toBe("live");
    await flush();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("backs off per connection after a failed write, so selection does not warn on every request", async () => {
    const dead = accessTokenRow("cool", { accessToken: expiredJwt(), expiresAt: undefined });
    const other = accessTokenRow("cool-2", { accessToken: expiredJwt(), expiresAt: undefined });
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([dead, accessTokenRow("live")]);
    mutateProviderConnectionUnscoped.mockRejectedValue(new Error("db down"));

    await getProviderCredentials("codex", null, "gpt-5");
    await flush();
    await getProviderCredentials("codex", null, "gpt-5");
    await flush();
    await getProviderCredentials("codex", null, "gpt-5");
    await flush();
    // One attempt and one warning within the cooldown window.
    expect(mutateProviderConnectionUnscoped).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // Another connection is not affected by the first one's cooldown.
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([other, accessTokenRow("live")]);
    await getProviderCredentials("codex", null, "gpt-5");
    await flush();
    expect(mutateProviderConnectionUnscoped).toHaveBeenCalledTimes(2);

    // After the cooldown the write is retried.
    const realNow = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(realNow + 61_000);
    try {
      dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([dead, accessTokenRow("live")]);
      await getProviderCredentials("codex", null, "gpt-5");
      await flush();
    } finally {
      spy.mockRestore();
    }
    expect(mutateProviderConnectionUnscoped).toHaveBeenCalledTimes(3);
  });

  it("does not schedule a write for an already flagged or healthy row", async () => {
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([
      oauth("c1", { reauthRequired: flag() }),
      accessTokenRow("ok"),
    ]);
    await getProviderCredentials("codex", null, "gpt-5");
    await flush();
    expect(mutateProviderConnectionUnscoped).not.toHaveBeenCalled();
  });
});

describe("M6: a failing flag write falls through to the ordinary lock path", () => {
  it("logs without token material and returns the normal model-lock result", async () => {
    const conn = accessTokenRow("a1", { accessToken: "SECRET-AT-VALUE" });
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([conn]);
    dbMocks.updateProviderConnectionUnscoped.mockResolvedValue(null);
    mutateProviderConnectionUnscoped.mockRejectedValue(new Error("db down"));

    const r = await markAccountUnavailable(
      "a1",
      401,
      JSON.stringify({ error: { code: "token_expired" } }),
      "codex",
      "gpt-5",
    );
    expect(r.shouldFallback).toBe(true);
    expect(r.cooldownMs).toBeGreaterThan(0);
    expect(dbMocks.updateProviderConnectionUnscoped).toHaveBeenCalledWith(
      "a1",
      expect.objectContaining({ testStatus: "unavailable" }),
    );
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain("db down");
    expect(logged).not.toContain("SECRET-AT-VALUE");
  });
});

describe("M4: REAUTH_SKIP is a debug line", () => {
  it("does not log REAUTH_SKIP at info level", async () => {
    dbMocks.getProviderConnectionsUnscoped.mockResolvedValue([
      oauth("c1", { reauthRequired: flag() }),
      oauth("c2", { priority: 2 }),
    ]);
    await getProviderCredentials("codex", null, "gpt-5");
    expect(logger.info.mock.calls.flat().join(" ")).not.toContain("REAUTH_SKIP");
    expect(logger.debug.mock.calls.flat().join(" ")).toContain("REAUTH_SKIP");
  });
});
