import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProxyPoolById: vi.fn(),
  updateProxyPool: vi.fn(),
  fetch: vi.fn(),
  probeRelayVersion: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200 }) },
}));
vi.mock("@/models", () => ({
  getProxyPoolById: mocks.getProxyPoolById,
  updateProxyPool: mocks.updateProxyPool,
}));
vi.mock("undici", () => ({ fetch: mocks.fetch }));
vi.mock("open-sse/utils/proxyFetch.js", async (importOriginal) => ({
  ...(await importOriginal()),
  probeRelayVersion: mocks.probeRelayVersion,
}));

import { POST } from "../../src/app/api/proxy-pools/[id]/test/route.js";

const context = { params: Promise.resolve({ id: "relay-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProxyPoolById.mockResolvedValue({
    id: "relay-1",
    type: "vercel",
    proxyUrl: "https://relay.example.com/forward",
  });
  mocks.updateProxyPool.mockResolvedValue({});
  mocks.probeRelayVersion.mockResolvedValue(2);
});

describe("relay pool test version status", () => {
  it("flags an old relay from the version probe while reachability succeeds", async () => {
    mocks.fetch.mockResolvedValue(new Response("{}", { status: 200 }));
    mocks.probeRelayVersion.mockResolvedValue(0);

    const response = await POST(new Request("http://localhost"), context);

    expect(response.body).toMatchObject({
      ok: true,
      status: 200,
      error: "Relay template is outdated — redeploy it",
      relayOutdated: true,
    });
    expect(mocks.updateProxyPool).toHaveBeenCalledWith(
      "relay-1",
      expect.objectContaining({
        testStatus: "active",
        isActive: true,
        lastError: "Relay template is outdated — redeploy it",
      }),
    );
    expect(mocks.probeRelayVersion).toHaveBeenCalledWith("https://relay.example.com/forward", {
      fresh: true,
      signal: expect.any(AbortSignal),
    });
  });

  it("flags an old probe version", async () => {
    mocks.fetch.mockResolvedValue(new Response("{}", { status: 200 }));
    mocks.probeRelayVersion.mockResolvedValue(1);

    const response = await POST(new Request("http://localhost"), context);

    expect(response.body).toMatchObject({ ok: true, relayOutdated: true });
  });

  it("clears the redeploy notice after a current relay probe passes", async () => {
    mocks.fetch.mockResolvedValue(new Response("{}", { status: 200 }));

    const response = await POST(new Request("http://localhost"), context);

    expect(response.body).toMatchObject({ ok: true, error: null, relayOutdated: false });
    expect(mocks.updateProxyPool).toHaveBeenCalledWith(
      "relay-1",
      expect.objectContaining({ testStatus: "active", lastError: null }),
    );
  });

  it("keeps a failed test's actual failure instead of replacing it with a version notice", async () => {
    mocks.fetch.mockResolvedValue(new Response("no", { status: 503, statusText: "Unavailable" }));

    const response = await POST(new Request("http://localhost"), context);

    expect(response.body).toMatchObject({ ok: false, status: 503 });
    expect(mocks.updateProxyPool).toHaveBeenCalledWith(
      "relay-1",
      expect.objectContaining({
        testStatus: "error",
        lastError: "Proxy test failed with status 503",
      }),
    );
  });
});
