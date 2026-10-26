// YAN-1574: dashboard model catalogs must use the connection proxy and fail
// closed when that proxy cannot be resolved.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  getProviderConnectionByIdUnscoped: vi.fn(),
  fetchElevenLabsVoices: vi.fn(),
  refreshClaudeOAuthToken: vi.fn(),
  resolveGatewayAuth: vi.fn(),
  getGatewayConnections: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: vi.fn(),
  proxyAwareFetch: mocks.proxyAwareFetch,
}));
vi.mock("@/lib/network/connectionProxy", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    connectionProxyOptions: async (connection) => {
      const proxy = await mocks.resolveConnectionProxyConfig(connection.providerSpecificData || {});
      return proxy.source === "error" ? null : actual.proxyOptionsFromConfig(proxy);
    },
  };
});
vi.mock("@/models", () => ({
  getProxyPoolById: vi.fn(),
  getProviderConnectionByIdUnscoped: mocks.getProviderConnectionByIdUnscoped,
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

const POOL_CONFIG = {
  source: "pool",
  proxyPoolId: "pool-1",
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://pool.example:8080",
  connectionNoProxy: "",
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
  mocks.resolveConnectionProxyConfig.mockReset().mockResolvedValue(POOL_CONFIG);
  mocks.getProviderConnectionByIdUnscoped.mockReset();
  mocks.fetchElevenLabsVoices.mockReset();
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
    mocks.resolveConnectionProxyConfig.mockResolvedValue({ source: "error" });
    mocks.getProviderConnectionByIdUnscoped.mockResolvedValue(
      proxiedConnection({
        provider: "openai-compatible-test",
        apiKey: "sk-compatible-test",
        providerSpecificData: { baseUrl: "https://compatible.example/v1" },
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
    mocks.resolveConnectionProxyConfig.mockResolvedValue({ source: "error" });

    const result = await resolveLiveModels(
      proxiedConnection({ provider: "cline", accessToken: "cline-token" }),
    );

    expect(result.warning).toMatch(/proxy resolution failed/);
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });
});

describe("gateway voices proxy routing (principal path)", () => {
  const voicesUrl = (provider) => `http://localhost/v1/audio/voices?provider=${provider}`;

  const principalVoices = (provider, { connection, proxyConfig } = {}) => {
    mocks.resolveConnectionProxyConfig.mockReset();
    mocks.resolveConnectionProxyConfig.mockResolvedValue(proxyConfig || POOL_CONFIG);
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

  it("fails closed with 500 and no upstream fetch when proxy resolution errors", async () => {
    const response = await principalVoices("deepgram", {
      connection: credentialedConnection("deepgram"),
      proxyConfig: { source: "error" },
    });

    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toMatch(/proxy resolution failed/);
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });
});
