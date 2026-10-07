import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  usage: vi.fn(async () => {}),
  detail: vi.fn(async () => {}),
  appendLog: vi.fn(async () => {}),
  forceStream: false,
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: mocks.appendLog,
  saveRequestUsageUnscoped: mocks.usage,
  saveRequestDetailUnscoped: mocks.detail,
}));
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ execute: mocks.execute, supportsRefresh: false }),
}));
vi.mock("../../open-sse/config/providers.js", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    PROVIDERS: {
      ...original.PROVIDERS,
      openai: {
        ...original.PROVIDERS.openai,
        get forceStream() {
          return mocks.forceStream;
        },
      },
    },
  };
});
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest() {},
    logRawRequest() {},
    logTargetRequest() {},
    logProviderResponse() {},
    logConvertedResponse() {},
    logError() {},
    logStreamChunk() {},
  }),
}));
vi.mock("../../open-sse/services/quotaHeaders.js", () => ({ ingestResponseHeaders() {} }));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const ids = { apiKeyId: "key-id", workspaceId: "workspace-id", userId: "user-id" };
const keylessIds = { workspaceId: "workspace-id", userId: "user-id" };
const tokens = { prompt_tokens: 10, completion_tokens: 5 };
const completion = {
  id: "chatcmpl-test",
  object: "chat.completion",
  model: "gpt-4o",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: tokens,
};
const chatSSE = `data: ${JSON.stringify({ ...completion, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
const responsesSSE = `event: response.completed\ndata: ${JSON.stringify({
  type: "response.completed",
  response: {
    id: "resp-test",
    object: "response",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
    usage: { input_tokens: 10, output_tokens: 5 },
  },
})}\n\n`;

function options(stream, legacy = false, keyless = false) {
  return {
    // Malicious body identity must never become telemetry identity.
    body: {
      model: "gpt-4o",
      stream,
      messages: [{ role: "user", content: "hello" }],
      apiKey: "body-secret",
      apiKeyId: "body-key",
      workspaceId: "body-workspace",
      userId: "body-user",
    },
    modelInfo: { provider: "openai", model: "gpt-4o" },
    credentials: { apiKey: "provider-secret" },
    connectionId: "connection-id",
    apiKey: legacy ? "legacy-raw-key" : null,
    // Keyless owner principal shape from gateway helper: explicit null apiKeyId.
    ...(legacy ? {} : keyless ? { apiKeyId: null, ...keylessIds } : ids),
    clientRawRequest: { endpoint: "/v1/chat/completions", headers: {} },
  };
}

function upstream(body, contentType, status = 200, responseFormat) {
  mocks.execute.mockResolvedValue({
    response: new Response(body, { status, headers: { "content-type": contentType } }),
    transformedBody: {},
    responseFormat,
  });
}
function assertDetails(legacy = false) {
  expect(mocks.detail).toHaveBeenCalled();
  for (const [entry] of mocks.detail.mock.calls) {
    if (legacy) {
      expect(entry).not.toHaveProperty("apiKeyId");
      expect(entry).not.toHaveProperty("workspaceId");
      expect(entry).not.toHaveProperty("userId");
    } else expect(entry).toMatchObject(ids);
    // Raw key was never part of request-detail identity, and remains absent.
    expect(entry).not.toHaveProperty("apiKey");
  }
}
function assertUsage(legacy = false) {
  expect(mocks.usage).toHaveBeenCalledTimes(1);
  const entry = mocks.usage.mock.calls[0][0];
  expect(entry.apiKey).toBe(legacy ? "legacy-raw-key" : undefined);
  if (legacy) expect(entry).not.toHaveProperty("apiKeyId");
  else expect(entry).toMatchObject(ids);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.forceStream = false;
});

describe("gateway chat core ID-only telemetry carrier", () => {
  for (const legacy of [false, true]) {
    it.each(["nonstream", "stream", "converted chat SSE", "converted Responses SSE"])(
      `%s retains ${legacy ? "legacy raw key" : "trusted ID fields"}`,
      async (mode) => {
        const stream = mode === "stream";
        mocks.forceStream = mode.startsWith("converted");
        const responses = mode === "converted Responses SSE";
        upstream(
          responses
            ? responsesSSE
            : stream || mocks.forceStream
              ? chatSSE
              : JSON.stringify(completion),
          stream || mocks.forceStream ? "text/event-stream" : "application/json",
          200,
          responses ? "openai-responses" : undefined,
        );
        const result = await handleChatCore(options(stream, legacy));
        expect(result.success).toBe(true);
        const text = await result.response.text(); // Drain real transform/callback; no provider calls.
        expect(text).toContain("ok");
        assertUsage(legacy);
        assertDetails(legacy);
      },
    );
  }

  it("keyless principal carries workspace/user and no key identity", async () => {
    upstream(JSON.stringify(completion), "application/json");
    const result = await handleChatCore(options(false, false, true));
    expect(result.success).toBe(true);
    const text = await result.response.text(); // Drain real transform/callback; no provider calls.
    expect(text).toContain("ok");
    expect(mocks.usage).toHaveBeenCalledTimes(1);
    const entry = mocks.usage.mock.calls[0][0];
    expect(entry).toMatchObject(keylessIds);
    expect(entry).not.toHaveProperty("apiKeyId");
    expect(entry.apiKey ?? null).toBeNull();
    expect(mocks.detail).toHaveBeenCalled();
    for (const [detail] of mocks.detail.mock.calls) {
      expect(detail).toMatchObject(keylessIds);
      expect(detail.apiKeyId ?? null).toBeNull();
      expect(detail).not.toHaveProperty("apiKey");
    }
  });

  it.each(["throw", "upstream error"])("%s details retain trusted IDs", async (mode) => {
    if (mode === "throw") mocks.execute.mockRejectedValue(new Error("offline"));
    else upstream(JSON.stringify({ error: { message: "unavailable" } }), "application/json", 503);
    const result = await handleChatCore(options(false));
    expect(result.success).toBe(false);
    assertDetails();
    expect(mocks.usage).not.toHaveBeenCalled();
    for (const [entry] of mocks.appendLog.mock.calls) expect(entry).toMatchObject(ids);
  });

  it("mid-stream error callback retains IDs", async () => {
    upstream(
      `${chatSSE.replace("data: [DONE]", 'data: {"error":{"message":"broken"}}\n\ndata: [DONE]')}`,
      "text/event-stream",
    );
    const result = await handleChatCore(options(true));
    await result.response.text();
    assertDetails();
    expect(mocks.detail.mock.calls.at(-1)[0].status).toBe("error");
    assertUsage();
  });
});
