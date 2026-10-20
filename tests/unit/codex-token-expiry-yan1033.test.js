// YAN-1033: Codex expiresAt must honour the access token's JWT `exp` claim
// (min(now + expires_in, exp)) at login, bulk import, refresh and on load, and
// legacy rows without expiresAt derive it from the JWT on load and are still scheduled.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const fakeJwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
const jwtExpiringIn = (ms, extra = {}) =>
  fakeJwt({ exp: Math.floor((NOW + ms) / 1000), iat: Math.floor(NOW / 1000), ...extra });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("computeExpiresAt helper", () => {
  it("prefers the JWT exp when it is earlier than now + expires_in", async () => {
    const { computeExpiresAt } = await import("../../open-sse/services/tokenLifetime.js");
    const at = jwtExpiringIn(2 * HOUR);
    expect(computeExpiresAt({ expiresIn: 10 * 24 * 3600, accessToken: at, nowMs: NOW })).toBe(
      new Date(NOW + 2 * HOUR).toISOString(),
    );
  });

  it("keeps now + expires_in when it is earlier than the JWT exp", async () => {
    const { computeExpiresAt } = await import("../../open-sse/services/tokenLifetime.js");
    const at = jwtExpiringIn(5 * DAY);
    expect(computeExpiresAt({ expiresIn: 3600, accessToken: at, nowMs: NOW })).toBe(
      new Date(NOW + HOUR).toISOString(),
    );
  });

  it("uses the JWT exp when there is no expires_in, and null when neither exists", async () => {
    const { computeExpiresAt } = await import("../../open-sse/services/tokenLifetime.js");
    expect(computeExpiresAt({ accessToken: jwtExpiringIn(3 * HOUR), nowMs: NOW })).toBe(
      new Date(NOW + 3 * HOUR).toISOString(),
    );
    expect(computeExpiresAt({ accessToken: "opaque", nowMs: NOW })).toBeNull();
  });
});

describe("raw codex refresh result", () => {
  it("reports expiresIn clamped to the JWT exp", async () => {
    const at = jwtExpiringIn(2 * HOUR);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: at, expires_in: 864000 }),
    });
    const { refreshCodexToken } = await import("../../open-sse/services/tokenRefresh.js");
    const result = await refreshCodexToken("rt-clamp", null);
    expect(result.expiresIn).toBe(2 * 3600);
  });
});

describe("login mapping (codex mapTokens)", () => {
  it("stores the JWT exp when earlier than expires_in", async () => {
    const { default: codex } = await import("../../src/lib/oauth/providers/codex.js");
    const mapped = codex.mapTokens({
      access_token: jwtExpiringIn(2 * HOUR),
      refresh_token: "rt",
      id_token: "x.y.z",
      expires_in: 10 * 24 * 3600,
    });
    expect(mapped.expiresAt).toBe(new Date(NOW + 2 * HOUR).toISOString());
    expect(mapped.expiresIn).toBe(2 * 3600);
  });
});

describe("refresh merge (mergeRefreshedCredentials)", () => {
  it("stores min(now + expires_in, JWT exp) for codex and keeps expiresIn consistent", async () => {
    const { mergeRefreshedCredentials } = await import(
      "../../open-sse/services/oauthCredentialManager.js"
    );
    const merged = mergeRefreshedCredentials(
      "codex",
      { refreshToken: "rt" },
      { accessToken: jwtExpiringIn(90 * 60 * 1000), expiresIn: 10 * 24 * 3600 },
      NOW,
    );
    expect(merged.expiresAt).toBe(new Date(NOW + 90 * 60 * 1000).toISOString());
    expect(merged.expiresIn).toBe(90 * 60);
  });

  it("does not apply JWT clamping to other providers", async () => {
    const { mergeRefreshedCredentials } = await import(
      "../../open-sse/services/oauthCredentialManager.js"
    );
    const merged = mergeRefreshedCredentials(
      "claude",
      { refreshToken: "rt" },
      { accessToken: jwtExpiringIn(HOUR), expiresIn: 8 * 3600 },
      NOW,
    );
    expect(merged.expiresAt).toBe(new Date(NOW + 8 * HOUR).toISOString());
  });
});

describe("persistence keeps the clamped expiry", () => {
  it("updateProviderCredentials writes the merged expiresAt and derives expiresIn from it", async () => {
    const update = vi.fn(async () => ({ id: "c1" }));
    vi.doMock("@/lib/localDb.js", () => ({ updateProviderConnectionUnscoped: update }));
    const { updateProviderCredentials } = await import("../../src/sse/services/tokenRefresh.js");
    const expiresAt = new Date(NOW + 2 * HOUR).toISOString();
    await updateProviderCredentials("c1", { accessToken: "a", expiresAt });
    expect(update.mock.calls[0][1].expiresAt).toBe(expiresAt);
    expect(update.mock.calls[0][1].expiresIn).toBe(2 * 3600);
    vi.doUnmock("@/lib/localDb.js");
  });
});

describe("load-time derivation and background selection", () => {
  const codexConn = (over = {}) => ({
    id: "c1",
    provider: "codex",
    authType: "oauth",
    refreshToken: "rt",
    isActive: true,
    ...over,
  });

  it("derives expiry from the access token when expiresAt is missing", async () => {
    const { getCredentialExpiryMs } = await import(
      "../../open-sse/services/oauthCredentialManager.js"
    );
    const accessToken = jwtExpiringIn(4 * HOUR);
    expect(getCredentialExpiryMs({ accessToken }, "codex")).toBe(NOW + 4 * HOUR);
    expect(getCredentialExpiryMs({ accessToken }, "claude")).toBeNull();
  });

  it("selects a codex connection with no expiresAt once within the lead window", async () => {
    const { selectConnectionsNeedingRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    const due = codexConn({ accessToken: jwtExpiringIn(60 * 1000), lastRefreshAt: null });
    const farOff = codexConn({ id: "c2", accessToken: jwtExpiringIn(9 * DAY) });
    const list = selectConnectionsNeedingRefresh([due, farOff], NOW);
    expect(list.map((c) => c.id)).toEqual(["c1"]);
  });

  it("caps a stored expiresAt that is later than the token's JWT exp", async () => {
    const { getCredentialExpiryMs } = await import(
      "../../open-sse/services/oauthCredentialManager.js"
    );
    const creds = {
      accessToken: jwtExpiringIn(HOUR),
      expiresAt: new Date(NOW + 10 * DAY).toISOString(),
    };
    expect(getCredentialExpiryMs(creds, "codex")).toBe(NOW + HOUR);
  });
});

describe("codex live-model refresh persistence", () => {
  it("stamps lastRefreshAt alongside the clamped expiresIn", async () => {
    const update = vi.fn(async () => true);
    vi.doMock("@/sse/services/tokenRefresh", () => ({
      updateProviderCredentials: update,
      refreshCodexToken: vi.fn(async () => ({
        accessToken: "new",
        refreshToken: "rt2",
        expiresIn: 3600,
      })),
    }));
    const { buildOAuthResolver } = await import("../../src/lib/providerModels/oauthResolver.js");
    const resolve = buildOAuthResolver({
      refreshFn: async () => ({
        accessToken: "new",
        refreshToken: "rt2",
        expiresIn: 3600,
        lastRefreshAt: new Date(NOW).toISOString(),
      }),
      fetchFn: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 401, text: async () => "" })
        .mockResolvedValue({ ok: true, json: async () => ({ models: [] }) }),
      parseFn: () => [],
      errorLabel: "x",
    });
    await resolve({ id: "c1", accessToken: "old", refreshToken: "rt" });
    expect(update.mock.calls[0][1]).toMatchObject({
      accessToken: "new",
      expiresIn: 3600,
      lastRefreshAt: new Date(NOW).toISOString(),
    });
    vi.doUnmock("@/sse/services/tokenRefresh");
  });
});

describe("bulk import route", () => {
  it("writes expiresAt = min(expiresIn, JWT exp) and derives it from the JWT alone", async () => {
    const createIn = vi.fn(async (_scope, data) => ({
      id: `id-${createIn.mock.calls.length}`,
      ...data,
    }));
    vi.doMock("@/lib/oauth/scope", () => ({ oauthScope: async () => null, createIn }));
    vi.doMock("@/lib/oauth/providers", () => ({ extractCodexAccountInfo: () => ({}) }));
    const { POST } = await import("../../src/app/api/oauth/codex/bulk-import/route.js");
    const res = await POST(
      new Request("http://x/api/oauth/codex/bulk-import", {
        method: "POST",
        body: JSON.stringify([
          { accessToken: jwtExpiringIn(2 * HOUR), refreshToken: "r1", expiresIn: 864000 },
          { accessToken: jwtExpiringIn(5 * HOUR), refreshToken: "r2" },
        ]),
      }),
    );
    expect((await res.json()).success).toBe(2);
    expect(createIn.mock.calls[0][1].expiresAt).toBe(new Date(NOW + 2 * HOUR).toISOString());
    expect(createIn.mock.calls[1][1].expiresAt).toBe(new Date(NOW + 5 * HOUR).toISOString());
    vi.doUnmock("@/lib/oauth/scope");
    vi.doUnmock("@/lib/oauth/providers");
  });
});

describe("access-token import route", () => {
  it("also writes expiresAt from the JWT exp", async () => {
    const createIn = vi.fn(async (_scope, data) => ({ id: "id-1", ...data }));
    vi.doMock("@/lib/oauth/scope", () => ({ oauthScope: async () => null, createIn }));
    vi.doMock("@/lib/oauth/providers", () => ({ extractCodexAccountInfo: () => ({}) }));
    const { POST } = await import("../../src/app/api/oauth/codex/import-token/route.js");
    const res = await POST(
      new Request("http://x/api/oauth/codex/import-token", {
        method: "POST",
        body: JSON.stringify({ accessToken: jwtExpiringIn(6 * HOUR) }),
      }),
    );
    expect((await res.json()).success).toBe(true);
    const data = createIn.mock.calls[0][1];
    expect(data.providerSpecificData.jwtExp).toBe(Math.floor((NOW + 6 * HOUR) / 1000));
    expect(data.expiresAt).toBe(new Date(NOW + 6 * HOUR).toISOString());
    vi.doUnmock("@/lib/oauth/scope");
    vi.doUnmock("@/lib/oauth/providers");
  });
});
