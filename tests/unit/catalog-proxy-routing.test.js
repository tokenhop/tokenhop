// YAN-1574: dashboard model catalogs must use the connection proxy and fail
// closed when that proxy cannot be resolved.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
  getProxyPoolById: vi.fn(),
  getProviderConnectionByIdUnscoped: vi.fn(),
  fetchElevenLabsVoices: vi.fn(),
  refreshClaudeOAuthToken: vi.fn(),
  resolveGatewayAuth: vi.fn(),
  getGatewayConnections: vi.fn(),
  resolveCursorModels: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: vi.fn(),
  proxyAwareFetch: mocks.proxyAwareFetch,
}));
vi.mock("@/models", () => ({
  getProxyPoolById: mocks.getProxyPoolById,
  getProviderConnectionByIdUnscoped: mocks.getProviderConnectionByIdUnscoped,
}));
vi.mock("open-sse/services/cursorModels.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveCursorModels: mocks.resolveCursorModels,
}));
vi.mock("@/lib/db/index.js", () => ({ getConnection: vi.fn() }));
vi.mock("@/lib/users/workspaceScope.js", () => ({
  principalScope: vi.fn(async () => null),
  denyRow: vi.fn(() => null),
  scopedConnections: vi.fn(),
}));
vi.mock("open-sse/handlers/ttsCore.js", () => ({
  fetchElevenLabsVoices: mocks.fetchElevenLabsVoices,
  VOICE_FETCHERS: {},
}));
vi.mock("@/sse/services/tokenRefresh", () => ({
  refreshClaudeOAuthToken: mocks.refreshClaudeOAuthToken,
  refreshGoogleToken: vi.fn(),
  refreshTokenByProvider: vi.fn(),
  updateProviderCredentials: vi.fn(async () => true),
}));
vi.mock("@/lib/auth/gatewayAuth.js", () => ({
  resolveGatewayAuth: mocks.resolveGatewayAuth,
}));
vi.mock("@/lib/auth/gatewayResources.js", () => ({
  getGatewayConnections: mocks.getGatewayConnections,
}));

import { resolveDeepSeek } from "../../src/lib/providerModels/apiKeyModels.js";
import { resolveOpenAI } from "../../src/lib/providerModels/openaiModels.js";
import {
  clearLiveModelsCache,
  resolveLiveModels,
} from "../../src/lib/providerModels/liveResolvers.js";
import { clearKiroModelCache } from "../../open-sse/services/kiroModels.js";
import { GET } from "../../src/app/api/providers/[id]/models/route.js";
import { GET as getElevenLabsVoices } from "../../src/app/api/media-providers/tts/elevenlabs/voices/route.js";
import { scopedConnections } from "../../src/lib/users/workspaceScope.js";
import { GET as getAudioVoices } from "../../src/app/api/v1/audio/voices/route.js";
import { GET as getDeepgramVoices } from "../../src/app/api/media-providers/tts/deepgram/voices/route.js";
import { GET as getInworldVoices } from "../../src/app/api/media-providers/tts/inworld/voices/route.js";
import { GET as getMiniMaxVoices } from "../../src/app/api/media-providers/tts/minimax/voices/route.js";

// Only the pool lookup is mocked; the real connectionProxyOptions runs.
const POOL_ROW = {
  isActive: true,
  proxyUrl: "http://pool.example:8080",
  noProxy: "",
  strictProxy: true,
};
const EXPECTED_PROXY = expect.objectContaining({
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://pool.example:8080",
  strictProxy: true,
});
const proxiedConnection = (extra = {}) => ({
  id: "conn-proxy",
  providerSpecificData: { proxyPoolId: "pool-1" },
  ...extra,
});

beforeEach(() => {
  mocks.proxyAwareFetch.mockReset();
  mocks.getProxyPoolById.mockReset().mockResolvedValue(POOL_ROW);
  mocks.getProviderConnectionByIdUnscoped.mockReset();
  mocks.fetchElevenLabsVoices.mockReset();
  mocks.resolveCursorModels.mockReset();
  mocks.refreshClaudeOAuthToken.mockReset();
  mocks.resolveGatewayAuth.mockReset().mockResolvedValue({ principal: {}, legacy: false });
  mocks.getGatewayConnections.mockReset().mockResolvedValue([]);
  clearLiveModelsCache();
  clearKiroModelCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("direct fetch bypassed the connection proxy");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dashboard catalog proxy routing", () => {
  it("routes an API-key catalog through the connection proxy", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(
      Response.json({ data: [{ id: "deepseek-proxy-test" }] }),
    );

    await resolveDeepSeek(proxiedConnection({ apiKey: "sk-test" }));

    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://api.deepseek.com/models",
      expect.any(Object),
      EXPECTED_PROXY,
    );
  });

  it("routes the Anthropic catalog through the connection proxy", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(
      Response.json({ data: [{ id: "claude-proxy-test" }], has_more: false }),
    );

    await resolveLiveModels(proxiedConnection({ provider: "anthropic", apiKey: "sk-ant-test" }));

    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("https://api.anthropic.com/v1/models"),
      expect.any(Object),
      EXPECTED_PROXY,
    );
  });

  it("routes the OpenAI catalog through the connection proxy", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(Response.json({ data: [{ id: "gpt-proxy-test" }] }));

    await resolveOpenAI(proxiedConnection({ apiKey: "sk-openai-test" }));

    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.any(Object),
      EXPECTED_PROXY,
    );
  });

  it("passes explicitly resolved proxy options through the Kiro service", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(
      Response.json({ models: [{ modelId: "claude-proxy-test", modelName: "Claude Proxy" }] }),
    );

    await resolveLiveModels(proxiedConnection({ provider: "kiro", accessToken: "kiro-token" }), {
      forceRefresh: true,
    });

    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("ListAvailableModels"),
      expect.any(Object),
      EXPECTED_PROXY,
    );
  });

  it("routes the models route OpenAI-compatible branch through the proxy", async () => {
    mocks.getProviderConnectionByIdUnscoped.mockResolvedValue(
      proxiedConnection({
        provider: "openai-compatible-test",
        apiKey: "sk-compatible-test",
        providerSpecificData: {
          baseUrl: "https://compatible.example/v1",
          proxyPoolId: "pool-1",
        },
      }),
    );
    mocks.proxyAwareFetch.mockResolvedValue(Response.json({ data: [{ id: "custom-model" }] }));

    const response = await GET(new Request("http://localhost/api/providers/conn-proxy/models"), {
      params: Promise.resolve({ id: "conn-proxy" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://compatible.example/v1/models",
      expect.any(Object),
      EXPECTED_PROXY,
    );
  });

  it("passes the connection proxy to the ElevenLabs voice catalog", async () => {
    vi.mocked(scopedConnections).mockResolvedValue({
      connections: [proxiedConnection({ provider: "elevenlabs", apiKey: "sk-voice-test" })],
    });
    mocks.fetchElevenLabsVoices.mockResolvedValue([]);

    await getElevenLabsVoices(
      new Request("http://localhost/api/media-providers/tts/elevenlabs/voices"),
    );

    expect(mocks.fetchElevenLabsVoices).toHaveBeenCalledWith("sk-voice-test", EXPECTED_PROXY);
  });

  it("fails closed without fetching when proxy resolution fails", async () => {
    mocks.getProxyPoolById.mockRejectedValue(new Error("db down"));
    mocks.getProviderConnectionByIdUnscoped.mockResolvedValue(
      proxiedConnection({
        provider: "openai-compatible-test",
        apiKey: "sk-compatible-test",
        providerSpecificData: {
          baseUrl: "https://compatible.example/v1",
          proxyPoolId: "pool-1",
        },
      }),
    );

    const response = await GET(new Request("http://localhost/api/providers/conn-proxy/models"), {
      params: Promise.resolve({ id: "conn-proxy" }),
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toMatch(/proxy resolution failed/);
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("keeps OAuth refreshes on the connection proxy", async () => {
    mocks.proxyAwareFetch
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: "claude-proxy-test" }] }));
    mocks.refreshClaudeOAuthToken.mockResolvedValue({ accessToken: "fresh-token" });
    const connection = proxiedConnection({
      id: "claude-proxy",
      provider: "claude",
      accessToken: "old-token",
      refreshToken: "refresh-token",
    });

    await resolveLiveModels(connection);

    expect(mocks.refreshClaudeOAuthToken).toHaveBeenCalledWith("refresh-token", EXPECTED_PROXY);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(2);
    for (const call of mocks.proxyAwareFetch.mock.calls) expect(call[2]).toEqual(EXPECTED_PROXY);
  });

  it("returns a Cline fail-closed warning without fetching", async () => {
    mocks.getProxyPoolById.mockRejectedValue(new Error("db down"));

    const result = await resolveLiveModels(
      proxiedConnection({ provider: "cline", accessToken: "cline-token" }),
    );

    expect(result.warning).toMatch(/proxy resolution failed/);
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });
});

describe("gateway voices proxy routing (principal path)", () => {
  const voicesUrl = (provider) => `http://localhost/v1/audio/voices?provider=${provider}`;

  const principalVoices = (provider, { connection, proxyLookupFails = false } = {}) => {
    mocks.getProxyPoolById.mockReset();
    if (proxyLookupFails) mocks.getProxyPoolById.mockRejectedValue(new Error("db down"));
    else mocks.getProxyPoolById.mockResolvedValue(POOL_ROW);
    mocks.getGatewayConnections.mockReset();
    mocks.getGatewayConnections.mockResolvedValue(connection ? [connection] : []);
    return getAudioVoices(new Request(voicesUrl(provider)));
  };

  const credentialedConnection = (provider) =>
    proxiedConnection({
      provider,
      apiKey: `sk-${provider}-test`,
      providerSpecificData: { proxyPoolId: "pool-1" },
    });

  it("routes the Deepgram voices fetch through the connection proxy", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(
      Response.json({ tts: [{ canonical_name: "aura-1", name: "Aura 1", languages: ["en"] }] }),
    );

    const response = await principalVoices("deepgram", {
      connection: credentialedConnection("deepgram"),
    });

    expect(response.status).toBe(200);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://api.deepgram.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Token sk-deepgram-test" }),
      }),
      EXPECTED_PROXY,
    );
  });

  it("routes the Inworld voices fetch through the connection proxy", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(
      Response.json({
        voices: [{ voiceId: "wavenet-a", displayName: "Wave A", languages: ["en"] }],
      }),
    );

    const response = await principalVoices("inworld", {
      connection: credentialedConnection("inworld"),
    });

    expect(response.status).toBe(200);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://api.inworld.ai/tts/v1/voices",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Basic sk-inworld-test" }),
      }),
      EXPECTED_PROXY,
    );
  });
  it("returns a generic proxy error from the voices route", async () => {
    mocks.proxyAwareFetch.mockRejectedValue(
      new Error("[ProxyFetch] Proxy required but failed (strictProxy=true): refused"),
    );

    const response = await principalVoices("deepgram", {
      connection: credentialedConnection("deepgram"),
    });
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error.message).toBe("Upstream proxy unavailable");
    expect(body.error.message).not.toContain("[ProxyFetch]");
    expect(body.error.message).not.toContain("strictProxy");
    expect(body.error.message).not.toContain("refused");
  });

  it("fails closed with 500 and no upstream fetch when proxy resolution errors", async () => {
    const response = await principalVoices("deepgram", {
      connection: credentialedConnection("deepgram"),
      proxyLookupFails: true,
    });

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toMatch(/proxy resolution failed/);
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });
});

// Each catalog below is reached through the real resolver and the real
// connectionProxyOptions; only the pool lookup and the network are mocked.
const byUrl = (routes) => async (url) => {
  const match = Object.entries(routes).find(([fragment]) => String(url).includes(fragment));
  return match ? Response.json(match[1]) : new Response("not found", { status: 404 });
};

describe("provider catalogs route through the connection proxy", () => {
  const CATALOGS = [
    {
      provider: "github",
      connection: { accessToken: "gh-token" },
      upstream: "https://api.githubcopilot.com/models",
      routes: { "githubcopilot.com/models": { data: [] } },
    },
    {
      provider: "zed",
      connection: {
        accessToken: "zed-token",
        providerSpecificData: { userId: "u1", organizationId: "org-1", proxyPoolId: "pool-1" },
      },
      upstream: "/models",
      routes: {
        "/client/llm_tokens": { token: "llm-token" },
        "/models": { models: [] },
      },
    },
    {
      provider: "qoder",
      connection: {
        accessToken: "qoder-token",
        providerSpecificData: { userId: "u1", proxyPoolId: "pool-1" },
      },
      upstream: "/algo/api/v2/model/list",
      routes: { "/algo/api/v2/model/list": { chat: [] } },
    },
    {
      provider: "grok-cli",
      connection: { accessToken: "grok-token" },
      upstream: "https://cli-chat-proxy.grok.com/v1/models",
      routes: { "/v1/models": { data: [] } },
    },
    {
      provider: "openrouter",
      connection: { apiKey: "sk-or-test" },
      upstream: "https://openrouter.ai/api/v1/models",
      routes: { "openrouter.ai/api/v1/models": { data: [] } },
    },
  ];
  const connectionFor = ({ provider, connection }) =>
    proxiedConnection({
      provider,
      ...connection,
      providerSpecificData: connection.providerSpecificData ?? { proxyPoolId: "pool-1" },
    });

  it.each(CATALOGS)("$provider catalog fetches only through the proxy", async (catalog) => {
    mocks.proxyAwareFetch.mockImplementation(byUrl(catalog.routes));

    await resolveLiveModels(connectionFor(catalog), { forceRefresh: true });

    const calls = mocks.proxyAwareFetch.mock.calls;
    expect(calls.some(([url]) => String(url).includes(catalog.upstream))).toBe(true);
    for (const call of calls) expect(call[2]).toEqual(EXPECTED_PROXY);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(CATALOGS)(
    "$provider catalog fails closed when the proxy lookup fails",
    async (catalog) => {
      mocks.getProxyPoolById.mockRejectedValue(new Error("db down"));

      const result = await resolveLiveModels(connectionFor(catalog), { forceRefresh: true });

      expect(result.models).toEqual([]);
      expect(result.warning).toMatch(/proxy resolution failed/);
      expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );
});

// Cursor's catalog is raw HTTP/2 and cannot use a proxy; policy matches the executor.
describe("Cursor catalog proxy guard", () => {
  const cursorConnection = (providerSpecificData = {}) => ({
    id: "conn-cursor",
    provider: "cursor",
    accessToken: "cursor-token",
    providerSpecificData,
  });
  const resolved = { models: [{ id: "cursor-model", name: "Cursor Model" }] };

  it("fetches directly when the connection has no proxy", async () => {
    mocks.resolveCursorModels.mockResolvedValue(resolved);

    const result = await resolveLiveModels(cursorConnection());

    expect(result.models).toEqual(resolved.models);
    expect(mocks.resolveCursorModels).toHaveBeenCalledTimes(1);
  });

  it("fetches directly for a non-strict pool, like the Cursor executor", async () => {
    mocks.getProxyPoolById.mockResolvedValue({ ...POOL_ROW, strictProxy: false });
    mocks.resolveCursorModels.mockResolvedValue(resolved);

    const result = await resolveLiveModels(cursorConnection({ proxyPoolId: "pool-1" }));

    expect(result.models).toEqual(resolved.models);
    expect(mocks.resolveCursorModels).toHaveBeenCalledTimes(1);
  });

  it("is blocked under Strict Proxy without calling the resolver", async () => {
    const result = await resolveLiveModels(cursorConnection({ proxyPoolId: "pool-1" }));

    expect(result.models).toEqual([]);
    expect(result.warning).toMatch(/requires a proxy/);
    expect(mocks.resolveCursorModels).not.toHaveBeenCalled();
  });

  it("is blocked behind a relay even when the pool is non-strict", async () => {
    mocks.getProxyPoolById.mockResolvedValue({
      ...POOL_ROW,
      type: "vercel",
      proxyUrl: "https://relay.example.dev/proxy",
      strictProxy: false,
    });

    const result = await resolveLiveModels(cursorConnection({ proxyPoolId: "pool-1" }));

    expect(result.warning).toMatch(/requires a proxy/);
    expect(mocks.resolveCursorModels).not.toHaveBeenCalled();
  });

  it("fails closed when the proxy lookup fails", async () => {
    mocks.getProxyPoolById.mockRejectedValue(new Error("db down"));

    const result = await resolveLiveModels(cursorConnection({ proxyPoolId: "pool-1" }));

    expect(result.models).toEqual([]);
    expect(result.warning).toMatch(/proxy resolution failed/);
    expect(mocks.resolveCursorModels).not.toHaveBeenCalled();
  });
});

describe("dashboard TTS voice routes use the connection proxy", () => {
  const ROUTES = [
    {
      name: "deepgram",
      GET: getDeepgramVoices,
      provider: "deepgram",
      upstream: "https://api.deepgram.com/v1/models",
      body: { tts: [{ canonical_name: "aura-1", name: "Aura 1", languages: ["en"] }] },
    },
    {
      name: "inworld",
      GET: getInworldVoices,
      provider: "inworld",
      upstream: "https://api.inworld.ai/tts/v1/voices",
      body: { voices: [{ voiceId: "wavenet-a", displayName: "Wave A", languages: ["en"] }] },
    },
    {
      name: "minimax",
      GET: getMiniMaxVoices,
      provider: "minimax",
      upstream: "https://api.minimax.io/v1/get_voice",
      body: {
        system_voice: [{ voice_id: "English_a", voice_name: "A" }],
        base_resp: { status_code: 0 },
      },
    },
  ];
  const callRoute = ({ name, GET: handler, provider }) => {
    vi.mocked(scopedConnections).mockResolvedValue({
      connections: [proxiedConnection({ provider, apiKey: `sk-${provider}-test` })],
    });
    return handler(new Request(`http://localhost/api/media-providers/tts/${name}/voices`));
  };

  it.each(ROUTES)("$name voices fetch goes through the proxy", async (route) => {
    mocks.proxyAwareFetch.mockResolvedValue(Response.json(route.body));

    const response = await callRoute(route);

    expect(response.status).toBe(200);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      route.upstream,
      expect.any(Object),
      EXPECTED_PROXY,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(ROUTES)("$name voices fail closed when the proxy lookup fails", async (route) => {
    mocks.getProxyPoolById.mockRejectedValue(new Error("db down"));

    const response = await callRoute(route);

    expect(response.status).toBe(500);
    expect((await response.json()).error).toMatch(/proxy resolution failed/);
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
