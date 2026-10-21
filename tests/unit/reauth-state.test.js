// YAN-1037/1038 Lane 0: pure re-authentication state helpers, constants, the
// injected credential-store slot and the codex registry flag.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const HOUR = 3600 * 1000;

const fakeJwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
const jwtExpiringIn = (ms) => fakeJwt({ exp: Math.floor((NOW + ms) / 1000) });

let mod;
let consts;
let storeMod;

beforeEach(async () => {
  vi.resetModules();
  mod = await import("../../open-sse/services/reauthState.js");
  consts = await import("../../open-sse/config/reauthConstants.js");
  storeMod = await import("../../open-sse/services/credentialStore.js");
});

afterEach(() => {
  storeMod?.setCredentialStore(null);
});

describe("reauthConstants", () => {
  it("freezes the contract values", () => {
    expect(consts.REAUTH_REASONS).toEqual({
      refreshTokenRejected: "refresh_token_rejected",
      accessTokenExpired: "access_token_expired",
    });
    expect(consts.REAUTH_CODES).toEqual([
      "refresh_token_expired",
      "refresh_token_reused",
      "refresh_token_invalidated",
      "invalid_grant",
      "token_expired",
      "unknown",
    ]);
    expect(consts.REAUTH_LAST_ERROR).toEqual({
      refresh_token_rejected: "Token expired and refresh failed",
      access_token_expired: "Token expired",
    });
    expect(consts.REAUTH_ERROR_TYPE).toEqual({
      refresh_token_rejected: "token_refresh_failed",
      access_token_expired: "token_expired",
    });
    expect(consts.UNRECOVERABLE_REFRESH_ERROR).toBe("unrecoverable_refresh_error");
    expect(Object.isFrozen(consts.REAUTH_REASONS)).toBe(true);
    expect(Object.isFrozen(consts.REAUTH_CODES)).toBe(true);
  });

  it("lastError strings match the CREDENTIAL_FAILURES keys used by the dashboard", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../src/shared/utils/providerHealth.js", import.meta.url), "utf8"),
    );
    expect(src).toContain(`"${consts.REAUTH_LAST_ERROR.refresh_token_rejected}"`);
    expect(src).toContain(`"${consts.REAUTH_LAST_ERROR.access_token_expired}"`);
  });
});

describe("buildReauthRequired", () => {
  it("builds the persisted object with an ISO timestamp", () => {
    const r = mod.buildReauthRequired({
      reason: "refresh_token_rejected",
      code: "refresh_token_reused",
      nowMs: NOW,
    });
    expect(r).toEqual({
      reason: "refresh_token_rejected",
      code: "refresh_token_reused",
      at: new Date(NOW).toISOString(),
    });
  });

  it("coerces codes outside the allowlist to unknown (never raw upstream text)", () => {
    const r = mod.buildReauthRequired({
      reason: "refresh_token_rejected",
      code: "Bearer sk-secret leaked text",
      nowMs: NOW,
    });
    expect(r.code).toBe("unknown");
    expect(mod.buildReauthRequired({ reason: "access_token_expired" }).code).toBe("unknown");
  });

  it("defaults at to now", () => {
    const r = mod.buildReauthRequired({ reason: "access_token_expired", code: "token_expired" });
    expect(Number.isFinite(Date.parse(r.at))).toBe(true);
    expect(new Date(r.at).toISOString()).toBe(r.at);
  });
});

describe("getReauthRequired", () => {
  const valid = {
    reason: "refresh_token_rejected",
    code: "refresh_token_reused",
    at: "2026-08-01T12:00:00.000Z",
  };

  it("returns the validated object", () => {
    expect(mod.getReauthRequired({ reauthRequired: valid })).toEqual(valid);
  });

  it("ignores missing, malformed or unknown-reason values", () => {
    expect(mod.getReauthRequired(null)).toBeNull();
    expect(mod.getReauthRequired(undefined)).toBeNull();
    expect(mod.getReauthRequired({})).toBeNull();
    expect(mod.getReauthRequired({ reauthRequired: "yes" })).toBeNull();
    expect(mod.getReauthRequired({ reauthRequired: true })).toBeNull();
    expect(
      mod.getReauthRequired({ reauthRequired: { reason: "nope", code: "unknown" } }),
    ).toBeNull();
    expect(mod.getReauthRequired({ reauthRequired: {} })).toBeNull();
  });

  it("normalises an unlisted code to unknown", () => {
    const r = mod.getReauthRequired({ reauthRequired: { ...valid, code: "weird" } });
    expect(r).toMatchObject({ reason: "refresh_token_rejected", code: "unknown" });
  });
});

describe("isAccessTokenOnlyExpired", () => {
  it("is true for a codex access-token-only row whose JWT is expired", () => {
    const c = { accessToken: jwtExpiringIn(-HOUR) };
    expect(mod.isAccessTokenOnlyExpired("codex", c, NOW)).toBe(true);
  });

  it("is true at exactly the expiry instant (<= now)", () => {
    const c = { accessToken: jwtExpiringIn(0) };
    expect(mod.isAccessTokenOnlyExpired("codex", c, NOW)).toBe(true);
  });

  it("is false while the token is still valid", () => {
    const c = { accessToken: jwtExpiringIn(HOUR) };
    expect(mod.isAccessTokenOnlyExpired("codex", c, NOW)).toBe(false);
  });

  it("is false when a refresh token exists", () => {
    const c = { accessToken: jwtExpiringIn(-HOUR), refreshToken: "rt" };
    expect(mod.isAccessTokenOnlyExpired("codex", c, NOW)).toBe(false);
  });

  it("is false for a non lifetime-aware provider", () => {
    const c = { accessToken: jwtExpiringIn(-HOUR), expiresAt: new Date(NOW - HOUR).toISOString() };
    expect(mod.isAccessTokenOnlyExpired("claude", c, NOW)).toBe(false);
  });

  it("is false without an access token or with unknown expiry", () => {
    expect(mod.isAccessTokenOnlyExpired("codex", {}, NOW)).toBe(false);
    expect(mod.isAccessTokenOnlyExpired("codex", null, NOW)).toBe(false);
    expect(mod.isAccessTokenOnlyExpired("codex", { accessToken: "opaque" }, NOW)).toBe(false);
  });

  it("uses the stored expiresAt when the token is not a JWT", () => {
    const c = { accessToken: "opaque", expiresAt: new Date(NOW - 1000).toISOString() };
    expect(mod.isAccessTokenOnlyExpired("codex", c, NOW)).toBe(true);
  });

  it("uses the JWT exp even when the stored expiresAt is later", () => {
    const c = {
      accessToken: jwtExpiringIn(-HOUR),
      expiresAt: new Date(NOW + 24 * HOUR).toISOString(),
    };
    expect(mod.isAccessTokenOnlyExpired("codex", c, NOW)).toBe(true);
  });
});

describe("needsReauthentication", () => {
  it("is true for a flagged connection", () => {
    const conn = {
      refreshToken: "rt",
      reauthRequired: { reason: "refresh_token_rejected", code: "refresh_token_reused", at: "x" },
    };
    expect(mod.needsReauthentication("codex", conn, NOW)).toBe(true);
  });

  it("is true for an expired access-token-only codex row without a flag", () => {
    expect(mod.needsReauthentication("codex", { accessToken: jwtExpiringIn(-HOUR) }, NOW)).toBe(
      true,
    );
  });

  it("is false for an oauth row with an expired AT but a live RT", () => {
    const conn = { accessToken: jwtExpiringIn(-HOUR), refreshToken: "rt" };
    expect(mod.needsReauthentication("codex", conn, NOW)).toBe(false);
  });

  it("is false for a healthy row and for a non-lifetime provider", () => {
    expect(mod.needsReauthentication("codex", { accessToken: jwtExpiringIn(HOUR) }, NOW)).toBe(
      false,
    );
    expect(mod.needsReauthentication("claude", { accessToken: jwtExpiringIn(-HOUR) }, NOW)).toBe(
      false,
    );
  });
});

describe("buildReauthPatch", () => {
  it("builds the refresh-rejected patch", () => {
    const flag = mod.buildReauthRequired({
      reason: "refresh_token_rejected",
      code: "refresh_token_reused",
      nowMs: NOW,
    });
    expect(mod.buildReauthPatch(flag, NOW)).toEqual({
      reauthRequired: flag,
      testStatus: "error",
      lastError: "Token expired and refresh failed",
      lastErrorType: "token_refresh_failed",
      lastErrorAt: new Date(NOW).toISOString(),
      errorCode: 401,
    });
  });

  it("builds the access-token-expired patch", () => {
    const flag = mod.buildReauthRequired({
      reason: "access_token_expired",
      code: "token_expired",
      nowMs: NOW,
    });
    expect(mod.buildReauthPatch(flag, NOW)).toMatchObject({
      reauthRequired: flag,
      testStatus: "error",
      lastError: "Token expired",
      lastErrorType: "token_expired",
      errorCode: 401,
    });
  });
});

describe("credentialStore slot", () => {
  it("round-trips and resets with null", () => {
    expect(storeMod.getCredentialStore()).toBeNull();
    const store = { load: vi.fn(), persistRefresh: vi.fn(), markReauthRequired: vi.fn() };
    storeMod.setCredentialStore(store);
    expect(storeMod.getCredentialStore()).toBe(store);
    storeMod.setCredentialStore(null);
    expect(storeMod.getCredentialStore()).toBeNull();
    storeMod.setCredentialStore(undefined);
    expect(storeMod.getCredentialStore()).toBeNull();
  });

  it("is shared across duplicate module copies via globalThis", async () => {
    const store = { load: vi.fn() };
    storeMod.setCredentialStore(store);
    vi.resetModules();
    const copy = await import("../../open-sse/services/credentialStore.js");
    expect(copy).not.toBe(storeMod);
    expect(copy.getCredentialStore()).toBe(store);
    expect(globalThis[Symbol.for("tokenhop.credentialStore")]).toBe(store);
  });
});

describe("registry flag", () => {
  it("marks codex as rotatingRefreshToken; every such provider is lifetime-aware or has a refresh endpoint", async () => {
    const { PROVIDER_OAUTH } = await import("../../open-sse/providers/index.js");
    expect(PROVIDER_OAUTH.codex.rotatingRefreshToken).toBe(true);
    for (const [id, oauth] of Object.entries(PROVIDER_OAUTH)) {
      if (oauth.rotatingRefreshToken !== true) continue;
      expect(
        oauth.lifetimeAware === true || Boolean(oauth.refreshUrl || oauth.tokenUrl),
        `${id} rotates refresh tokens but is neither lifetime-aware nor refreshable`,
      ).toBe(true);
    }
  });
});
