import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalFetch = global.fetch;

async function testConnection(
  connection,
  fetchImpl = () => Promise.resolve(Response.json({})),
  proxy = {},
) {
  const updates = [];
  const fetchMock = vi.fn(fetchImpl);
  global.fetch = fetchMock;
  vi.doMock("@/lib/localDb", () => ({
    getProviderConnectionById: vi.fn(async () => connection),
    updateProviderConnection: vi.fn(async (_id, data) => updates.push(data)),
  }));
  vi.doMock("@/lib/network/connectionProxy", () => ({
    resolveConnectionProxyConfig: vi.fn(async () => proxy),
  }));
  const { testSingleConnection } = await import(
    "../../src/app/api/providers/[id]/test/testUtils.js"
  );
  const result = await testSingleConnection(connection.id);
  return { result, updates, fetchMock };
}

const connection = (provider, authType = "oauth") => ({
  id: `${provider}-1`,
  provider,
  authType,
  accessToken: "access-token",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  providerSpecificData: { userId: "zed-user" },
});

describe("provider connection tests for OAuth and imported keys", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.doUnmock("@/lib/localDb");
    vi.doUnmock("@/lib/network/connectionProxy");
    global.fetch = originalFetch;
  });

  it.each([
    ["xai", "https://api.x.ai/v1/models"],
    ["xiaomi-mimo", "https://api.xiaomimimo.com/v1/models"],
  ])("probes %s OAuth access token instead of marking it unsupported", async (provider, url) => {
    const { result, updates, fetchMock } = await testConnection(connection(provider));
    expect(result.valid).toBe(true);
    expect(updates[0].testStatus).toBe("active");
    expect(fetchMock).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer access-token" }),
      }),
    );
  });

  it("tests imported Xiaomi api_key from accessToken", async () => {
    const { result, updates, fetchMock } = await testConnection(
      connection("xiaomi-mimo", "api_key"),
    );
    expect(result.valid).toBe(true);
    expect(updates[0].testStatus).toBe("active");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer access-token");
  });

  it("probes Zed with its user ID and token, rejecting revoked credentials", async () => {
    const { result, updates, fetchMock } = await testConnection(connection("zed"), () =>
      Promise.resolve(new Response('{"message":"unauthorized"}', { status: 401 })),
    );
    expect(result.valid).toBe(false);
    expect(updates[0].testStatus).toBe("error");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("zed-user access-token");
  });

  it.each(["codebuddy-intl", "windsurf"])(
    "does not mark unprobeable %s tokens unsupported",
    async (provider) => {
      const { result, updates, fetchMock } = await testConnection(connection(provider));
      expect(result.valid).toBe(true);
      expect(updates[0].testStatus).toBe("active");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("sends the Zed probe through the connection's relay", async () => {
    const { result, fetchMock } = await testConnection(
      connection("zed"),
      () => Promise.resolve(Response.json({ id: 1 })),
      { vercelRelayUrl: "https://relay.example/" },
    );
    expect(result.valid).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("https://relay.example/");
    expect(fetchMock.mock.calls[0][1].headers["x-relay-path"]).toBe("/client/users/me");
  });

  it("reports expired Trae tokens without a refresh attempt", async () => {
    const { result, fetchMock } = await testConnection({
      ...connection("trae"),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(result).toMatchObject({ valid: false, error: "Token expired" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains that ClinePass OAuth tokens cannot be used", async () => {
    const { result, fetchMock } = await testConnection(connection("clinepass"));
    expect(result).toMatchObject({ valid: false, error: expect.stringContaining("API key") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [200, { valid: true, error: null }, "active"],
    [401, { valid: false, error: "Invalid API key" }, "error"],
  ])("probes ClinePass API keys via /users/me (%i)", async (status, expected, testStatus) => {
    const { result, updates, fetchMock } = await testConnection(
      { id: "clinepass-1", provider: "clinepass", authType: "apikey", apiKey: "clp_key" },
      () => Promise.resolve(Response.json({}, { status })),
    );
    expect(result).toMatchObject(expected);
    expect(updates[0].testStatus).toBe(testStatus);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.cline.bot/api/v1/users/me");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer clp_key");
  });

  it.each([
    [
      "codebuddy-intl",
      {
        code: 0,
        data: { accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 },
      },
    ],
  ])("refreshes near-expiry %s tokens via the runtime refresher", async (provider, body) => {
    const { result, updates } = await testConnection(
      {
        ...connection(provider),
        refreshToken: "old-refresh",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      () => Promise.resolve(Response.json(body)),
    );
    expect(result).toMatchObject({ valid: true, refreshed: true });
    expect(updates[0]).toMatchObject({ testStatus: "active", accessToken: "new-access" });
  });
});
