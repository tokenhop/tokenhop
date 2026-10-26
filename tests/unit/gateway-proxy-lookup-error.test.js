// YAN-1574: when the connection's proxy lookup fails, getProviderCredentials must
// not stamp all-off proxy options (which would send gateway calls direct, even for a
// Strict Proxy pool). The account is skipped like any other unavailable account.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connections: [],
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionsUnscoped: vi.fn(async () => mocks.connections),
  getProxyPools: vi.fn(async () => []),
  updateProviderConnectionUnscoped: vi.fn(),
}));
vi.mock("@/lib/db/index.js", () => ({
  getEffectivePreferences: vi.fn(async () => ({})),
  mutateBillingLockUnscoped: vi.fn(),
}));
vi.mock("@/lib/auth/gatewayResources.js", () => ({
  requireGatewayWorkspace: vi.fn(async () => {}),
  getGatewayConnections: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: { "free-public": { noAuth: true } },
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { getProviderCredentials } = await import("@/sse/services/auth.js");

const poolConfig = {
  source: "pool",
  proxyPoolId: "pool-1",
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://pool.example:8080",
  connectionNoProxy: "",
  strictProxy: true,
};
const lookupError = {
  source: "error",
  proxyPoolId: null,
  connectionProxyEnabled: false,
  connectionProxyUrl: "",
  connectionNoProxy: "",
  strictProxy: false,
};
const conn = (id, proxyPoolId, priority) => ({
  id,
  provider: "openai",
  isActive: true,
  priority,
  apiKey: `sk-${id}`,
  providerSpecificData: { proxyPoolId },
});

beforeEach(() => {
  mocks.connections = [];
  mocks.resolveConnectionProxyConfig.mockReset();
});

describe("getProviderCredentials proxy lookup failure", () => {
  it("skips the account whose lookup failed and serves the healthy one with its proxy", async () => {
    mocks.connections = [conn("broken", "pool-broken", 1), conn("healthy", "pool-1", 2)];
    mocks.resolveConnectionProxyConfig.mockImplementation(async (psd) =>
      psd.proxyPoolId === "pool-broken" ? lookupError : poolConfig,
    );

    const creds = await getProviderCredentials("openai");

    expect(creds.connectionId).toBe("healthy");
    expect(creds.providerSpecificData).toMatchObject({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://pool.example:8080",
      strictProxy: true,
      connectionProxyPoolId: "pool-1",
    });
  });

  it("returns no credentials when the only account's lookup failed (never all-off options)", async () => {
    mocks.connections = [conn("broken", "pool-broken", 1)];
    mocks.resolveConnectionProxyConfig.mockResolvedValue(lookupError);

    await expect(getProviderCredentials("openai")).resolves.toBeNull();
  });

  it("reports the account unavailable after a retry exclusion when the rest failed lookup", async () => {
    mocks.connections = [conn("a", "pool-1", 1), conn("broken", "pool-broken", 2)];
    mocks.resolveConnectionProxyConfig.mockImplementation(async (psd) =>
      psd.proxyPoolId === "pool-broken" ? lookupError : poolConfig,
    );

    await expect(getProviderCredentials("openai", new Set(["a"]))).resolves.toBeNull();
  });

  it("does not hand out a no-auth public provider when its proxy lookup failed", async () => {
    mocks.resolveConnectionProxyConfig.mockResolvedValue(lookupError);

    await expect(getProviderCredentials("free-public")).resolves.toBeNull();
  });
});
