// handleChatCore → executor boundary for Claude adaptive/budget thinking (YAN-1051).
// Asserts on the body the (mocked) executor receives, on both the Claude Code
// passthrough path and the translated path.
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
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

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetailUnscoped: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}), // release/1.0 uses the legacy export
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const CLAUDE_CODE_UA = "claude-cli/2.1.0";

async function run({
  body,
  model,
  userAgent,
  providerThinking,
  sourceFormatOverride,
  provider = "anthropic",
}) {
  await handleChatCore({
    body,
    modelInfo: { provider, model },
    credentials: { apiKey: "test-key", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    connectionId: "test-connection",
    rtkEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: false,
    providerThinking,
    sourceFormatOverride,
    clientRawRequest: {
      endpoint: sourceFormatOverride === "claude" ? "/v1/messages" : "/v1/chat/completions",
      body,
      headers: { accept: "application/json", "user-agent": userAgent },
    },
  });
  return executeMock.mock.calls.at(-1)[0].body;
}

const claudeCode = (model, extra = {}, providerThinking) => {
  const body = {
    model: `anthropic/${model}`,
    max_tokens: 1024,
    stream: false,
    messages: [{ role: "user", content: "hello" }],
    ...extra,
  };
  return {
    body,
    promise: run({
      body,
      model,
      userAgent: CLAUDE_CODE_UA,
      providerThinking,
      sourceFormatOverride: "claude",
    }),
  };
};

const translated = (model, extra) =>
  run({
    body: {
      model: `anthropic/${model}`,
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
      ...extra,
    },
    model,
    userAgent: "openai-node/4.0",
    sourceFormatOverride: "openai",
  });

describe("Claude thinking at the executor boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockImplementation(async () => ({
      response: new Response("{}", { status: 200 }),
      url: "https://api.anthropic.com/v1/messages",
      headers: {},
      transformedBody: null,
    }));
  });

  it("(a) provider thinking on + no client thinking → Haiku 5.5 gets adaptive, never enabled", async () => {
    const up = await claudeCode("claude-haiku-5-5", {}, { mode: "on" }).promise;
    expect(up.thinking.type).toBe("adaptive");
  });

  it("(b) translated Haiku 5.5 reasoning_effort xhigh → adaptive effort xhigh, never enabled", async () => {
    const up = await translated("claude-haiku-5-5", { reasoning_effort: "xhigh" });
    expect(up.thinking?.type).not.toBe("enabled");
    expect(up.output_config.effort).toBe("xhigh");
  });

  it("(b2) translated Haiku 4.5 reasoning_effort high → enabled + numeric budget, no effort", async () => {
    const up = await translated("claude-haiku-4-5", { reasoning_effort: "high" });
    expect(up.thinking.type).toBe("enabled");
    expect(typeof up.thinking.budget_tokens).toBe("number");
    expect(up.output_config?.effort).toBeUndefined();
  });

  it("(c) Haiku 4.5 passthrough strips effort upstream without mutating the original body", async () => {
    const outputConfig = { effort: "high", other: "x" };
    const { body, promise } = claudeCode("claude-haiku-4-5", { output_config: outputConfig });
    const up = await promise;
    expect(body.output_config).toBe(outputConfig);
    expect(outputConfig).toEqual({ effort: "high", other: "x" });
    expect(up.output_config?.effort).toBeUndefined();
    expect(up.output_config.other).toBe("x");
  });

  it("(d) provider off keeps client thinking and injects no reasoning_effort", async () => {
    const up = await claudeCode(
      "claude-sonnet-5-5",
      { thinking: { type: "adaptive" } },
      { mode: "off" },
    ).promise;
    expect(up.reasoning_effort).toBeUndefined();
    expect(up.thinking.type).toBe("adaptive");
  });

  it("(d2) provider off without client thinking never sends disabled to a no-disable model", async () => {
    const up = await claudeCode("claude-sonnet-5-5", {}, { mode: "off" }).promise;
    expect(up.thinking).not.toEqual({ type: "disabled" });
  });

  it("(e) Haiku 5.5 forced tool_choice any passes through unchanged", async () => {
    const tool_choice = { type: "any" };
    const up = await claudeCode("claude-haiku-5-5", {
      tool_choice,
      tools: [{ name: "t", description: "d", input_schema: { type: "object", properties: {} } }],
      thinking: { type: "enabled", budget_tokens: 4000 },
    }).promise;
    expect(up.tool_choice).toEqual({ type: "any" });
    expect(up.thinking.type).toBe("adaptive");
  });

  // Non-native Claude→Claude: a Claude-format client that is NOT Claude Code, so
  // translateRequest (same-format applyThinking) runs instead of the passthrough.
  const claudeTranslated = (model, extra, provider = "anthropic", providerThinking) => {
    const body = {
      model: `${provider}/${model}`,
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
      ...extra,
    };
    return {
      body,
      promise: run({
        body,
        model,
        provider,
        providerThinking,
        userAgent: "my-sdk/1.0",
        sourceFormatOverride: "claude",
      }),
    };
  };

  it.each(["low", "medium", "high", "xhigh", "max"])(
    "(f) translated Haiku 5.5 disabled + effort %s stays disabled and keeps exact effort",
    async (effort) => {
      const outputConfig = { effort, format: { type: "json_schema" } };
      const { body, promise } = claudeTranslated("claude-haiku-5-5", {
        thinking: { type: "disabled" },
        output_config: outputConfig,
      });
      const up = await promise;
      expect(up.thinking).toEqual({ type: "disabled" });
      expect(up.output_config).toEqual({ effort, format: { type: "json_schema" } });
      expect(body.output_config).toBe(outputConfig);
      expect(outputConfig).toEqual({ effort, format: { type: "json_schema" } });
    },
  );

  it("(g) translated Haiku 5.5 model suffix (none) still wins over body effort", async () => {
    const { promise } = claudeTranslated("claude-haiku-5-5(none)", {
      thinking: { type: "disabled" },
      output_config: { effort: "max" },
    });
    const up = await promise;
    expect(up.thinking).toEqual({ type: "disabled" });
  });

  it("(h) normal adaptive translation keeps output_config.format, originals untouched", async () => {
    const outputConfig = { effort: "low", format: { type: "json_schema", schema: { a: 1 } } };
    const thinking = { type: "adaptive" };
    const { body, promise } = claudeTranslated("claude-haiku-5-5", {
      thinking,
      output_config: outputConfig,
    });
    const up = await promise;
    expect(up.output_config).toEqual({
      effort: "low",
      format: { type: "json_schema", schema: { a: 1 } },
    });
    expect(body.thinking).toBe(thinking);
    expect(body.output_config).toBe(outputConfig);
    expect(outputConfig.effort).toBe("low");
  });

  it("(i) third-party anthropic-compatible-x translated Haiku 5.5 stays budget", async () => {
    const up = await run({
      body: {
        model: "anthropic-compatible-x/claude-haiku-5-5",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
        reasoning_effort: "high",
      },
      model: "claude-haiku-5-5",
      provider: "anthropic-compatible-x",
      userAgent: "openai-node/4.0",
      sourceFormatOverride: "openai",
    });
    expect(up.thinking.type).toBe("enabled");
    expect(typeof up.thinking.budget_tokens).toBe("number");
    expect(up.output_config?.effort).toBeUndefined();
  });

  it.each([
    ["thinking", { thinking: { type: "enabled", budget_tokens: 2000 } }],
    ["reasoning_effort", { reasoning_effort: "low" }],
    ["output_config.effort", { output_config: { effort: "low" } }],
  ])("(j) provider mode high/on/off never overrides explicit client %s", async (_name, extra) => {
    for (const mode of ["high", "on", "off"]) {
      executeMock.mockClear();
      const up = await claudeTranslated("claude-haiku-4-5", extra, "anthropic", { mode }).promise;
      expect(up.thinking?.type, mode).toBe("enabled");
      expect(up.thinking?.budget_tokens, mode).toBe(
        extra.thinking ? 2000 : up.thinking?.budget_tokens,
      );
      expect(up.output_config?.effort, mode).toBeUndefined();
    }
  });

  it("(k) provider mode on with no client intent still injects enabled+budget (budget model)", async () => {
    const up = await claudeTranslated("claude-haiku-4-5", {}, "anthropic", { mode: "on" }).promise;
    expect(up.thinking).toMatchObject({ type: "enabled" });
  });

  it("(l) same-format combo/account retry never mutates the caller body", async () => {
    const thinking = { type: "adaptive" };
    const outputConfig = { effort: "xhigh", format: { type: "json_schema" } };
    const original = {
      model: "anthropic/claude-sonnet-4-6",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
      thinking,
      output_config: outputConfig,
    };
    const snapshot = JSON.parse(JSON.stringify(original));
    await run({
      body: original,
      model: "claude-sonnet-4-6",
      userAgent: "my-sdk/1.0",
      sourceFormatOverride: "claude",
    });
    expect(original.thinking).toBe(thinking);
    expect(original.output_config).toBe(outputConfig);
    expect(original).toEqual(snapshot);
  });

  it("(m) sequential combo attempts: second model still sees the original disabled/effort/format", async () => {
    const thinking = { type: "disabled" };
    const outputConfig = { effort: "max", format: { type: "json_schema" } };
    const original = {
      model: "x",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
      thinking,
      output_config: outputConfig,
    };
    const snapshot = JSON.parse(JSON.stringify(original));
    const attempt = (model) =>
      run({
        body: { ...original, model: `anthropic/${model}` },
        model,
        userAgent: "my-sdk/1.0",
        sourceFormatOverride: "claude",
      });
    const first = await attempt("claude-sonnet-5-5");
    expect(first.thinking?.type).not.toBe("disabled");
    expect(original).toEqual(snapshot);
    expect(original.thinking).toBe(thinking);
    expect(original.output_config).toBe(outputConfig);
    const second = await attempt("claude-haiku-5-5");
    expect(second.thinking).toEqual({ type: "disabled" });
    expect(second.output_config).toEqual({ effort: "max", format: { type: "json_schema" } });
    expect(original).toEqual(snapshot);
  });
});
