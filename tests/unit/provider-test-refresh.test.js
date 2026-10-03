/**
 * Connection-test refresh must use the runtime refreshers (YAN-111, YAN-110):
 * Kiro external_idp refresh tokens go only to the allowlisted Microsoft endpoint,
 * and Kimi near-expiry connections are refreshed instead of failing offline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = global.fetch;
const MS_TOKEN_URL = "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token";
const CLIENT_ID = "00000000-0000-4000-8000-000000000000";

async function runTest(connection, tokenResponse) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(tokenResponse),
    text: () => Promise.resolve(JSON.stringify(tokenResponse)),
  });
  global.fetch = fetchMock;
  const updates = [];
  vi.doMock("@/lib/localDb", () => ({
    getProviderConnectionByIdUnscoped: vi.fn(async () => connection),
    updateProviderConnectionUnscoped: vi.fn(async (_id, data) => updates.push(data)),
  }));
  vi.doMock("@/lib/network/connectionProxy", () => ({
    resolveConnectionProxyConfig: vi.fn(async () => ({})),
  }));
  const { testSingleConnection } = await import(
    "../../src/app/api/providers/[id]/test/testUtils.js"
  );
  const result = await testSingleConnection(connection.id);
  return { result, fetchMock, updates };
}

function nearExpiry(fields) {
  return {
    authType: "oauth",
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...fields,
  };
}

describe("connection test refresh uses runtime refreshers", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("@/lib/localDb");
    vi.doUnmock("@/lib/network/connectionProxy");
    global.fetch = originalFetch;
  });

  it("refreshes Kiro external_idp only at the Microsoft token endpoint", async () => {
    const { result, fetchMock, updates } = await runTest(
      nearExpiry({
        id: "kiro-1",
        provider: "kiro",
        providerSpecificData: {
          authMethod: "external_idp",
          clientId: CLIENT_ID,
          tokenEndpoint: MS_TOKEN_URL,
          scope: `api://${CLIENT_ID}/codewhisperer:conversations offline_access`,
        },
      }),
      { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(MS_TOKEN_URL);
    expect(result).toMatchObject({ valid: true, refreshed: true });
    expect(updates[0]).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
    expect(updates[0].providerSpecificData.authMethod).toBe("external_idp");
  });

  it("never sends a Kiro external_idp token to a non-allowlisted endpoint", async () => {
    const { result, fetchMock } = await runTest(
      nearExpiry({
        id: "kiro-2",
        provider: "kiro",
        providerSpecificData: {
          authMethod: "external_idp",
          clientId: CLIENT_ID,
          tokenEndpoint: "https://evil.example/token",
        },
      }),
      { access_token: "stolen" },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ valid: false, error: "Token expired and refresh failed" });
  });

  it.each(["kimi", "kimi-coding"])("refreshes a near-expiry %s connection", async (provider) => {
    const { result, fetchMock } = await runTest(
      nearExpiry({ id: `${provider}-1`, provider, providerSpecificData: { deviceId: "dev-1" } }),
      { access_token: "kimi-access", refresh_token: "kimi-refresh", expires_in: 86400 },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ valid: true, refreshed: true });
  });
});
