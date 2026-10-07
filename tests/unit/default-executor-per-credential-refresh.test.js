// YAN-78: per-credential refresh capability on DefaultExecutor.
// API-key-only credentials (no refreshToken) and unknown providers must skip
// the futile refreshWithRetry path (~3s of 1s+2s waits per account) and return
// the upstream error immediately. Handlers consult canRefreshCredentials only
// when the executor exposes it — specialized executors without the method
// (vertex, github, …) keep the legacy always-attempt path, and refreshWithRetry
// itself is unchanged.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { OllamaLocalExecutor } from "../../open-sse/executors/ollama-local.js";

describe("DefaultExecutor.canRefreshCredentials (YAN-78)", () => {
  it("true for a mapped provider with a refreshToken", () => {
    expect(new DefaultExecutor("claude").canRefreshCredentials({ refreshToken: "rt-1" })).toBe(
      true,
    );
  });

  it("false for a mapped provider with an API key but no refreshToken", () => {
    expect(new DefaultExecutor("claude").canRefreshCredentials({ apiKey: "sk-x" })).toBe(false);
  });

  it("false for an unknown provider even with a refreshToken", () => {
    expect(
      new DefaultExecutor("no-such-provider-yan78").canRefreshCredentials({ refreshToken: "rt-1" }),
    ).toBe(false);
  });

  it("subclass inherits the gate; unmapped provider stays false", () => {
    const executor = new OllamaLocalExecutor();
    expect(typeof executor.canRefreshCredentials).toBe("function");
    expect(executor.canRefreshCredentials({ refreshToken: "rt-1" })).toBe(false);
    expect(executor.canRefreshCredentials({ apiKey: "sk-x" })).toBe(false);
  });

  it("null/undefined credentials are not refreshable", () => {
    const executor = new DefaultExecutor("claude");
    expect(executor.canRefreshCredentials(null)).toBe(false);
    expect(executor.canRefreshCredentials(undefined)).toBe(false);
  });
});

const { executeMock, refreshWithRetryMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  refreshWithRetryMock: vi.fn(),
}));
const state = vi.hoisted(() => ({ executor: null }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => state.executor,
}));

vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshWithRetry: refreshWithRetryMock,
  refreshMetaCodeToken: vi.fn(),
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

const UNAUTHORIZED_BODY = JSON.stringify({ error: { message: "unauthorized" } });

function makeOptions(log) {
  return {
    body: {
      model: "gpt-4o",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    },
    modelInfo: { provider: "openai", model: "gpt-4o" },
    credentials: { apiKey: "sk-x", providerSpecificData: {} },
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

function mock401() {
  executeMock.mockResolvedValue({
    response: new Response(UNAUTHORIZED_BODY, {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
    url: "https://api.example.com/v1/chat/completions",
    headers: {},
    transformedBody: null,
  });
}

describe("handleChatCore canRefreshCredentials gate (YAN-78)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock401();
  });

  it("skips refreshWithRetry when canRefreshCredentials returns false (API-key-only credential)", async () => {
    const canRefreshCredentials = vi.fn(() => false);
    const refreshCredentials = vi.fn();
    state.executor = {
      noAuth: false,
      supportsRefresh: true,
      canRefreshCredentials,
      execute: executeMock,
      refreshCredentials,
    };
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await handleChatCore(makeOptions(log));

    expect(canRefreshCredentials).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "sk-x" }));
    expect(refreshWithRetryMock).not.toHaveBeenCalled();
    expect(refreshCredentials).not.toHaveBeenCalled();
    expect(executeMock).toHaveBeenCalledTimes(1); // no retry after refresh
    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
    // No timing assert: refreshWithRetryMock-not-called + single execute call
    // already prove the ~3s skip deterministically.
  });

  it("still attempts refresh when the executor predates the capability (no method — e.g. vertex/github)", async () => {
    state.executor = {
      noAuth: false,
      supportsRefresh: true,
      execute: executeMock,
      refreshCredentials: vi.fn(),
    };
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    refreshWithRetryMock.mockResolvedValue(null); // refresh fails → original 401 surfaces

    const result = await handleChatCore(makeOptions(log));

    expect(refreshWithRetryMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
  });

  it("attempts refresh when canRefreshCredentials returns true (OAuth credential)", async () => {
    state.executor = {
      noAuth: false,
      supportsRefresh: true,
      canRefreshCredentials: () => true,
      execute: executeMock,
      refreshCredentials: vi.fn(),
    };
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    refreshWithRetryMock.mockResolvedValue(null); // refresh fails → original 401 surfaces

    const result = await handleChatCore(makeOptions(log));

    expect(refreshWithRetryMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
  });
});
