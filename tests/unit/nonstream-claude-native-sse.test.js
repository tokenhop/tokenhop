// YAN-1842: Claude upstream SSE → Claude non-stream client is aggregated
// natively, so signed thinking, redacted thinking and server-tool blocks
// survive. YAN-1854: a tool call cut off by max_tokens keeps only the
// arguments that finished, never a fabricated `{}` for completed arguments.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetailUnscoped: vi.fn(async () => {}),
  saveRequestUsageUnscoped: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(async () => {}),
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { handleForcedSSEToJson } = await import(
  "../../open-sse/handlers/chatCore/sseToJsonHandler.js"
);
const { handleNonStreamingResponse } = await import(
  "../../open-sse/handlers/chatCore/nonStreamingHandler.js"
);
const { saveRequestUsageUnscoped, saveRequestDetailUnscoped } = await import("@/lib/usageDb.js");

const claudeSse = (events) =>
  `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}`).join("\n\n")}\n\n`;
const openaiSse = (chunks) =>
  `${chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;

const sseResponse = (raw) =>
  new Response(raw, { headers: { "content-type": "text/event-stream" } });

const forcedCtx = (raw, sourceFormat, targetFormat, extra = {}) => ({
  providerResponse: sseResponse(raw),
  sourceFormat,
  targetFormat,
  provider: "claude-sse",
  model: "claude-x",
  body: { model: "claude-x", messages: [] },
  stream: false,
  requestStartTime: Date.now(),
  connectionId: "c1",
  clientRawRequest: { endpoint: "/v1/messages" },
  trackDone: vi.fn(),
  appendLog: vi.fn(),
  ...extra,
});
const nonStreamCtx = (raw, sourceFormat, targetFormat, extra = {}) => ({
  ...forcedCtx(raw, sourceFormat, targetFormat),
  reqLogger: { logProviderResponse() {}, logConvertedResponse() {} },
  toolNameMap: null,
  customToolNames: null,
  ...extra,
});

const searchResult = [{ type: "web_search_result", url: "https://a.example", title: "A" }];
const events = (toolName) => [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-x",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 7, output_tokens: 1, cache_read_input_tokens: 100 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Hm" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig==" } },
  { type: "content_block_stop", index: 0 },
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "redacted_thinking", data: "opaque" },
  },
  { type: "content_block_stop", index: 1 },
  {
    type: "content_block_start",
    index: 2,
    content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
  },
  {
    type: "content_block_delta",
    index: 2,
    delta: { type: "input_json_delta", partial_json: '{"query":"x"}' },
  },
  { type: "content_block_stop", index: 2 },
  {
    type: "content_block_start",
    index: 3,
    content_block: {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: searchResult,
    },
  },
  { type: "content_block_stop", index: 3 },
  {
    type: "content_block_start",
    index: 4,
    content_block: { type: "tool_use", id: "toolu_1", name: toolName, input: {} },
  },
  {
    type: "content_block_delta",
    index: 4,
    delta: { type: "input_json_delta", partial_json: '{"q":' },
  },
  {
    type: "content_block_delta",
    index: 4,
    delta: { type: "input_json_delta", partial_json: '"par"}' },
  },
  { type: "content_block_stop", index: 4 },
  {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 9 },
  },
  { type: "message_stop" },
];

const expectedContent = (toolName) => [
  { type: "thinking", thinking: "Hm", signature: "sig==" },
  { type: "redacted_thinking", data: "opaque" },
  { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "x" } },
  { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: searchResult },
  { type: "tool_use", id: "toolu_1", name: toolName, input: { q: "par" } },
];

// Canonical storage: prompt includes the cache read.
const CANONICAL_USAGE = { prompt_tokens: 107, completion_tokens: 9, cached_tokens: 100 };

describe("YAN-1842: Claude upstream SSE → Claude non-stream client", () => {
  it("forced SSE keeps signed thinking, server-tool blocks, usage and stop fields", async () => {
    vi.mocked(saveRequestUsageUnscoped).mockClear();
    const result = await handleForcedSSEToJson(
      forcedCtx(claudeSse(events("lookup")), FORMATS.CLAUDE, FORMATS.CLAUDE),
    );
    const json = await result.response.json();
    expect(json).toMatchObject({ id: "msg_1", type: "message", model: "claude-x" });
    expect(json.content).toEqual(expectedContent("lookup"));
    expect(json.stop_reason).toBe("tool_use");
    expect(json.stop_sequence).toBeNull();
    expect(json.usage).toEqual({ input_tokens: 7, output_tokens: 9, cache_read_input_tokens: 100 });
    expect(vi.mocked(saveRequestUsageUnscoped).mock.calls[0][0].tokens).toMatchObject(
      CANONICAL_USAGE,
    );
  });

  it("non-stream SSE fallback keeps the signature and restores cloaked tool names", async () => {
    vi.mocked(saveRequestUsageUnscoped).mockClear();
    const result = await handleNonStreamingResponse(
      nonStreamCtx(claudeSse(events("lookup_ide")), FORMATS.CLAUDE, FORMATS.CLAUDE, {
        toolNameMap: new Map([["lookup_ide", "lookup"]]),
      }),
    );
    const json = await result.response.json();
    expect(json.content).toEqual(expectedContent("lookup"));
    expect(json.stop_reason).toBe("tool_use");
    expect(json.usage.cache_read_input_tokens).toBe(100);
    expect(vi.mocked(saveRequestUsageUnscoped).mock.calls[0][0].tokens).toMatchObject(
      CANONICAL_USAGE,
    );
  });

  it("forced SSE restores cloaked tool names too", async () => {
    const result = await handleForcedSSEToJson(
      forcedCtx(claudeSse(events("lookup_ide")), FORMATS.CLAUDE, FORMATS.CLAUDE, {
        toolNameMap: new Map([["lookup_ide", "lookup"]]),
      }),
    );
    const json = await result.response.json();
    expect(json.content.at(-1).name).toBe("lookup");
  });

  it("a Claude error frame is an upstream failure on both paths", async () => {
    const raw = claudeSse([
      events("x")[0],
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    ]);
    for (const result of [
      await handleForcedSSEToJson(forcedCtx(raw, FORMATS.CLAUDE, FORMATS.CLAUDE)),
      await handleNonStreamingResponse(nonStreamCtx(raw, FORMATS.CLAUDE, FORMATS.CLAUDE)),
    ]) {
      expect(result.success).toBe(false);
      expect(result.response.status).toBe(502);
    }
  });

  it("records canonical (cache-inclusive) request-detail tokens on both paths", async () => {
    for (const run of [
      () =>
        handleForcedSSEToJson(
          forcedCtx(claudeSse(events("lookup")), FORMATS.CLAUDE, FORMATS.CLAUDE),
        ),
      () =>
        handleNonStreamingResponse(
          nonStreamCtx(claudeSse(events("lookup")), FORMATS.CLAUDE, FORMATS.CLAUDE),
        ),
    ]) {
      vi.mocked(saveRequestDetailUnscoped).mockClear();
      await run();
      expect(vi.mocked(saveRequestDetailUnscoped).mock.calls[0][0].tokens).toMatchObject(
        CANONICAL_USAGE,
      );
    }
  });

  it("decloaks tool names exactly once on the non-stream SSE fallback", async () => {
    const result = await handleNonStreamingResponse(
      nonStreamCtx(claudeSse(events("a_ide_ide")), FORMATS.CLAUDE, FORMATS.CLAUDE, {
        toolNameMap: new Map([
          ["a_ide", "a"],
          ["a_ide_ide", "a_ide"],
        ]),
      }),
    );
    const json = await result.response.json();
    expect(json.content.at(-1).name).toBe("a_ide");
  });

  it("message_start without usage still records the output tokens", async () => {
    vi.mocked(saveRequestUsageUnscoped).mockClear();
    const [start, ...rest] = events("lookup");
    const { usage: _drop, ...bare } = start.message;
    const result = await handleForcedSSEToJson(
      forcedCtx(claudeSse([{ ...start, message: bare }, ...rest]), FORMATS.CLAUDE, FORMATS.CLAUDE),
    );
    const json = await result.response.json();
    expect(json.usage).toEqual({ input_tokens: 0, output_tokens: 9 });
    expect(saveRequestUsageUnscoped).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveRequestUsageUnscoped).mock.calls[0][0].tokens).toMatchObject({
      completion_tokens: 9,
    });
  });

  it("a stream cut before stop_reason is an upstream failure on both paths", async () => {
    const cut = events("lookup").slice(0, 5); // message_start + the signed thinking block
    for (const result of [
      await handleForcedSSEToJson(forcedCtx(claudeSse(cut), FORMATS.CLAUDE, FORMATS.CLAUDE)),
      await handleNonStreamingResponse(
        nonStreamCtx(claudeSse(cut), FORMATS.CLAUDE, FORMATS.CLAUDE),
      ),
    ]) {
      expect(result.success).toBe(false);
      expect(result.response.status).toBe(502);
    }
  });

  it("an empty message keeps the empty text placeholder", async () => {
    const raw = claudeSse([
      events("x")[0],
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]);
    const result = await handleForcedSSEToJson(forcedCtx(raw, FORMATS.CLAUDE, FORMATS.CLAUDE));
    const json = await result.response.json();
    expect(json.content).toEqual([{ type: "text", text: "" }]);
  });

  it("non-stream client usage keeps server_tool_use and service_tier", async () => {
    const [start, ...rest] = events("lookup");
    const withTier = {
      ...start,
      message: { ...start.message, usage: { ...start.message.usage, service_tier: "standard" } },
    };
    const delta = rest.findIndex((e) => e.type === "message_delta");
    rest[delta] = {
      ...rest[delta],
      usage: { output_tokens: 9, server_tool_use: { web_search_requests: 1 } },
    };
    const result = await handleNonStreamingResponse(
      nonStreamCtx(claudeSse([withTier, ...rest]), FORMATS.CLAUDE, FORMATS.CLAUDE),
    );
    const json = await result.response.json();
    expect(json.usage.server_tool_use).toEqual({ web_search_requests: 1 });
    expect(json.usage.service_tier).toBe("standard");
  });
});

describe("YAN-1854: truncated tool arguments under max_tokens", () => {
  const TRUNCATED_ARGS = '{"path":"c.md","content":"long ess';
  const MALFORMED_ARGS = '{"a":1,"b":"x';
  const toolEvents = (partialJson, stopReason) => [
    events("x")[0],
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "write_file", input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: partialJson },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 9 },
    },
    { type: "message_stop" },
  ];
  const chunk = (delta, finish = null) => ({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "gpt-x",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const openaiToolSse = (args, finish) =>
    openaiSse([
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "write_file", arguments: args },
          },
        ],
      }),
      chunk({}, finish),
    ]);

  it("Claude upstream stop_reason tool_use + malformed input → {} (no partial parse)", async () => {
    const result = await handleNonStreamingResponse(
      nonStreamCtx(
        claudeSse(toolEvents(MALFORMED_ARGS, "tool_use")),
        FORMATS.CLAUDE,
        FORMATS.CLAUDE,
      ),
    );
    const json = await result.response.json();
    expect(json.content.at(-1).input).toEqual({});
  });

  it("OpenAI upstream finish tool_calls + malformed args → Claude input {}", async () => {
    const result = await handleForcedSSEToJson(
      forcedCtx(openaiToolSse(MALFORMED_ARGS, "tool_calls"), FORMATS.CLAUDE, FORMATS.OPENAI),
    );
    const json = await result.response.json();
    expect(json.stop_reason).toBe("tool_use");
    expect(json.content.at(-1).input).toEqual({});
  });

  it("Claude upstream max_tokens: input keeps only the finished arguments", async () => {
    const result = await handleNonStreamingResponse(
      nonStreamCtx(
        claudeSse(toolEvents(TRUNCATED_ARGS, "max_tokens")),
        FORMATS.CLAUDE,
        FORMATS.CLAUDE,
      ),
    );
    const json = await result.response.json();
    expect(json.stop_reason).toBe("max_tokens");
    expect(json.content.at(-1)).toEqual({
      type: "tool_use",
      id: "toolu_1",
      name: "write_file",
      input: { path: "c.md" },
    });
  });

  it("OpenAI upstream finish length → Claude client tool_use keeps finished arguments", async () => {
    const result = await handleForcedSSEToJson(
      forcedCtx(openaiToolSse(TRUNCATED_ARGS, "length"), FORMATS.CLAUDE, FORMATS.OPENAI),
    );
    const json = await result.response.json();
    expect(json.stop_reason).toBe("max_tokens");
    expect(json.content.at(-1)).toMatchObject({ type: "tool_use", input: { path: "c.md" } });
  });
});

describe("PR #1114 review: native Claude aggregation edge cases", () => {
  const start = events("x")[0];
  const text = (index, value) => ({
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text: value },
  });
  const bothPaths = async (raw, extra = {}) => [
    await handleForcedSSEToJson(forcedCtx(raw, FORMATS.CLAUDE, FORMATS.CLAUDE, extra)),
    await handleNonStreamingResponse(nonStreamCtx(raw, FORMATS.CLAUDE, FORMATS.CLAUDE, extra)),
  ];

  it("a null usage field in message_delta keeps the message_start value", async () => {
    vi.mocked(saveRequestUsageUnscoped).mockClear();
    const raw = claudeSse([
      start,
      text(0, "Hi"),
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 9, cache_read_input_tokens: null },
      },
      { type: "message_stop" },
    ]);
    const result = await handleForcedSSEToJson(forcedCtx(raw, FORMATS.CLAUDE, FORMATS.CLAUDE));
    const json = await result.response.json();
    expect(json.usage.cache_read_input_tokens).toBe(100);
    expect(vi.mocked(saveRequestUsageUnscoped).mock.calls[0][0].tokens).toMatchObject(
      CANONICAL_USAGE,
    );
  });

  it.each([
    ["with a tool_use block", "lookup", "tool_use"],
    ["without a tool_use block", null, "end_turn"],
  ])("message_stop without stop_reason, %s → 200 (tool %s, %s)", async (_name, tool, expected) => {
    const toolBlock = tool
      ? [
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "toolu_1", name: tool, input: {} },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"q":"x"}' },
          },
        ]
      : [];
    const raw = claudeSse([
      start,
      text(0, "Hi"),
      ...toolBlock,
      { type: "message_delta", delta: {}, usage: { output_tokens: 9 } },
      { type: "message_stop" },
    ]);
    for (const result of await bothPaths(raw)) {
      expect(result.success).toBe(true);
      expect((await result.response.json()).stop_reason).toBe(expected);
    }
  });

  it("a text_delta without content_block_start still yields the text", async () => {
    const raw = claudeSse([
      start,
      text(0, "Hel"),
      { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ]);
    for (const result of await bothPaths(raw)) {
      expect((await result.response.json()).content).toEqual([{ type: "text", text: "Hello" }]);
    }
  });

  it("model_context_window_exceeded is a cut-off: partial tool input, OpenAI length", async () => {
    const raw = claudeSse([
      start,
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "write_file", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"path":"c.md","content":"lo' },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "model_context_window_exceeded" },
        usage: { output_tokens: 9 },
      },
      { type: "message_stop" },
    ]);
    for (const result of await bothPaths(raw)) {
      expect((await result.response.json()).content.at(-1).input).toEqual({ path: "c.md" });
    }
    const chat = await handleNonStreamingResponse(
      nonStreamCtx(raw, FORMATS.OPENAI, FORMATS.CLAUDE),
    );
    expect((await chat.response.json()).choices[0].finish_reason).toBe("length");
  });

  it("OpenAI-chunk SSE under a Claude source + target → Claude message on both paths", async () => {
    const chunk = (delta, finish = null) => ({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      model: "gpt-x",
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    const raw = openaiSse([chunk({ role: "assistant", content: "Hi" }), chunk({}, "stop")]);
    for (const result of await bothPaths(raw)) {
      const json = await result.response.json();
      expect(json.type).toBe("message");
      expect(json.content).toEqual([{ type: "text", text: "Hi" }]);
      expect(json.stop_reason).toBe("end_turn");
    }
  });

  it("client usage keeps the cache_creation breakdown", async () => {
    const cacheCreation = { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 0 };
    const raw = claudeSse([
      {
        ...start,
        message: { ...start.message, usage: { input_tokens: 7, cache_creation: cacheCreation } },
      },
      text(0, "Hi"),
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]);
    const result = await handleNonStreamingResponse(
      nonStreamCtx(raw, FORMATS.CLAUDE, FORMATS.CLAUDE),
    );
    expect((await result.response.json()).usage.cache_creation).toEqual(cacheCreation);
  });

  it("a malformed data frame fails the native Claude stream on both paths", async () => {
    const good = claudeSse([
      start,
      text(0, "Hi"),
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]);
    const raw = good.replace(
      "event: message_delta",
      'event: content_block_delta\ndata: {"type":"content_block_delta","ind\n\nevent: message_delta',
    );
    for (const result of await bothPaths(raw)) {
      expect(result.success).toBe(false);
      expect(result.response.status).toBe(502);
    }
  });

  it("joins a multi-line data event before parsing", async () => {
    const multiLine =
      'event: content_block_delta\ndata: {"type":"content_block_delta",\ndata: "index":0,\n' +
      'data: "delta":{"type":"text_delta","text":"lo"}}\n\n';
    const raw =
      claudeSse([start, text(0, "Hel")]) +
      multiLine +
      claudeSse([
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
        { type: "message_stop" },
      ]);
    for (const result of await bothPaths(raw)) {
      expect((await result.response.json()).content).toEqual([{ type: "text", text: "Hello" }]);
    }
  });
});
