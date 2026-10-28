// YAN-1036: handleChatCore's 401 refresh hands the connection's proxy options
// (including strictProxy) to executor.refreshCredentials.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, refreshCredentialsMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  refreshCredentialsMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: false,
    supportsRefresh: true,
    execute: executeMock,
    refreshCredentials: refreshCredentialsMock,
  }),
}));

vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshWithRetry: async (fn) => fn(),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetailUnscoped: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const PROXY_PSD = {
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://pool.example:8080",
  connectionNoProxy: "",
  vercelRelayUrl: "",
  strictProxy: true,
  connectionProxyPoolId: "pool-1",
};

describe("handleChatCore reactive refresh proxy options (YAN-1036)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshCredentialsMock.mockResolvedValue(null);
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({ error: { message: "token_expired" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
      url: "https://chatgpt.com/backend-api/codex/responses",
      headers: {},
      transformedBody: null,
    });
  });

  it("passes the connection proxy options, including strictProxy, to refreshCredentials", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const credentials = {
      accessToken: "at-old",
      refreshToken: "rt-old",
      providerSpecificData: { ...PROXY_PSD },
    };

    const result = await handleChatCore({
      body: { model: "gpt-5", stream: false, messages: [{ role: "user", content: "hi" }] },
      modelInfo: { provider: "codex", model: "gpt-5" },
      credentials,
      log,
      connectionId: "test-conn",
      rtkEnabled: false,
      headroomEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {},
        headers: { accept: "application/json" },
      },
    });

    expect(result.status).toBe(401);
    expect(refreshCredentialsMock).toHaveBeenCalledTimes(1);
    expect(refreshCredentialsMock).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: "rt-old" }),
      log,
      expect.objectContaining(PROXY_PSD),
    );
  });
  it("returns a generic proxy error without internal details", async () => {
    executeMock.mockRejectedValue(
      new Error("[ProxyFetch] Proxy required but failed (strictProxy=true): refused"),
    );

    const result = await handleChatCore({
      body: { model: "gpt-5", stream: false, messages: [{ role: "user", content: "hi" }] },
      modelInfo: { provider: "codex", model: "gpt-5" },
      credentials: { accessToken: "at", providerSpecificData: { ...PROXY_PSD } },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      connectionId: "test-conn",
      rtkEnabled: false,
      headroomEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toBe("Upstream proxy unavailable");
    expect(result.error).not.toContain("[ProxyFetch]");
    expect(result.error).not.toContain("strictProxy");
    expect(result.error).not.toContain("refused");
    expect(await result.response.text()).toContain("Upstream proxy unavailable");
  });
});
