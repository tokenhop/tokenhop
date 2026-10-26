// YAN-1574: direct unit test of the real connectionProxyOptions — the pool
// lookup (getProxyPoolById) is the only thing mocked, so the real
// resolveConnectionProxyConfig + proxyOptionsFromConfig pipeline runs.
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ getProxyPoolById: vi.fn() }));

vi.mock("@/models", () => ({ getProxyPoolById: mocks.getProxyPoolById }));

import { connectionProxyOptions } from "../../src/lib/network/connectionProxy.js";

beforeEach(() => {
  mocks.getProxyPoolById.mockReset();
});

describe("connectionProxyOptions", () => {
  it("maps an active pool row to enabled options with strictProxy and pool id", async () => {
    mocks.getProxyPoolById.mockResolvedValue({
      isActive: true,
      proxyUrl: "http://pool.example:8080",
      noProxy: "localhost",
      strictProxy: true,
    });

    const options = await connectionProxyOptions({
      providerSpecificData: { proxyPoolId: "pool-1" },
    });

    expect(options).toEqual({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://pool.example:8080",
      connectionNoProxy: "localhost",
      vercelRelayUrl: "",
      strictProxy: true,
      connectionProxyPoolId: "pool-1",
    });
  });

  it("maps a relay pool (vercel) to vercelRelayUrl, not a proxy url", async () => {
    mocks.getProxyPoolById.mockResolvedValue({
      isActive: true,
      type: "vercel",
      proxyUrl: "https://relay.example.dev/proxy",
      noProxy: "",
      strictProxy: false,
    });

    const options = await connectionProxyOptions({
      providerSpecificData: { proxyPoolId: "relay-1" },
    });

    expect(options).toEqual({
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      vercelRelayUrl: "https://relay.example.dev/proxy",
      strictProxy: false,
      connectionProxyPoolId: "relay-1",
    });
  });

  it("returns null when the pool lookup throws (fail closed)", async () => {
    mocks.getProxyPoolById.mockRejectedValue(new Error("db down"));

    await expect(
      connectionProxyOptions({ providerSpecificData: { proxyPoolId: "pool-1" } }),
    ).resolves.toBeNull();
  });

  it("returns all-off options when no pool is configured", async () => {
    const options = await connectionProxyOptions({
      providerSpecificData: { proxyPoolId: "__none__" },
    });

    expect(options).toEqual({
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      vercelRelayUrl: "",
      strictProxy: false,
      connectionProxyPoolId: null,
    });
    expect(mocks.getProxyPoolById).not.toHaveBeenCalled();
  });

  it("falls back to legacy per-connection proxy fields", async () => {
    const options = await connectionProxyOptions({
      providerSpecificData: {
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://legacy.example:3128",
        connectionNoProxy: "internal.example",
        strictProxy: true,
      },
    });

    expect(options).toEqual({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://legacy.example:3128",
      connectionNoProxy: "internal.example",
      vercelRelayUrl: "",
      // Legacy per-connection fields don't carry strictProxy; only pools do.
      strictProxy: false,
      connectionProxyPoolId: null,
    });
    expect(mocks.getProxyPoolById).not.toHaveBeenCalled();
  });
});
