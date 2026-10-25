// YAN-1251: image, embeddings and video upstream calls, the Vertex service-account
// token mint, and the dashboard Google model catalogs must go through the
// connection's proxy (pool / relay / Strict Proxy), never plain fetch.
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Cloudflare input image URLs are DNS-validated before fetching.
const lookupMock = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup: (...a) => lookupMock(...a) }));

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  refreshTokenByProvider: vi.fn(),
  refreshGoogleToken: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: vi.fn(),
  proxyAwareFetch: mocks.proxyAwareFetch,
}));
vi.mock("../../open-sse/services/tokenRefresh.js", async (importOriginal) => ({
  ...(await importOriginal()),
  refreshTokenByProvider: mocks.refreshTokenByProvider,
}));
vi.mock("@/lib/network/connectionProxy", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));
vi.mock("@/sse/services/tokenRefresh", async (importOriginal) => ({
  ...(await importOriginal()),
  refreshGoogleToken: mocks.refreshGoogleToken,
  updateProviderCredentials: vi.fn(async () => true),
}));
// Async image providers poll on a timer; poll immediately.
vi.mock("../../open-sse/handlers/imageProviders/_base.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sleep: async () => {},
}));

import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { handleEmbeddingsCore } from "../../open-sse/handlers/embeddingsCore.js";
import { handleVideoProxyCore } from "../../open-sse/handlers/videoCore.js";
import {
  resolveAntigravity,
  resolveGemini,
  resolveGeminiCli,
} from "../../src/lib/providerModels/googleModels.js";

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
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const silentLog = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

beforeEach(() => {
  mocks.proxyAwareFetch.mockReset();
  mocks.resolveConnectionProxyConfig.mockReset();
  mocks.refreshTokenByProvider.mockReset();
  mocks.refreshGoogleToken.mockReset();
  // A plain (proxy-bypassing) fetch is a failure, and must never reach the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("direct fetch bypassed the connection proxy");
    }),
  );
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("upstream media requests use the connection proxy", () => {
  it("image generation", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(
      json({ created: 1, data: [{ url: "https://x/i.png" }] }),
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "a cat" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: { apiKey: "sk-x", providerSpecificData: { ...PROXY_PSD } },
      log: silentLog(),
    });

    expect(result.success).toBe(true);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/images/generations",
      expect.objectContaining({ method: "POST" }),
      EXPECTED_PROXY,
    );
  });

  it("image generation via the Antigravity executor", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(
      json({ candidates: [{ content: { parts: [{ inlineData: { data: "AAAA" } }] } }] }),
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "a cat" },
      modelInfo: { provider: "antigravity", model: "gemini-3.1-flash-image" },
      credentials: {
        accessToken: "at",
        projectId: "proj-1",
        providerSpecificData: { ...PROXY_PSD },
      },
      log: silentLog(),
    });

    expect(result.success).toBe(true);
    expect(mocks.proxyAwareFetch).toHaveBeenCalled();
    for (const call of mocks.proxyAwareFetch.mock.calls) {
      expect(call[2]).toEqual(EXPECTED_PROXY);
    }
  });

  it("binary image output downloads the result URL through the proxy", async () => {
    mocks.proxyAwareFetch.mockImplementation(async (url) =>
      url === "https://cdn.example/i.png"
        ? new Response(Buffer.from("png-bytes"), { status: 200 })
        : json({ created: 1, data: [{ url: "https://cdn.example/i.png" }] }),
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "a cat" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: { apiKey: "sk-x", providerSpecificData: { ...PROXY_PSD } },
      log: silentLog(),
      binaryOutput: true,
    });

    expect(result.success).toBe(true);
    expect(Buffer.from(await result.response.arrayBuffer()).toString()).toBe("png-bytes");
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://cdn.example/i.png",
      expect.any(Object),
      EXPECTED_PROXY,
    );
  });

  it("async image polling (Black Forest Labs) uses the proxy", async () => {
    mocks.proxyAwareFetch.mockImplementation(async (url) =>
      url === "https://poll.example/bfl"
        ? json({ status: "Ready", result: { sample: "https://cdn.example/bfl.png" } })
        : json({ polling_url: "https://poll.example/bfl" }),
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "a cat" },
      modelInfo: { provider: "black-forest-labs", model: "flux-pro-1.1" },
      credentials: { apiKey: "bfl-key", providerSpecificData: { ...PROXY_PSD } },
      log: silentLog(),
    });

    expect(result.success).toBe(true);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(mocks.proxyAwareFetch).toHaveBeenLastCalledWith(
      "https://poll.example/bfl",
      expect.any(Object),
      EXPECTED_PROXY,
    );
    for (const call of mocks.proxyAwareFetch.mock.calls) {
      expect(call[2]).toEqual(EXPECTED_PROXY);
    }
  });

  it("Cloudflare input image URL is validated and downloaded through the proxy", async () => {
    const PNG_BYTES = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(16, 1),
    ]);
    mocks.proxyAwareFetch.mockImplementation(async (url) =>
      url === "https://example.com/source.png"
        ? new Response(PNG_BYTES, { status: 200 })
        : json({ result: { image: "b64out" }, success: true }),
    );

    const result = await handleImageGenerationCore({
      body: { prompt: "a lion", image: "https://example.com/source.png" },
      modelInfo: { provider: "cloudflare-ai", model: "@cf/runwayml/stable-diffusion-v1-5-img2img" },
      credentials: {
        apiKey: "cf-token",
        providerSpecificData: { ...PROXY_PSD, accountId: "cf-account" },
      },
      log: silentLog(),
    });

    expect(result.success).toBe(true);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://example.com/source.png",
      expect.any(Object),
      EXPECTED_PROXY,
    );
  });

  it("embeddings", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(
      json({ object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1] }] }),
    );

    const result = await handleEmbeddingsCore({
      body: { model: "text-embedding-3-small", input: "hi" },
      modelInfo: { provider: "openai", model: "text-embedding-3-small" },
      credentials: { apiKey: "sk-x", providerSpecificData: { ...PROXY_PSD } },
      log: silentLog(),
    });

    expect(result.success).toBe(true);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/embeddings",
      expect.objectContaining({ method: "POST" }),
      EXPECTED_PROXY,
    );
  });

  const vertexSaJson = () =>
    JSON.stringify({
      type: "service_account",
      client_email: "video@proj-1.iam.gserviceaccount.com",
      // Fresh key per call, so the Vertex token cache never short-circuits the mint.
      private_key: generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      }).privateKey,
      project_id: "proj-1",
    });

  it("Vertex video: service-account token mint and the job request", async () => {
    const saJson = vertexSaJson();
    mocks.proxyAwareFetch.mockImplementation(async (url) =>
      url === GOOGLE_TOKEN_URL
        ? json({ access_token: "vertex-tok", expires_in: 3600 })
        : json({
            name: "projects/proj-1/locations/us-central1/publishers/google/models/veo/operations/op",
          }),
    );

    const result = await handleVideoProxyCore({
      provider: "vertex",
      action: "generations",
      rawBody: JSON.stringify({ model: "veo-3.1-generate-preview", prompt: "x" }),
      contentType: "application/json",
      credentials: { apiKey: saJson, providerSpecificData: { ...PROXY_PSD } },
      log: silentLog(),
    });

    expect(result.success).toBe(true);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      GOOGLE_TOKEN_URL,
      expect.any(Object),
      EXPECTED_PROXY,
    );
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining(":predictLongRunning"),
      expect.objectContaining({ method: "POST" }),
      EXPECTED_PROXY,
    );
  });

  it("Vertex video: an unreachable token endpoint is a 502, not a credential error", async () => {
    mocks.proxyAwareFetch.mockRejectedValue(
      new Error("[ProxyFetch] Proxy required but failed (strictProxy=true): ECONNREFUSED"),
    );

    const result = await handleVideoProxyCore({
      provider: "vertex",
      action: "generations",
      rawBody: JSON.stringify({ model: "veo-3.1-generate-preview", prompt: "x" }),
      contentType: "application/json",
      credentials: { apiKey: vertexSaJson(), providerSpecificData: { ...PROXY_PSD } },
      log: silentLog(),
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(mocks.proxyAwareFetch.mock.calls[0][0]).toBe(GOOGLE_TOKEN_URL);
  });

  it("video 401 refresh and retry carry the proxy", async () => {
    mocks.proxyAwareFetch
      .mockResolvedValueOnce(json({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(json({ request_id: "req-1" }));
    mocks.refreshTokenByProvider.mockResolvedValue({ accessToken: "tok-new" });
    const credentials = {
      accessToken: "tok-old",
      refreshToken: "rt",
      providerSpecificData: { ...PROXY_PSD },
    };
    const log = silentLog();

    const result = await handleVideoProxyCore({
      provider: "xai",
      action: "generations",
      rawBody: '{"prompt":"x"}',
      contentType: "application/json",
      credentials,
      log,
    });

    expect(result.success).toBe(true);
    expect(mocks.refreshTokenByProvider).toHaveBeenCalledWith(
      "xai",
      credentials,
      log,
      EXPECTED_PROXY,
    );
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(2);
    for (const call of mocks.proxyAwareFetch.mock.calls) {
      expect(call[0]).toBe("https://api.x.ai/v1/videos/generations");
      expect(call[2]).toEqual(EXPECTED_PROXY);
    }
  });
});

describe("dashboard Google model catalogs use the connection proxy", () => {
  const POOL_CONFIG = {
    source: "pool",
    proxyPoolId: "pool-1",
    connectionProxyEnabled: true,
    connectionProxyUrl: "http://pool.example:8080",
    connectionNoProxy: "",
    strictProxy: true,
  };

  it("gemini-cli catalog fetch and its 401 refresh", async () => {
    mocks.resolveConnectionProxyConfig.mockResolvedValue(POOL_CONFIG);
    mocks.refreshGoogleToken.mockResolvedValue({ accessToken: "at-new" });
    mocks.proxyAwareFetch
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(json({ models: { "gemini-9-pro": { displayName: "G9" } } }));

    const result = await resolveGeminiCli({
      id: "conn-yan1251",
      accessToken: "at-old",
      refreshToken: "rt",
      projectId: "proj-1",
      providerSpecificData: { proxyPoolId: "pool-1" },
    });

    expect(result.models.map((m) => m.id)).toEqual(["gemini-9-pro"]);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(2);
    for (const call of mocks.proxyAwareFetch.mock.calls) {
      expect(call[0]).toBe("https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels");
      expect(call[2]).toEqual(EXPECTED_PROXY);
    }
    expect(mocks.refreshGoogleToken).toHaveBeenCalledTimes(1);
    const [refreshToken, , , refreshProxy] = mocks.refreshGoogleToken.mock.calls[0];
    expect(refreshToken).toBe("rt");
    expect(refreshProxy).toEqual(EXPECTED_PROXY);
  });

  it("gemini (AI Studio) catalog fetch", async () => {
    mocks.resolveConnectionProxyConfig.mockResolvedValue(POOL_CONFIG);
    mocks.proxyAwareFetch.mockResolvedValue(
      json({
        models: [{ name: "models/gemini-9", supportedGenerationMethods: ["generateContent"] }],
      }),
    );

    const result = await resolveGemini({ apiKey: "AIza-key", providerSpecificData: {} });

    expect(result.models.map((m) => m.id)).toContain("gemini-9");
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("https://generativelanguage.googleapis.com/v1beta/models"),
      expect.any(Object),
      EXPECTED_PROXY,
    );
  });

  it("antigravity catalog fetch", async () => {
    mocks.resolveConnectionProxyConfig.mockResolvedValue(POOL_CONFIG);
    mocks.proxyAwareFetch.mockResolvedValue(
      json({ models: { "claude-sonnet-4-6": { displayName: "Sonnet" } } }),
    );

    const result = await resolveAntigravity({
      accessToken: "at",
      projectId: "proj-1",
      providerSpecificData: { proxyPoolId: "pool-1" },
    });

    expect(result.models.map((m) => m.id)).toContain("claude-sonnet-4-6");
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1internal:fetchAvailableModels"),
      expect.objectContaining({ method: "POST" }),
      EXPECTED_PROXY,
    );
  });

  it("fails closed when the proxy cannot be resolved", async () => {
    mocks.resolveConnectionProxyConfig.mockResolvedValue({ source: "error" });

    const cli = await resolveGeminiCli({ accessToken: "at", projectId: "proj-1" });
    const studio = await resolveGemini({ apiKey: "AIza-key" });

    expect(cli.models).toEqual([]);
    expect(cli.warning).toMatch(/proxy resolution failed/);
    expect(studio.models).toEqual([]);
    expect(studio.warning).toMatch(/proxy resolution failed/);
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });
});

// Real proxyFetch: it captures globalThis.fetch at import as its direct path, so
// stub fetch and re-import a fresh module graph. Kept last: it unmocks proxyFetch.
describe("Strict Proxy fails closed for media requests", () => {
  const STRICT_POOL = {
    connectionProxyEnabled: true,
    connectionProxyUrl: "http://127.0.0.1:9",
    connectionNoProxy: "",
    vercelRelayUrl: "",
    strictProxy: true,
    connectionProxyPoolId: "pool-1",
  };
  const fetchStub = vi.fn(async (_url, options = {}) => {
    if (options?.dispatcher) throw new Error("connect ECONNREFUSED 127.0.0.1:9");
    return json({ created: 1, data: [{ url: "https://x/direct.png" }] });
  });

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../../open-sse/utils/proxyFetch.js");
    fetchStub.mockClear();
    vi.stubGlobal("fetch", fetchStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const expectProxiedOnly = () => {
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0][1]?.dispatcher).toBeTruthy();
  };

  it("image generation", async () => {
    const { handleImageGenerationCore: handle } = await import(
      "../../open-sse/handlers/imageGenerationCore.js"
    );
    const result = await handle({
      body: { prompt: "a cat" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: { apiKey: "sk-x", providerSpecificData: { ...STRICT_POOL } },
      log: silentLog(),
    });

    expect(result.success).toBe(false);
    expectProxiedOnly();
  });

  it("embeddings", async () => {
    const { handleEmbeddingsCore: handle } = await import(
      "../../open-sse/handlers/embeddingsCore.js"
    );
    const result = await handle({
      body: { model: "text-embedding-3-small", input: "hi" },
      modelInfo: { provider: "openai", model: "text-embedding-3-small" },
      credentials: { apiKey: "sk-x", providerSpecificData: { ...STRICT_POOL } },
      log: silentLog(),
    });

    expect(result.success).toBe(false);
    expectProxiedOnly();
  });

  const NON_STRICT_POOL = { ...STRICT_POOL, strictProxy: false };
  const videoCall = (overrides) =>
    import("../../open-sse/handlers/videoCore.js").then(({ handleVideoProxyCore: handle }) =>
      handle({
        provider: "xai",
        credentials: { accessToken: "tok", providerSpecificData: { ...NON_STRICT_POOL } },
        log: silentLog(),
        ...overrides,
      }),
    );

  it("video creation POST is never re-sent directly after a proxy failure", async () => {
    const result = await videoCall({
      action: "generations",
      rawBody: '{"prompt":"x"}',
      contentType: "application/json",
    });

    expect(result.success).toBe(false);
    expectProxiedOnly();
  });

  it("video polling keeps the non-strict direct fallback", async () => {
    await videoCall({ requestId: "req-1" });

    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(fetchStub.mock.calls[0][1]?.dispatcher).toBeTruthy();
    expect(fetchStub.mock.calls[1][1]?.dispatcher).toBeUndefined();
  });

  describe("with only an environment proxy", () => {
    beforeEach(() => {
      vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:9");
      vi.stubEnv("NO_PROXY", "");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });
    const noConnectionProxy = { credentials: { accessToken: "tok", providerSpecificData: {} } };

    it("video creation POST is never re-sent directly", async () => {
      const result = await videoCall({
        ...noConnectionProxy,
        action: "generations",
        rawBody: '{"prompt":"x"}',
        contentType: "application/json",
      });

      expect(result.success).toBe(false);
      expectProxiedOnly();
    });

    it("video polling keeps the direct fallback", async () => {
      await videoCall({ ...noConnectionProxy, requestId: "req-1" });

      expect(fetchStub).toHaveBeenCalledTimes(2);
      expect(fetchStub.mock.calls[0][1]?.dispatcher).toBeTruthy();
      expect(fetchStub.mock.calls[1][1]?.dispatcher).toBeUndefined();
    });
  });

  it.each([
    ["strict", STRICT_POOL],
    ["non-strict", NON_STRICT_POOL],
  ])("%s proxy: an aborted request keeps its error and never goes direct", async (_, pool) => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const controller = new AbortController();
    controller.abort();
    fetchStub.mockImplementationOnce(async () => {
      throw new DOMException("This operation was aborted", "AbortError");
    });

    await expect(
      proxyAwareFetch("https://api.x.ai/v1/videos/req-1", { signal: controller.signal }, pool),
    ).rejects.toMatchObject({ name: "AbortError" });
    expectProxiedOnly();
  });
});
