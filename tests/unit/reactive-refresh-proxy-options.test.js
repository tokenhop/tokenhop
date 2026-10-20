// YAN-1036: the reactive 401/403 token refresh must use the connection's
// proxy options (YAN-651 Strict Proxy guarantee), on chat, images and
// embeddings. Executors that override refreshCredentials must forward them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { proxyAwareFetchMock, executorState } = vi.hoisted(() => ({
  proxyAwareFetchMock: vi.fn(),
  executorState: { executor: null },
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: vi.fn(),
  proxyAwareFetch: proxyAwareFetchMock,
}));

const PROXY_PSD = {
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://pool.example:8080",
  connectionNoProxy: "",
  vercelRelayUrl: "",
  strictProxy: true,
  connectionProxyPoolId: "pool-1",
};
const EXPECTED_PROXY = expect.objectContaining({
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://pool.example:8080",
  strictProxy: true,
  connectionProxyPoolId: "pool-1",
});

function tokenResponse() {
  return new Response(
    JSON.stringify({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("executor.refreshCredentials forwards proxyOptions (YAN-1036)", () => {
  beforeEach(() => {
    proxyAwareFetchMock.mockReset();
    proxyAwareFetchMock.mockImplementation(async () => tokenResponse());
  });

  it("codex", async () => {
    const { CodexExecutor } = await import("../../open-sse/executors/codex.js");
    const proxy = { ...PROXY_PSD };
    const result = await new CodexExecutor().refreshCredentials(
      { refreshToken: "rt-codex-yan1036", providerSpecificData: PROXY_PSD },
      null,
      proxy,
    );

    expect(result?.accessToken).toBe("at-new");
    expect(proxyAwareFetchMock).toHaveBeenCalledWith(
      "https://auth.openai.com/oauth/token",
      expect.any(Object),
      proxy,
    );
  });

  it("gemini-cli", async () => {
    const { GeminiCLIExecutor } = await import("../../open-sse/executors/gemini-cli.js");
    const proxy = { ...PROXY_PSD };
    const result = await new GeminiCLIExecutor().refreshCredentials(
      { refreshToken: "rt-gemini-yan1036" },
      null,
      proxy,
    );

    expect(result?.accessToken).toBe("at-new");
    expect(proxyAwareFetchMock).toHaveBeenCalledWith(expect.any(String), expect.any(Object), proxy);
  });
});

describe("image and embeddings 401 handlers pass proxyOptions (YAN-1036)", () => {
  let refreshCredentials;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("../../open-sse/executors/index.js", () => ({
      getExecutor: () => executorState.executor,
      hasSpecializedExecutor: () => false,
    }));
    vi.doMock("../../open-sse/services/tokenRefresh.js", () => ({
      refreshWithRetry: async (fn) => fn(),
    }));
    refreshCredentials = vi.fn(async () => null);
    executorState.executor = { noAuth: false, supportsRefresh: true, refreshCredentials };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })),
    );
  });

  afterEach(() => {
    vi.doUnmock("../../open-sse/executors/index.js");
    vi.doUnmock("../../open-sse/services/tokenRefresh.js");
    vi.unstubAllGlobals();
  });

  const credentials = () => ({
    apiKey: "sk-x",
    accessToken: "at-old",
    refreshToken: "rt-old",
    providerSpecificData: { ...PROXY_PSD },
  });

  it("images", async () => {
    const { handleImageGenerationCore } = await import(
      "../../open-sse/handlers/imageGenerationCore.js"
    );
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const creds = credentials();
    await handleImageGenerationCore({
      body: { model: "openai/dall-e-3", prompt: "a cat" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: creds,
      log,
    });

    expect(refreshCredentials).toHaveBeenCalledTimes(1);
    expect(refreshCredentials).toHaveBeenCalledWith(creds, log, EXPECTED_PROXY);
  });

  it("embeddings", async () => {
    const { handleEmbeddingsCore } = await import("../../open-sse/handlers/embeddingsCore.js");
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const creds = credentials();
    await handleEmbeddingsCore({
      body: { model: "text-embedding-3-small", input: "hi" },
      modelInfo: { provider: "openai", model: "text-embedding-3-small" },
      credentials: creds,
      log,
    });

    expect(refreshCredentials).toHaveBeenCalledTimes(1);
    expect(refreshCredentials).toHaveBeenCalledWith(creds, log, EXPECTED_PROXY);
  });
});
