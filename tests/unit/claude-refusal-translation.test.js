// YAN-1024: Claude stop_reason "refusal" must surface as content_filter + refusal text.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetailUnscoped: vi.fn(async () => {}),
  saveRequestUsageUnscoped: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(async () => {}),
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { claudeToOpenAIResponse } = await import(
  "../../open-sse/translator/response/claude-to-openai.js"
);
const { createSSETransformStreamWithLogger } = await import("../../open-sse/utils/stream.js");
const { translateNonStreamingResponse } = await import(
  "../../open-sse/handlers/chatCore/nonStreamingHandler.js"
);

const start = { type: "message_start", message: { id: "msg_1", model: "m", usage: {} } };
const stop = { type: "message_stop" };
const textBlock = [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
  { type: "content_block_stop", index: 0 },
];
const messageDelta = (stop_reason, stop_details) => ({
  type: "message_delta",
  delta: { stop_reason, ...(stop_details ? { stop_details } : {}) },
  usage: { output_tokens: 0 },
});
const refusalDetails = { type: "refusal", category: "reasoning_extraction", explanation: "X" };

const run = (events) => {
  const state = { toolCalls: new Map() };
  return events.flatMap((e) => claudeToOpenAIResponse(e, state) || []);
};
const finishChunks = (chunks) => chunks.filter((c) => c.choices[0].finish_reason);

describe("claude refusal - stream translator", () => {
  it("emits content_filter + delta.refusal on a single final chunk", () => {
    const fin = finishChunks(run([start, messageDelta("refusal", refusalDetails), stop]));
    expect(fin).toHaveLength(1);
    expect(fin[0].choices[0].finish_reason).toBe("content_filter");
    expect(fin[0].choices[0].delta.refusal).toBe("X");
  });

  it("keeps content deltas ahead of the refusal chunk", () => {
    const chunks = run([start, ...textBlock, messageDelta("refusal", refusalDetails), stop]);
    expect(chunks.some((c) => c.choices[0].delta.content === "partial")).toBe(true);
    const fin = finishChunks(chunks);
    expect(fin).toHaveLength(1);
    expect(fin[0].choices[0].delta.refusal).toBe("X");
  });

  it.each([
    [undefined, "Request refused by upstream provider."],
    [
      { type: "refusal", category: "cyber" },
      "Request refused by upstream provider (category: cyber).",
    ],
  ])("fallback text for stop_details %j", (details, expected) => {
    const fin = finishChunks(run([start, messageDelta("refusal", details), stop]));
    expect(fin[0].choices[0].delta.refusal).toBe(expected);
  });

  it("end_turn has no refusal key", () => {
    const fin = finishChunks(run([start, ...textBlock, messageDelta("end_turn"), stop]));
    expect(fin[0].choices[0].finish_reason).toBe("stop");
    expect(fin[0].choices[0].delta).not.toHaveProperty("refusal");
  });

  it("tool_use-only stream finishes tool_calls with no refusal key", () => {
    const fin = finishChunks(
      run([
        start,
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "t1", name: "f", input: {} },
        },
        { type: "content_block_stop", index: 0 },
        messageDelta("tool_use"),
        stop,
      ]),
    );
    expect(fin[0].choices[0].finish_reason).toBe("tool_calls");
    expect(fin[0].choices[0].delta).not.toHaveProperty("refusal");
  });
});

describe("claude refusal - full SSE pipeline", () => {
  it("refusal chunk survives the valuable-content filter", async () => {
    const sse = [start, messageDelta("refusal", refusalDetails), stop]
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`)
      .join("\n");
    const source = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`${sse}\n`));
        c.close();
      },
    });
    const stream = createSSETransformStreamWithLogger(
      FORMATS.CLAUDE,
      FORMATS.OPENAI,
      "claude",
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
    const chunks = out
      .split("\n")
      .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map((l) => JSON.parse(l.slice(6)));
    const fin = chunks.filter((c) => c.choices?.[0]?.finish_reason);
    expect(fin).toHaveLength(1);
    expect(fin[0].choices[0].finish_reason).toBe("content_filter");
    expect(fin[0].choices[0].delta.refusal).toBe("X");
  });
});

describe("claude refusal - non-streaming", () => {
  const body = (stop_reason, content, extra = {}) => ({
    id: "msg_1",
    model: "m",
    content,
    stop_reason,
    usage: { input_tokens: 1, output_tokens: 0 },
    ...extra,
  });

  it("zero-content refusal -> content_filter + message.refusal", () => {
    const out = translateNonStreamingResponse(
      body("refusal", [], { stop_details: refusalDetails }),
      FORMATS.CLAUDE,
      FORMATS.OPENAI,
    );
    expect(out.choices[0].finish_reason).toBe("content_filter");
    expect(out.choices[0].message.refusal).toBe("X");
  });

  it("end_turn has no refusal key", () => {
    const out = translateNonStreamingResponse(
      body("end_turn", [{ type: "text", text: "hi" }]),
      FORMATS.CLAUDE,
      FORMATS.OPENAI,
    );
    expect(out.choices[0].finish_reason).toBe("stop");
    expect(out.choices[0].message).not.toHaveProperty("refusal");
  });
});
