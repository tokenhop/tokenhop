// YAN-1036: with Strict Proxy on and the proxy unreachable, the reactive Codex
// refresh fails closed instead of reaching the token endpoint directly.
// proxyFetch captures globalThis.fetch at import as its direct fallback, so
// stub it before importing anything that loads proxyFetch.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchStub = vi.fn(async (_url, options = {}) => {
  if (options?.dispatcher) throw new Error("connect ECONNREFUSED 127.0.0.1:9");
  return new Response(JSON.stringify({ access_token: "direct-leak", expires_in: 3600 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});
globalThis.fetch = fetchStub;

const { CodexExecutor } = await import("../../open-sse/executors/codex.js");

const STRICT_POOL = {
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://127.0.0.1:9",
  connectionNoProxy: "",
  vercelRelayUrl: "",
  strictProxy: true,
  connectionProxyPoolId: "pool-1",
};

describe("Codex reactive refresh under Strict Proxy (YAN-1036)", () => {
  beforeEach(() => {
    fetchStub.mockClear();
  });

  it("fails closed and never goes direct when the proxy is down", async () => {
    const result = await new CodexExecutor().refreshCredentials(
      { refreshToken: "rt-strict-yan1036", providerSpecificData: STRICT_POOL },
      null,
      STRICT_POOL,
    );

    expect(result?.accessToken).not.toBe("direct-leak");
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0][1]?.dispatcher).toBeTruthy();
  });
});
