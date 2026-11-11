// YAN-1028: raw upstream SSE aggregated to one JSON body must be translated to
// OpenAI chat first (Claude SSE has no `choices`) and must keep refusals.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetailUnscoped: vi.fn(async () => {}),
  saveRequestUsageUnscoped: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(async () => {}),
}));

vi.mock("open-sse/services/usageSink.js", async () => import("@/lib/usageDb.js"));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { parseSSEToOpenAIResponse, handleForcedSSEToJson } = await import(
  "../../open-sse/handlers/chatCore/sseToJsonHandler.js"
);
const { handleNonStreamingResponse } = await import(
  "../../open-sse/handlers/chatCore/nonStreamingHandler.js"
);
const { createSSETransformStreamWithLogger } = await import("../../open-sse/utils/stream.js");

const claudeEvent = (e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}`;
const claudeSse = (events) => `${events.map(claudeEvent).join("\n\n")}\n\n`;
const start = {
  type: "message_start",
  message: { id: "msg_1", model: "claude-x", usage: { input_tokens: 7, output_tokens: 0 } },
};
const stop = { type: "message_stop" };
const textEvents = [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
  { type: "content_block_stop", index: 0 },
];
const messageDelta = (stop_reason, stop_details) => ({
  type: "message_delta",
  delta: { stop_reason, ...(stop_details ? { stop_details } : {}) },
  usage: { output_tokens: 3 },
});
const refusalDetails = { type: "refusal", category: "cyber", explanation: "X" };
const CLAUDE_TEXT_SSE = claudeSse([start, ...textEvents, messageDelta("end_turn"), stop]);
const CLAUDE_REFUSAL_SSE = claudeSse([start, messageDelta("refusal", refusalDetails), stop]);

const openaiSse = (chunks) =>
  `${chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
const chatChunk = (delta, finish = null) => ({
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  created: 1700000000,
  model: "gpt-x",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

const sseResponse = (raw) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(raw));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );

const baseCtx = (raw, sourceFormat, targetFormat) => ({
  providerResponse: sseResponse(raw),
  sourceFormat,
  targetFormat,
  provider: "claude-sse",
  model: "claude-x",
  body: { model: "claude-x", messages: [] },
  stream: false,
  requestStartTime: Date.now(),
  connectionId: "c1",
  clientRawRequest: { endpoint: "/v1/chat/completions" },
  trackDone: vi.fn(),
  appendLog: vi.fn(),
});

const nonStreamCtx = (raw, sourceFormat, targetFormat) => ({
  ...baseCtx(raw, sourceFormat, targetFormat),
  reqLogger: { logProviderResponse() {}, logConvertedResponse() {} },
  toolNameMap: null,
  customToolNames: null,
});

describe("parseSSEToOpenAIResponse", () => {
  it("collects OpenAI delta.refusal into message.refusal and keeps content_filter", () => {
    const out = parseSSEToOpenAIResponse(
      openaiSse([
        chatChunk({ role: "assistant" }),
        chatChunk({ refusal: "I can" }),
        chatChunk({ refusal: "'t." }, "content_filter"),
      ]),
      "gpt-x",
    );
    expect(out.choices[0].finish_reason).toBe("content_filter");
    expect(out.choices[0].message.refusal).toBe("I can't.");
  });

  it("OpenAI body without refusal carries no refusal key", () => {
    const out = parseSSEToOpenAIResponse(
      openaiSse([chatChunk({ content: "hi" }), chatChunk({}, "stop")]),
      "gpt-x",
    );
    expect(out.choices[0].message).toEqual({ role: "assistant", content: "hi" });
  });

  it("translates Claude SSE text before aggregating", () => {
    const out = parseSSEToOpenAIResponse(CLAUDE_TEXT_SSE, "fallback", { format: FORMATS.CLAUDE });
    expect(out.object).toBe("chat.completion");
    expect(out.model).toBe("claude-x");
    expect(out.choices[0].message.content).toBe("Hello");
    expect(out.choices[0].finish_reason).toBe("stop");
    expect(out.usage).toMatchObject({ prompt_tokens: 7, completion_tokens: 3 });
  });

  it("translates a Claude SSE refusal into content_filter + message.refusal", () => {
    const out = parseSSEToOpenAIResponse(CLAUDE_REFUSAL_SSE, "fallback", {
      format: FORMATS.CLAUDE,
    });
    expect(out.choices[0].finish_reason).toBe("content_filter");
    expect(out.choices[0].message.refusal).toBe("X");
  });
});

describe("handleForcedSSEToJson with a Claude-format upstream", () => {
  it("OpenAI client receives the Claude text", async () => {
    const result = await handleForcedSSEToJson(
      baseCtx(CLAUDE_TEXT_SSE, FORMATS.OPENAI, FORMATS.CLAUDE),
    );
    const json = await result.response.json();
    expect(json.choices[0].message.content).toBe("Hello");
    expect(json.choices[0].finish_reason).toBe("stop");
  });

  it("OpenAI client receives the refusal", async () => {
    const result = await handleForcedSSEToJson(
      baseCtx(CLAUDE_REFUSAL_SSE, FORMATS.OPENAI, FORMATS.CLAUDE),
    );
    const json = await result.response.json();
    expect(json.choices[0].finish_reason).toBe("content_filter");
    expect(json.choices[0].message.refusal).toBe("X");
  });

  // YAN-1842: Claude → Claude is aggregated natively, so the upstream
  // stop_details (including the category) passes through unchanged.
  it("Claude client gets stop_reason refusal with the upstream stop_details", async () => {
    const result = await handleForcedSSEToJson(
      baseCtx(CLAUDE_REFUSAL_SSE, FORMATS.CLAUDE, FORMATS.CLAUDE),
    );
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expect(json.stop_reason).toBe("refusal");
    expect(json.stop_details).toEqual(refusalDetails);
  });
});

describe("handleNonStreamingResponse text/event-stream fallback", () => {
  it("Claude upstream SSE → OpenAI client (no double translation)", async () => {
    const result = await handleNonStreamingResponse(
      nonStreamCtx(CLAUDE_TEXT_SSE, FORMATS.OPENAI, FORMATS.CLAUDE),
    );
    const json = await result.response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("Hello");
    expect(json.choices[0].finish_reason).toBe("stop");
  });

  it("Claude upstream SSE refusal → Claude client", async () => {
    const result = await handleNonStreamingResponse(
      nonStreamCtx(CLAUDE_REFUSAL_SSE, FORMATS.CLAUDE, FORMATS.CLAUDE),
    );
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expect(json.stop_reason).toBe("refusal");
    expect(json.stop_details).toEqual(refusalDetails);
  });

  it("Claude upstream SSE refusal → Responses client", async () => {
    const result = await handleNonStreamingResponse(
      nonStreamCtx(CLAUDE_REFUSAL_SSE, FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE),
    );
    const json = await result.response.json();
    expect(json.object).toBe("response");
    expect(json.status).toBe("incomplete");
    expect(json.incomplete_details).toEqual({ reason: "content_filter" });
    expect(json.output[0].content).toEqual([{ type: "refusal", refusal: "X" }]);
  });

  it("OpenAI upstream SSE refusal → OpenAI client keeps message.refusal", async () => {
    const result = await handleNonStreamingResponse(
      nonStreamCtx(
        openaiSse([chatChunk({ refusal: "No." }, "content_filter")]),
        FORMATS.OPENAI,
        FORMATS.OPENAI,
      ),
    );
    const json = await result.response.json();
    expect(json.choices[0].finish_reason).toBe("content_filter");
    expect(json.choices[0].message.refusal).toBe("No.");
  });
});

describe("streaming OpenAI upstream → Claude client", () => {
  it("content_filter becomes stop_reason refusal", async () => {
    const source = new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            openaiSse([
              chatChunk({ role: "assistant", content: "par" }),
              chatChunk({ refusal: "No." }, "content_filter"),
            ]),
          ),
        );
        c.close();
      },
    });
    const stream = createSSETransformStreamWithLogger(
      FORMATS.OPENAI,
      FORMATS.CLAUDE,
      "openai",
      null,
      null,
      "gpt-x",
      null,
      { messages: [] },
      () => {},
    );
    const reader = source.pipeThrough(stream).getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += typeof value === "string" ? value : decoder.decode(value);
    }
    const events = out
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
    const delta = events.find((e) => e.type === "message_delta");
    expect(delta.delta.stop_reason).toBe("refusal");
    expect(delta.delta.stop_details).toEqual({ type: "refusal", explanation: "No." });
    expect(events.some((e) => e.delta?.text === "par")).toBe(true);
  });
});

// ---- Review follow-ups (YAN-1028) ----

const { saveRequestUsageUnscoped } = await import("@/lib/usageDb.js");

const cachedStart = {
  type: "message_start",
  message: {
    id: "msg_2",
    model: "claude-x",
    usage: {
      input_tokens: 7,
      output_tokens: 0,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
    },
  },
};
const CLAUDE_CACHED_SSE = claudeSse([cachedStart, ...textEvents, messageDelta("end_turn"), stop]);
// canonical storage: prompt includes cache read + write; each is a subset.
const CANONICAL_CACHED_USAGE = {
  prompt_tokens: 127,
  completion_tokens: 3,
  total_tokens: 130,
  cached_tokens: 100,
  cache_creation_input_tokens: 20,
};

const responsesEvent = (data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}`;
const responsesSse = (events) => `${events.map(responsesEvent).join("\n\n")}\n\n`;

const geminiChunk = (text, extra = {}) => ({
  candidates: [{ content: { role: "model", parts: [{ text }] }, index: 0, ...extra }],
  modelVersion: "gemini-x",
  responseId: "r1",
});

describe("aggregator review follow-ups", () => {
  it("OpenAI-shaped SSE under a Claude target format still aggregates", () => {
    const out = parseSSEToOpenAIResponse(
      openaiSse([chatChunk({ role: "assistant", content: "Hi" }), chatChunk({}, "stop")]),
      "fallback",
      { format: FORMATS.CLAUDE },
    );
    expect(out.model).toBe("gpt-x");
    expect(out.choices[0].message.content).toBe("Hi");
    expect(out.choices[0].finish_reason).toBe("stop");
  });

  it("Responses upstream: the real model wins over the fallback", () => {
    const out = parseSSEToOpenAIResponse(
      responsesSse([
        { type: "response.created", response: { id: "resp_1", model: "gpt-r" } },
        { type: "response.output_text.delta", item_id: "m", delta: "Yo" },
        { type: "response.completed", response: { id: "resp_1", model: "gpt-r" } },
      ]),
      "fallback",
      { format: FORMATS.OPENAI_RESPONSES },
    );
    expect(out.model).toBe("gpt-r");
    expect(out.choices[0].message.content).toBe("Yo");
  });

  it("Responses upstream without a model falls back to the requested model", () => {
    const out = parseSSEToOpenAIResponse(
      responsesSse([
        { type: "response.output_text.delta", item_id: "m", delta: "Yo" },
        { type: "response.completed", response: { id: "resp_1" } },
      ]),
      "fallback",
      { format: FORMATS.OPENAI_RESPONSES },
    );
    expect(out.model).toBe("fallback");
  });

  it("Responses upstream refusal → message.refusal + content_filter", () => {
    const out = parseSSEToOpenAIResponse(
      responsesSse([
        { type: "response.created", response: { id: "resp_1", model: "gpt-r" } },
        { type: "response.refusal.delta", item_id: "m", content_index: 0, delta: "I can" },
        { type: "response.refusal.delta", item_id: "m", content_index: 0, delta: "'t." },
        {
          type: "response.incomplete",
          response: { id: "resp_1", incomplete_details: { reason: "content_filter" } },
        },
      ]),
      "fallback",
      { format: FORMATS.OPENAI_RESPONSES },
    );
    expect(out.choices[0].message.refusal).toBe("I can't.");
    expect(out.choices[0].finish_reason).toBe("content_filter");
  });

  // YAN-1848: a Responses function call cut off by max_output_tokens or
  // content_filter reports the cut-off, not tool_calls, on the stream-parse
  // path and through handleNonStreamingResponse's tool-call normalization.
  const cutOffCall = (reason) =>
    responsesSse([
      { type: "response.created", response: { id: "resp_1", model: "gpt-r" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", call_id: "call_1", name: "lookup", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"q":"par' },
      { type: "response.incomplete", response: { id: "resp_1", incomplete_details: { reason } } },
    ]);

  it.each([
    ["max_output_tokens", "length"],
    ["content_filter", "content_filter"],
  ])("Responses function_call + %s → %s on both non-stream paths", async (reason, finish) => {
    const parsed = parseSSEToOpenAIResponse(cutOffCall(reason), "fallback", {
      format: FORMATS.OPENAI_RESPONSES,
    });
    expect(parsed.choices[0].finish_reason).toBe(finish);
    expect(parsed.choices[0].message.tool_calls[0].function.arguments).toBe('{"q":"par');

    const result = await handleNonStreamingResponse(
      nonStreamCtx(cutOffCall(reason), FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES),
    );
    const json = await result.response.json();
    expect(json.choices[0].finish_reason).toBe(finish);
    expect(json.choices[0].message.tool_calls[0].function.arguments).toBe('{"q":"par');
  });

  const jsonCtx = (body, targetFormat) => ({
    ...nonStreamCtx("", FORMATS.OPENAI, targetFormat),
    providerResponse: new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    }),
  });

  it.each([
    [
      "Claude max_tokens + tool_use",
      FORMATS.CLAUDE,
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-x",
        content: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "par" } }],
        stop_reason: "max_tokens",
        usage: { input_tokens: 3, output_tokens: 9 },
      },
    ],
    [
      "Gemini MAX_TOKENS + functionCall",
      FORMATS.GEMINI,
      {
        candidates: [
          {
            content: { role: "model", parts: [{ functionCall: { name: "lookup", args: {} } }] },
            finishReason: "MAX_TOKENS",
            index: 0,
          },
        ],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 9, totalTokenCount: 12 },
      },
    ],
  ])("%s → chat client finish_reason length", async (_name, targetFormat, body) => {
    const result = await handleNonStreamingResponse(jsonCtx(body, targetFormat));
    const json = await result.response.json();
    expect(json.choices[0].finish_reason).toBe("length");
    expect(json.choices[0].message.tool_calls).toHaveLength(1);
  });

  it("non-standard finish (other) with tool calls still normalizes to tool_calls", async () => {
    const result = await handleNonStreamingResponse(
      jsonCtx(
        {
          id: "chatcmpl-1",
          object: "chat.completion",
          model: "gpt-x",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "lookup", arguments: '{"q":"x"}' },
                  },
                ],
              },
              finish_reason: "other",
            },
          ],
        },
        FORMATS.OPENAI,
      ),
    );
    const json = await result.response.json();
    expect(json.choices[0].finish_reason).toBe("tool_calls");
  });

  it("non-stream SSE path records Claude cache read + write as canonical usage", async () => {
    vi.mocked(saveRequestUsageUnscoped).mockClear();
    const result = await handleNonStreamingResponse(
      nonStreamCtx(CLAUDE_CACHED_SSE, FORMATS.OPENAI, FORMATS.CLAUDE),
    );
    expect(result.success).toBe(true);
    expect(saveRequestUsageUnscoped).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveRequestUsageUnscoped).mock.calls[0][0].tokens).toMatchObject(
      CANONICAL_CACHED_USAGE,
    );
  });

  it("forced SSE path records Claude cache read + write as canonical usage", async () => {
    vi.mocked(saveRequestUsageUnscoped).mockClear();
    const result = await handleForcedSSEToJson(
      baseCtx(CLAUDE_CACHED_SSE, FORMATS.OPENAI, FORMATS.CLAUDE),
    );
    expect(result.success).toBe(true);
    expect(saveRequestUsageUnscoped).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveRequestUsageUnscoped).mock.calls[0][0].tokens).toMatchObject(
      CANONICAL_CACHED_USAGE,
    );
  });

  it("Gemini upstream SSE → Claude client through the non-stream SSE fallback", async () => {
    const raw = openaiSse([
      geminiChunk("Hel"),
      geminiChunk("lo", { finishReason: "STOP" }),
    ]).replace("data: [DONE]\n\n", "");
    const result = await handleNonStreamingResponse(
      nonStreamCtx(raw, FORMATS.CLAUDE, FORMATS.GEMINI),
    );
    const json = await result.response.json();
    expect(json.type).toBe("message");
    expect(json.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(json.stop_reason).toBe("end_turn");
  });
});

describe("cache-write-only usage (no double count)", () => {
  it("non-stream SSE path folds a first cache write exactly once", async () => {
    vi.mocked(saveRequestUsageUnscoped).mockClear();
    const writeOnlyStart = {
      type: "message_start",
      message: {
        id: "msg_3",
        model: "claude-x",
        usage: { input_tokens: 7, output_tokens: 0, cache_creation_input_tokens: 20 },
      },
    };
    const raw = claudeSse([writeOnlyStart, ...textEvents, messageDelta("end_turn"), stop]);
    await handleNonStreamingResponse(nonStreamCtx(raw, FORMATS.OPENAI, FORMATS.CLAUDE));
    expect(vi.mocked(saveRequestUsageUnscoped).mock.calls[0][0].tokens).toMatchObject({
      prompt_tokens: 27,
      cached_tokens: 0,
      cache_creation_input_tokens: 20,
    });
  });
});
