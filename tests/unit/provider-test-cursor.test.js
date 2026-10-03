/**
 * Cursor connection test probes DashboardService/GetCurrentPeriodUsage (Connect-RPC JSON)
 * and, on 401/403, refreshes via the runtime refresher, retries once and persists tokens.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = global.fetch;
const USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const REFRESH_URL = "https://api2.cursor.sh/oauth/token";

function jsonResponse(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function cursorConnection(fields = {}) {
  return {
    id: "cursor-1",
    provider: "cursor",
    authType: "oauth",
    accessToken: "old-access",
    refreshToken: "old-refresh",
    // Beyond Cursor's 24h refresh lead so the probe, not expiry, drives refresh.
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    ...fields,
  };
}

async function runTest(connection, responses) {
  const fetchMock = vi.fn();
  for (const res of responses) fetchMock.mockResolvedValueOnce(res);
  global.fetch = fetchMock;
  const updates = [];
  vi.doMock("@/lib/localDb", () => ({
    getProviderConnectionByIdUnscoped: vi.fn(async () => connection),
    updateProviderConnectionUnscoped: vi.fn(async (_id, data) => updates.push(data)),
  }));
  // proxyFetch.js patches globalThis.fetch on import and DNS-bypasses Cursor hosts
  // (real network); replace it wholesale so every call hits the mock.
  vi.doMock("open-sse/utils/proxyFetch.js", () => ({
    proxyAwareFetch: (url, opts) => fetchMock(url, opts),
    default: fetchMock,
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

describe("cursor connection test", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("@/lib/localDb");
    vi.doUnmock("@/lib/network/connectionProxy");
    vi.doUnmock("open-sse/utils/proxyFetch.js");
    global.fetch = originalFetch;
  });

  it("probes GetCurrentPeriodUsage and reports valid on 200", async () => {
    const { result, fetchMock, updates } = await runTest(cursorConnection(), [
      jsonResponse(200, { planUsage: {} }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(USAGE_URL);
    expect(opts.method).toBe("POST");
    expect(opts.body).toBe("{}");
    expect(opts.headers).toMatchObject({
      Authorization: "Bearer old-access",
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    });
    expect(result).toMatchObject({ valid: true, refreshed: false });
    expect(updates[0]).toMatchObject({ testStatus: "active" });
    expect(updates[0].accessToken).toBeUndefined();
  });

  it.each([401, 403])("refreshes on %i, retries once and persists new tokens", async (status) => {
    const { result, fetchMock, updates } = await runTest(cursorConnection(), [
      jsonResponse(status),
      jsonResponse(200, { access_token: "new-access" }),
      jsonResponse(200, { planUsage: {} }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe(REFRESH_URL);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).refresh_token).toBe("old-refresh");
    expect(fetchMock.mock.calls[2][0]).toBe(USAGE_URL);
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe("Bearer new-access");
    expect(result).toMatchObject({ valid: true, refreshed: true });
    expect(updates[0]).toMatchObject({
      testStatus: "active",
      accessToken: "new-access",
      refreshToken: "new-access",
    });
  });

  it("reports invalid without refreshing when no refresh token is stored", async () => {
    const { result, fetchMock } = await runTest(cursorConnection({ refreshToken: null }), [
      jsonResponse(403),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ valid: false, error: "Access denied" });
  });

  it("reports invalid when Cursor rejects the session on refresh", async () => {
    const { result, fetchMock, updates } = await runTest(cursorConnection(), [
      jsonResponse(401),
      jsonResponse(200, { access_token: "", shouldLogout: true }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ valid: false, error: "Token invalid or revoked" });
    expect(updates[0]).toMatchObject({ testStatus: "error" });
    expect(updates[0].accessToken).toBeUndefined();
  });

  it("refreshes a near-expiry session before probing", async () => {
    const { result, fetchMock, updates } = await runTest(
      cursorConnection({ expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      [jsonResponse(200, { access_token: "new-access" }), jsonResponse(200, {})],
    );

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([REFRESH_URL, USAGE_URL]);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer new-access");
    expect(result).toMatchObject({ valid: true, refreshed: true });
    expect(updates[0]).toMatchObject({ accessToken: "new-access" });
  });

  it("does not refresh on non-auth failures", async () => {
    const { result, fetchMock } = await runTest(cursorConnection(), [jsonResponse(500)]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ valid: false, error: "API returned 500" });
  });
});
