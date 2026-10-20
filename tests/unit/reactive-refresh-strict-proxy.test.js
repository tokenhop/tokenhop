// YAN-1036: with Strict Proxy on and the proxy unreachable, the reactive Codex
// refresh fails closed instead of reaching the token endpoint directly.
// proxyFetch captures globalThis.fetch at import as its direct fallback, so
// stub fetch and re-import a fresh module graph.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchStub = vi.fn(async (_url, options = {}) => {
  if (options?.dispatcher) throw new Error("connect ECONNREFUSED 127.0.0.1:9");
  return new Response(JSON.stringify({ access_token: "direct-leak", expires_in: 3600 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

const STRICT_POOL = {
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://127.0.0.1:9",
  connectionNoProxy: "",
  vercelRelayUrl: "",
  strictProxy: true,
  connectionProxyPoolId: "pool-1",
};

describe("Codex reactive refresh under Strict Proxy (YAN-1036)", () => {
  let CodexExecutor;

  beforeEach(async () => {
    vi.resetModules();
    fetchStub.mockClear();
    vi.stubGlobal("fetch", fetchStub);
    ({ CodexExecutor } = await import("../../open-sse/executors/codex.js"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails closed and never goes direct when the proxy is down", async () => {
    const result = await new CodexExecutor().refreshCredentials(
      { refreshToken: "rt-strict-yan1036", providerSpecificData: STRICT_POOL },
      null,
      STRICT_POOL,
    );

    expect(result?.accessToken).toBeUndefined();
    // Only the proxied attempt ran; no direct fallback call.
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0][1]?.dispatcher).toBeTruthy();
  });
});
