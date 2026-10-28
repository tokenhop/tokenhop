// YAN-1574: credentialed gateway calls (STT, TTS, search, web fetch, Cloud Code
// project discovery, web-cookie executors) must go through the connection's
// proxy (pool / relay / Strict Proxy), never plain fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: vi.fn(),
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

import { handleSttCore } from "../../open-sse/handlers/sttCore.js";
import { handleTtsCore } from "../../open-sse/handlers/ttsCore.js";
import { handleChatSearch } from "../../open-sse/handlers/search/chatSearch.js";
import { handleSearchCore } from "../../open-sse/handlers/search/index.js";
import { handleFetchCore } from "../../open-sse/handlers/fetch/index.js";
import { getProjectIdForConnection } from "../../open-sse/services/projectId.js";
import { GrokWebExecutor } from "../../open-sse/executors/grok-web.js";
import { PerplexityWebExecutor } from "../../open-sse/executors/perplexity-web.js";

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
const STRICT_ERROR = "[ProxyFetch] Proxy required but failed (strictProxy=true): refused";

const creds = (extra = {}) => ({
  apiKey: "sk-x",
  providerSpecificData: { ...PROXY_PSD },
  ...extra,
});
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const sttForm = () => {
  const fd = new FormData();
  fd.append("file", new Blob(["audio"], { type: "audio/wav" }), "a.wav");
  return fd;
};

beforeEach(() => {
  mocks.proxyAwareFetch.mockReset();
  // A plain (proxy-bypassing) fetch is a failure, and must never reach the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("direct fetch bypassed the connection proxy");
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("STT", () => {
  it("routes an OpenAI-compatible transcription through the connection proxy", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(json({ text: "hi" }));

    const result = await handleSttCore({
      provider: "groq",
      model: "whisper-large-v3",
      formData: sttForm(),
      credentials: creds(),
      sttConfig: {
        format: "openai",
        baseUrl: "https://stt.example/v1/audio/transcriptions",
        authHeader: "bearer",
      },
    });

    expect(result.success).toBe(true);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://stt.example/v1/audio/transcriptions",
      expect.objectContaining({ method: "POST" }),
      EXPECTED_PROXY,
    );
  });

  it("routes every AssemblyAI step, including the poll, through the proxy", async () => {
    vi.useFakeTimers();
    mocks.proxyAwareFetch
      .mockResolvedValueOnce(json({ upload_url: "https://cdn/a" }))
      .mockResolvedValueOnce(json({ id: "t1" }))
      .mockResolvedValueOnce(json({ status: "completed", text: "done" }));

    const pending = handleSttCore({
      provider: "assemblyai",
      model: "universal",
      formData: sttForm(),
      credentials: creds(),
      sttConfig: {
        format: "assemblyai",
        baseUrl: "https://api.assemblyai.com/v2/transcript",
        authHeader: "key",
      },
    });
    await vi.advanceTimersByTimeAsync(2500);
    const result = await pending;

    expect(result.success).toBe(true);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(3);
    for (const call of mocks.proxyAwareFetch.mock.calls) expect(call[2]).toEqual(EXPECTED_PROXY);
    expect(mocks.proxyAwareFetch.mock.calls[2][0]).toBe(
      "https://api.assemblyai.com/v2/transcript/t1",
    );
  });

  it("routes Gemini STT through the proxy with the key in a header, not the URL", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(
      json({ candidates: [{ content: { parts: [{ text: "hi" }] } }] }),
    );

    const result = await handleSttCore({
      provider: "gemini",
      model: "gemini-2.5-flash",
      formData: sttForm(),
      credentials: creds(),
      sttConfig: {
        format: "gemini-stt",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
      },
    });

    expect(result.success).toBe(true);
    const [url, init, proxy] = mocks.proxyAwareFetch.mock.calls[0];
    expect(String(url)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(String(url)).not.toContain("key=");
    expect(init.headers["x-goog-api-key"]).toBe("sk-x");
    expect(proxy).toEqual(EXPECTED_PROXY);
  });

  it("surfaces proxy failure as an error result", async () => {
    mocks.proxyAwareFetch.mockRejectedValue(new Error(STRICT_ERROR));

    const result = await handleSttCore({
      provider: "groq",
      model: "whisper-large-v3",
      formData: sttForm(),
      credentials: creds(),
      sttConfig: { format: "openai", baseUrl: "https://stt.example/v1", authHeader: "bearer" },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toBe("Upstream proxy unavailable");
    expect(result.error).not.toContain("[ProxyFetch]");
    expect(result.error).not.toContain("strictProxy");
    expect(result.error).not.toContain("refused");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("TTS", () => {
  it("routes an adapter provider (OpenAI) through the connection proxy", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));

    const result = await handleTtsCore({
      provider: "openai",
      model: "tts-1/alloy",
      input: "hello",
      credentials: creds(),
    });

    expect(result.success).toBe(true);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/audio/speech",
      expect.objectContaining({ method: "POST" }),
      EXPECTED_PROXY,
    );
  });

  it("routes a config-driven provider (MiniMax) through the connection proxy", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(json({ data: { audio: "616263" } }));

    const result = await handleTtsCore({
      provider: "minimax",
      model: "",
      input: "hello",
      credentials: creds(),
    });

    expect(result.success).toBe(true);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://api.minimax.io/v1/t2a_v2",
      expect.objectContaining({ method: "POST" }),
      EXPECTED_PROXY,
    );
  });

  it("surfaces proxy failure as an error result", async () => {
    mocks.proxyAwareFetch.mockRejectedValue(new Error(STRICT_ERROR));

    const result = await handleTtsCore({
      provider: "openai",
      model: "tts-1/alloy",
      input: "hello",
      credentials: creds(),
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toBe("Upstream proxy unavailable");
    expect(result.error).not.toContain("[ProxyFetch]");
    expect(result.error).not.toContain("strictProxy");
    expect(result.error).not.toContain("refused");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("search", () => {
  it("routes chat-based search through the connection proxy", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(
      json({ choices: [{ message: { role: "assistant", content: "answer" } }] }),
    );

    await handleChatSearch({
      provider: "kimi",
      query: "latest news",
      credentials: creds(),
    });

    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("moonshot.cn"),
      expect.objectContaining({ method: "POST" }),
      EXPECTED_PROXY,
    );
  });

  it("routes a fetchTrusted-based search provider through the connection proxy", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(json({ results: [] }));

    const result = await handleSearchCore({
      body: { query: "tokenhop" },
      provider: { id: "tavily" },
      providerConfig: {
        id: "tavily",
        baseUrl: "https://api.tavily.com",
        method: "POST",
        authType: "apikey",
        defaultMaxResults: 5,
        maxMaxResults: 100,
      },
      credentials: creds(),
    });

    expect(result.success).toBe(true);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("api.tavily.com"),
      expect.objectContaining({ redirect: "manual" }),
      EXPECTED_PROXY,
    );
  });

  it("surfaces proxy failure as an error result", async () => {
    mocks.proxyAwareFetch.mockRejectedValue(new Error(STRICT_ERROR));

    const result = await handleSearchCore({
      body: { query: "tokenhop" },
      provider: { id: "tavily" },
      providerConfig: {
        id: "tavily",
        baseUrl: "https://api.tavily.com",
        method: "POST",
        authType: "apikey",
      },
      credentials: creds(),
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toBe("Upstream proxy unavailable");
    expect(result.error).not.toContain("[ProxyFetch]");
    expect(result.error).not.toContain("strictProxy");
    expect(result.error).not.toContain("refused");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("web fetch", () => {
  it("routes the provider call through the connection proxy", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(json({ data: { markdown: "# hi" } }));

    const result = await handleFetchCore({
      url: "https://example.com",
      provider: "firecrawl",
      providerConfig: { timeoutMs: 1000 },
      credentials: creds(),
    });

    expect(result.success).toBe(true);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://api.firecrawl.dev/v1/scrape",
      expect.objectContaining({ method: "POST" }),
      EXPECTED_PROXY,
    );
  });

  it("surfaces proxy failure as an error result", async () => {
    mocks.proxyAwareFetch.mockRejectedValue(new Error(STRICT_ERROR));

    const result = await handleFetchCore({
      url: "https://example.com",
      provider: "firecrawl",
      providerConfig: { timeoutMs: 1000 },
      credentials: creds(),
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toBe("Upstream proxy unavailable");
    expect(result.error).not.toContain("[ProxyFetch]");
    expect(result.error).not.toContain("strictProxy");
    expect(result.error).not.toContain("refused");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("Cloud Code project discovery", () => {
  it("routes loadCodeAssist through the connection proxy", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(json({ cloudaicompanionProject: "proj-123" }));
    const options = {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://pool.example:8080",
      connectionNoProxy: "",
      vercelRelayUrl: "",
      strictProxy: true,
      connectionProxyPoolId: "pool-1",
    };

    const projectId = await getProjectIdForConnection("conn-yan-1574", "at", "gemini-cli", options);

    expect(projectId).toBe("proj-123");
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("loadCodeAssist"),
      expect.objectContaining({ method: "POST" }),
      options,
    );
  });
});

describe("web-cookie executors", () => {
  it("Grok web uses the proxy options passed to execute()", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(new Response("", { status: 401 }));

    await new GrokWebExecutor().execute({
      model: "grok-4",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "sso-cookie" },
      proxyOptions: { ...PROXY_PSD },
    });

    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("grok.com"),
      expect.objectContaining({ method: "POST" }),
      EXPECTED_PROXY,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("Perplexity web uses the proxy options passed to execute()", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(new Response("", { status: 401 }));

    await new PerplexityWebExecutor().execute({
      model: "sonar",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "session-token" },
      proxyOptions: { ...PROXY_PSD },
    });

    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("perplexity.ai"),
      expect.objectContaining({ method: "POST" }),
      EXPECTED_PROXY,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("Grok web returns a generic proxy error to the client", async () => {
    mocks.proxyAwareFetch.mockRejectedValue(new Error(STRICT_ERROR));

    const result = await new GrokWebExecutor().execute({
      model: "grok-4",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "sso-cookie" },
      proxyOptions: { ...PROXY_PSD },
    });

    expect(result.response.status).toBe(502);
    const body = await result.response.text();
    expect(body).toContain("Upstream proxy unavailable");
    expect(body).not.toContain("[ProxyFetch]");
    expect(body).not.toContain("strictProxy");
    expect(body).not.toContain("refused");
  });

  it("Perplexity web returns a generic proxy error to the client", async () => {
    mocks.proxyAwareFetch.mockRejectedValue(new Error(STRICT_ERROR));

    const result = await new PerplexityWebExecutor().execute({
      model: "sonar",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "session-token" },
      proxyOptions: { ...PROXY_PSD },
    });

    expect(result.response.status).toBe(502);
    const body = await result.response.text();
    expect(body).toContain("Upstream proxy unavailable");
    expect(body).not.toContain("[ProxyFetch]");
    expect(body).not.toContain("strictProxy");
    expect(body).not.toContain("refused");
  });
});

describe("Zed and Trae executors", () => {
  it("Zed routes the catalog, LLM-token mint and /completions through execute() proxyOptions", async () => {
    mocks.proxyAwareFetch.mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes("/client/llm_tokens")) return json({ token: "llm-token" });
      if (target.endsWith("/models"))
        return json({ models: [{ id: "m1", provider: "anthropic" }] });
      return new Response("upstream-error", { status: 500 });
    });

    const { default: ZedExecutor } = await import("../../open-sse/executors/zed.js");
    const executor = new ZedExecutor();
    executor.config = {};
    await executor.execute({
      model: "m1",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: {
        accessToken: "zed-access-token-yan-1574",
        providerSpecificData: { userId: "u1", organizationId: "org-1" },
      },
      proxyOptions: { ...PROXY_PSD },
    });

    const urls = mocks.proxyAwareFetch.mock.calls.map(([url]) => String(url));
    expect(urls.some((u) => u.includes("/client/llm_tokens"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/models"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/completions"))).toBe(true);
    for (const call of mocks.proxyAwareFetch.mock.calls) expect(call[2]).toEqual(EXPECTED_PROXY);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("Trae routes session creation and the event stream through execute() proxyOptions", async () => {
    mocks.proxyAwareFetch.mockImplementation(async (url) =>
      String(url).endsWith("/chat_sessions")
        ? json({ code: 0, data: { chat_session_id: "s1", message_id: "m1" } })
        : new Response("event: done\ndata: {}\n\n", {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
    );

    const { default: TraeExecutor } = await import("../../open-sse/executors/trae.js");
    const executor = new TraeExecutor();
    executor.config = {};
    await executor.execute({
      model: "trae-model",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { accessToken: "jwt" },
      proxyOptions: { ...PROXY_PSD },
    });

    const urls = mocks.proxyAwareFetch.mock.calls.map(([url]) => String(url));
    expect(urls.some((u) => u.endsWith("/chat_sessions"))).toBe(true);
    expect(urls.some((u) => u.includes("/chat_sessions/s1/events"))).toBe(true);
    for (const call of mocks.proxyAwareFetch.mock.calls) expect(call[2]).toEqual(EXPECTED_PROXY);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("real proxyAwareFetch under Strict Proxy", () => {
  it("never retries direct when the proxy is unreachable", async () => {
    // Unreachable proxy: any dispatcher-bearing (proxied) attempt is refused;
    // a call without a dispatcher would be the direct fallback.
    const underlyingFetch = vi.fn(async (_url, init = {}) => {
      if (init?.dispatcher) throw new Error("connect ECONNREFUSED 127.0.0.1:1");
      return new Response("direct", { status: 200 });
    });
    vi.stubGlobal("fetch", underlyingFetch);
    const actual = await vi.importActual("../../open-sse/utils/proxyFetch.js");
    mocks.proxyAwareFetch.mockImplementation(actual.proxyAwareFetch);

    const result = await handleFetchCore({
      url: "https://example.com",
      provider: "firecrawl",
      providerConfig: { timeoutMs: 1000 },
      credentials: creds({
        providerSpecificData: { ...PROXY_PSD, connectionProxyUrl: "http://127.0.0.1:1" },
      }),
    });

    expect(result.success).toBe(false);
    expect(underlyingFetch).toHaveBeenCalled();
    for (const call of underlyingFetch.mock.calls) expect(call[1]?.dispatcher).toBeTruthy();
  });
});
