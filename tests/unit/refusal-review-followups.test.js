// PR #1100 review follow-ups (YAN-1027 / YAN-1028): refusals and truncation
// survive the remaining stream / non-stream / Codex aggregation paths.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetailUnscoped: vi.fn(async () => {}),
  saveRequestUsageUnscoped: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(async () => {}),
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { initState } = await import("../../open-sse/translator/index.js");
const { openaiToOpenAIResponsesResponse } = await import(
  "../../open-sse/translator/response/openai-responses.js"
);
const { openaiToClaudeResponse } = await import(
  "../../open-sse/translator/response/openai-to-claude.js"
);
const { hasValuableContent } = await import("../../open-sse/utils/streamHelpers.js");
const { createSSETransformStreamWithLogger } = await import("../../open-sse/utils/stream.js");
const { parseSSEToOpenAIResponse, handleForcedSSEToJson } = await import(
  "../../open-sse/handlers/chatCore/sseToJsonHandler.js"
);
const { handleNonStreamingResponse, translateNonStreamingResponse } = await import(
  "../../open-sse/handlers/chatCore/nonStreamingHandler.js"
);
const { extractUsageFromResponse } = await import(
  "../../open-sse/handlers/chatCore/requestDetail.js"
);

const chatChunk = (delta, finish = null, extra = {}) => ({
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  created: 1700000000,
  model: "gpt-x",
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...extra,
});
const openaiSse = (chunks) =>
  `${chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
const namedSse = (events) =>
  `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}`).join("\n\n")}\n\n`;

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

const ctx = (raw, sourceFormat, targetFormat, extra = {}) => ({
  providerResponse: sseResponse(raw),
  sourceFormat,
  targetFormat,
  provider: "test-provider",
  model: "m",
  body: { model: "m", messages: [] },
  stream: false,
  requestStartTime: Date.now(),
  connectionId: "c1",
  clientRawRequest: { endpoint: "/v1/chat/completions" },
  reqLogger: { logProviderResponse() {}, logConvertedResponse() {} },
  toolNameMap: null,
  customToolNames: null,
  trackDone: vi.fn(),
  appendLog: vi.fn(),
  onRequestSuccess: vi.fn(),
  ...extra,
});

async function pipe(raw, targetFormat, sourceFormat) {
  const source = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(raw));
      c.close();
    },
  });
  const stream = createSSETransformStreamWithLogger(
    targetFormat,
    sourceFormat,
    "test-provider",
    null,
    null,
    "m",
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
  return out
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));
}

const responsesRefusalEvents = [
  { type: "response.created", response: { id: "resp_1", model: "gpt-r" } },
  { type: "response.refusal.delta", item_id: "m", content_index: 0, delta: "I can" },
  { type: "response.refusal.delta", item_id: "m", content_index: 0, delta: "'t." },
  {
    type: "response.incomplete",
    response: { id: "resp_1", incomplete_details: { reason: "content_filter" } },
  },
];

describe("1. refusal-only chat chunks are valuable", () => {
  it("hasValuableContent keeps a delta.refusal chunk with no finish_reason", () => {
    expect(hasValuableContent(chatChunk({ refusal: "No." }), FORMATS.OPENAI)).toBeTruthy();
    expect(hasValuableContent(chatChunk({ refusal: "" }), FORMATS.OPENAI)).toBeFalsy();
  });

  it("Responses upstream refusal streams to a chat client with text + content_filter", async () => {
    const chunks = await pipe(
      namedSse(responsesRefusalEvents),
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI,
    );
    const refusal = chunks.map((c) => c.choices?.[0]?.delta?.refusal || "").join("");
    expect(refusal).toBe("I can't.");
    const fin = chunks.filter((c) => c.choices?.[0]?.finish_reason);
    expect(fin).toHaveLength(1);
    expect(fin[0].choices[0].finish_reason).toBe("content_filter");
  });
});

describe("2. Kiro SSE still goes through its translator", () => {
  it("restores the sanitized tool name from toolNameMap", () => {
    const out = parseSSEToOpenAIResponse(
      openaiSse([
        chatChunk({
          tool_calls: [
            { index: 0, id: "t1", type: "function", function: { name: "safe_x", arguments: "{}" } },
          ],
        }),
        chatChunk({}, "tool_calls"),
      ]),
      "m",
      { format: FORMATS.KIRO, toolNameMap: new Map([["safe_x", "mcp__x.y"]]) },
    );
    expect(out.choices[0].message.tool_calls[0].function.name).toBe("mcp__x.y");
  });
});

describe("3. non-stream SSE stream error is a 502", () => {
  it("returns 502 with the upstream message and never reports success", async () => {
    const c = ctx(
      openaiSse([chatChunk({ content: "partial" })]).replace(
        "data: [DONE]",
        `data: ${JSON.stringify({ error: { message: "upstream broke" } })}\n\ndata: [DONE]`,
      ),
      FORMATS.OPENAI,
      FORMATS.OPENAI,
    );
    const result = await handleNonStreamingResponse(c);
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    expect((await result.response.json()).error.message).toContain("upstream broke");
    expect(c.appendLog).toHaveBeenCalledWith({ status: "FAILED 502" });
    expect(c.onRequestSuccess).not.toHaveBeenCalled();
  });
});

describe("4. OpenAI refusal with finish_reason stop → Claude refusal", () => {
  const body = (message, finish_reason) => ({
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "gpt-x",
    choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason }],
  });

  it("non-stream: stop + message.refusal → stop_reason refusal", () => {
    const out = translateNonStreamingResponse(
      body({ content: null, refusal: "No." }, "stop"),
      FORMATS.OPENAI,
      FORMATS.CLAUDE,
    );
    expect(out.stop_reason).toBe("refusal");
    expect(out.stop_details).toEqual({ type: "refusal", explanation: "No." });
  });

  it("non-stream: length + refusal keeps max_tokens", () => {
    const out = translateNonStreamingResponse(
      body({ content: "x", refusal: "No." }, "length"),
      FORMATS.OPENAI,
      FORMATS.CLAUDE,
    );
    expect(out.stop_reason).toBe("max_tokens");
    expect(out).not.toHaveProperty("stop_details");
  });

  it("non-stream: stop without refusal stays end_turn", () => {
    const out = translateNonStreamingResponse(
      body({ content: "hi" }, "stop"),
      FORMATS.OPENAI,
      FORMATS.CLAUDE,
    );
    expect(out.stop_reason).toBe("end_turn");
    expect(out).not.toHaveProperty("stop_details");
  });

  it("stream: stop + delta.refusal → message_delta stop_reason refusal", () => {
    const state = { toolCalls: new Map() };
    const events = [chatChunk({ refusal: "No." }), chatChunk({}, "stop")].flatMap(
      (c) => openaiToClaudeResponse(c, state) || [],
    );
    const md = events.find((e) => e.type === "message_delta");
    expect(md.delta.stop_reason).toBe("refusal");
    expect(md.delta.stop_details).toEqual({ type: "refusal", explanation: "No." });
  });

  it("stream: tool_calls + refusal keeps tool_use", () => {
    const state = { toolCalls: new Map() };
    const events = [
      chatChunk({ refusal: "No." }),
      chatChunk({
        tool_calls: [{ index: 0, id: "t1", function: { name: "f", arguments: "{}" } }],
      }),
      chatChunk({}, "tool_calls"),
    ].flatMap((c) => openaiToClaudeResponse(c, state) || []);
    const md = events.find((e) => e.type === "message_delta");
    expect(md.delta.stop_reason).toBe("tool_use");
    expect(md.delta).not.toHaveProperty("stop_details");
  });
});

describe("5. streamed length → Responses incomplete / max_output_tokens", () => {
  it("ends with response.incomplete and an incomplete message", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const events = [
      chatChunk({ role: "assistant", content: "cut" }),
      chatChunk({}, "length"),
      null,
    ].flatMap((c) => openaiToOpenAIResponsesResponse(c, state));
    const done = events[events.length - 1];
    expect(done.event).toBe("response.incomplete");
    expect(done.data.response.status).toBe("incomplete");
    expect(done.data.response.incomplete_details).toEqual({ reason: "max_output_tokens" });
    expect(done.data.response.output[0].status).toBe("incomplete");
    const itemDone = events.find((e) => e.event === "response.output_item.done");
    expect(itemDone.data.item.status).toBe("incomplete");
  });
});

describe("6. Codex/Responses upstream → non-Responses client", () => {
  const codexCtx = (events, sourceFormat) =>
    ctx(namedSse(events), sourceFormat, FORMATS.OPENAI_RESPONSES, { provider: "codex" });
  const refusalItem = {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "message",
      role: "assistant",
      status: "incomplete",
      content: [{ type: "refusal", refusal: "No." }],
    },
  };
  const textItem = (text) => ({
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  });
  const incomplete = (reason) => ({
    type: "response.incomplete",
    response: { incomplete_details: { reason }, usage: { input_tokens: 1, output_tokens: 1 } },
  });

  it("refusal + content_filter → message.refusal + finish_reason content_filter", async () => {
    const result = await handleForcedSSEToJson(
      codexCtx([refusalItem, incomplete("content_filter")], FORMATS.OPENAI),
    );
    const json = await result.response.json();
    expect(json.choices[0].message.refusal).toBe("No.");
    expect(json.choices[0].finish_reason).toBe("content_filter");
  });

  it("max_output_tokens → finish_reason length (never incomplete)", async () => {
    const result = await handleForcedSSEToJson(
      codexCtx([textItem("cut"), incomplete("max_output_tokens")], FORMATS.OPENAI),
    );
    const json = await result.response.json();
    expect(json.choices[0].finish_reason).toBe("length");
    expect(json.choices[0].message.content).toBe("cut");
  });

  it("Claude client gets stop_reason refusal + stop_details", async () => {
    const result = await handleForcedSSEToJson(
      codexCtx([refusalItem, incomplete("content_filter")], FORMATS.CLAUDE),
    );
    const json = await result.response.json();
    expect(json.stop_reason).toBe("refusal");
    expect(json.stop_details).toEqual({ type: "refusal", explanation: "No." });
  });

  // YAN-1848: a cut-off function call is not a complete tool call.
  const funcCallItem = {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "lookup",
      arguments: '{"q":"par',
      status: "incomplete",
    },
  };

  it.each([
    ["max_output_tokens", "length", "max_tokens"],
    ["content_filter", "content_filter", "refusal"],
  ])("function_call + %s → chat %s / Claude %s, not tool_calls", async (reason, chat, claude) => {
    const chatResult = await handleForcedSSEToJson(
      codexCtx([funcCallItem, incomplete(reason)], FORMATS.OPENAI),
    );
    const chatJson = await chatResult.response.json();
    expect(chatJson.choices[0].finish_reason).toBe(chat);
    expect(chatJson.choices[0].message.tool_calls[0].function.arguments).toBe('{"q":"par');

    const claudeResult = await handleForcedSSEToJson(
      codexCtx([funcCallItem, incomplete(reason)], FORMATS.CLAUDE),
    );
    const claudeJson = await claudeResult.response.json();
    expect(claudeJson.stop_reason).toBe(claude);
  });
});

describe("7. usage-only OpenAI frame under a Claude target", () => {
  it("keeps usage carried by a frame without choices", () => {
    const out = parseSSEToOpenAIResponse(
      openaiSse([
        chatChunk({ content: "Hi" }),
        chatChunk({}, "stop"),
        {
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        },
      ]),
      "m",
      { format: FORMATS.CLAUDE },
    );
    expect(out.choices[0].message.content).toBe("Hi");
    expect(out.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  });
});

describe("8. cache_creation_tokens null is ignored", () => {
  it("null cache_creation_tokens behaves like absent", () => {
    const out = extractUsageFromResponse({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        prompt_tokens_details: { cache_creation_tokens: null },
      },
    });
    expect(out).not.toHaveProperty("cache_creation_input_tokens");
    expect(out.cached_tokens).toBeUndefined();
  });
});
