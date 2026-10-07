// YAN-13: 401/403 from executors with no refresh mechanism must skip the
// futile refreshWithRetry path (~3s of 1s+2s waits per account) and return
// the upstream error immediately. Refresh-capable executors keep the
// existing refresh-and-retry behavior.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { executeMock, refreshCredentialsMock, refreshWithRetryMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  refreshCredentialsMock: vi.fn(),
  refreshWithRetryMock: vi.fn(),
}));

let executorSupportsRefresh = false;

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: false,
    supportsRefresh: executorSupportsRefresh,
    execute: executeMock,
    refreshCredentials: refreshCredentialsMock,
  }),
}));

vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshWithRetry: refreshWithRetryMock,
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

const ZED_403_BODY = JSON.stringify({
  error: { message: 'Access to model "muse-spark-1.3-contributor" is not included in your plan' },
});

function makeOptions(log) {
  return {
    body: {
      model: "muse-spark-1.3-contributor",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    },
    modelInfo: { provider: "zed", model: "muse-spark-1.3-contributor" },
    credentials: { accessToken: "zed-token", providerSpecificData: {} },
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
  };
}

describe("handleChatCore supportsRefresh gate (YAN-13)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshCredentialsMock.mockResolvedValue(null);
  });

  it("skips refreshWithRetry and returns a 403 immediately for no-refresh executors", async () => {
    executorSupportsRefresh = false;
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    executeMock.mockResolvedValue({
      response: new Response(ZED_403_BODY, {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
      url: "https://cloud.zed.dev/completions",
      headers: {},
      transformedBody: null,
    });

    const result = await handleChatCore(makeOptions(log));

    expect(refreshWithRetryMock).not.toHaveBeenCalled();
    expect(refreshCredentialsMock).not.toHaveBeenCalled();
    expect(executeMock).toHaveBeenCalledTimes(1); // no retry after refresh
    expect(result.success).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toContain("not included in your plan");
    // No timing assert: refreshWithRetryMock-not-called + single execute call
    // already prove the skip deterministically.
    expect(log.warn).not.toHaveBeenCalledWith("TOKEN", expect.stringContaining("refresh failed"));
  });

  it("still enters the refresh path for refresh-capable executors on 403", async () => {
    executorSupportsRefresh = true;
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    executeMock.mockResolvedValue({
      response: new Response(ZED_403_BODY, {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
      url: "https://api.example.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    });
    refreshWithRetryMock.mockResolvedValue(null); // refresh fails → original 403 surfaces

    const result = await handleChatCore(makeOptions(log));

    expect(refreshWithRetryMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.status).toBe(403);
  });

  it("keeps refresh-and-retry for refresh-capable executors on 401", async () => {
    executorSupportsRefresh = true;
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({ error: { message: "unauthorized" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
      url: "https://api.example.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    });
    refreshWithRetryMock.mockResolvedValue(null); // refresh fails → original 401 surfaces

    const result = await handleChatCore(makeOptions(log));

    expect(refreshWithRetryMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
  });
});

const { default: ZedExecutor } = await import("../../open-sse/executors/zed.js");
const { BaseExecutor } = await import("../../open-sse/executors/base.js");

describe("executor supportsRefresh capability flag", () => {
  it("Zed opts out of the refresh path", () => {
    const executor = new ZedExecutor();
    expect(executor.supportsRefresh).toBe(false);
    expect(executor.noAuth).toBe(false);
  });

  it("BaseExecutor defaults to refresh-capable so existing providers are unchanged", () => {
    expect(new BaseExecutor("generic", {}).supportsRefresh).toBe(true);
    expect(new BaseExecutor("generic", null).supportsRefresh).toBe(true);
  });
});
