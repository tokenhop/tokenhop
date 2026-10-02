// YAN-651: strictProxy must never fall back to a direct connection when the
// pool proxy is down. proxyFetch captures globalThis.fetch at import as its
// fallback, so stub it before importing and keep the test offline.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchStub = vi.fn(async (_url, options = {}) => {
  if (options?.dispatcher) throw new Error("connect ECONNREFUSED 127.0.0.1:9");
  return new Response("direct", { status: 200 });
});
globalThis.fetch = fetchStub;

const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

const STRICT_POOL = {
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://127.0.0.1:9",
  connectionNoProxy: "",
  strictProxy: true,
  connectionProxyPoolId: "pool-1",
};

describe("strictProxy enforcement (YAN-651)", () => {
  beforeEach(() => {
    fetchStub.mockClear();
  });

  it("fails hard and never fetches direct when the proxy is down", async () => {
    await expect(
      proxyAwareFetch("https://api.anthropic.com/v1/messages", { method: "POST" }, STRICT_POOL),
    ).rejects.toThrow("strictProxy=true");

    // Only the proxied attempt ran; no direct fallback call.
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0][1]?.dispatcher).toBeTruthy();
  });

  it("DNS-bypass branch also refuses to go direct when strictProxy is on", async () => {
    await expect(
      proxyAwareFetch("https://api2.cursor.sh/aiserver.v1", {}, STRICT_POOL),
    ).rejects.toThrow("strictProxy=true");

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0][1]?.dispatcher).toBeTruthy();
  });

  it("falls back to direct when strictProxy is off", async () => {
    const res = await proxyAwareFetch(
      "https://api.anthropic.com/v1/messages",
      { method: "POST" },
      {
        ...STRICT_POOL,
        strictProxy: false,
      },
    );

    expect(await res.text()).toBe("direct");
    // Proxied attempt, then the direct fallback.
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(fetchStub.mock.calls[1][1]?.dispatcher).toBeUndefined();
  });
});
