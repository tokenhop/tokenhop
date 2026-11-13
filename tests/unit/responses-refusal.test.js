// YAN-1027: an upstream refusal (chat delta.refusal / message.refusal +
// finish_reason content_filter) must reach OpenAI Responses clients as a
// `refusal` content part and an incomplete (content_filter) response.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetailUnscoped: vi.fn(async () => {}),
  saveRequestUsageUnscoped: vi.fn(async () => {}),
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { initState } = await import("../../open-sse/translator/index.js");
const { openaiToOpenAIResponsesResponse } = await import(
  "../../open-sse/translator/response/openai-responses.js"
);
const { translateNonStreamingResponse } = await import(
  "../../open-sse/handlers/chatCore/nonStreamingHandler.js"
);

const chunk = (delta, finish = null) => ({
  id: "c1",
  model: "m",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

function run(chunks) {
  const state = initState(FORMATS.OPENAI_RESPONSES);
  const events = [];
  for (const c of chunks) events.push(...openaiToOpenAIResponsesResponse(c, state));
  events.push(...openaiToOpenAIResponsesResponse(null, state));
  return events;
}

const names = (events) => events.map((e) => e.event);
const terminal = (events) => events[events.length - 1];

describe("Chat stream → Responses: refusal (YAN-1027)", () => {
  it("refusal-only content_filter stream emits refusal events and response.incomplete", () => {
    const events = run([chunk({ role: "assistant" }), chunk({ refusal: "No." }, "content_filter")]);

    expect(names(events)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.refusal.delta",
      "response.refusal.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.incomplete",
    ]);
    const byName = (n) => events.find((e) => e.event === n).data;
    const added = byName("response.output_item.added");
    expect(byName("response.content_part.added")).toMatchObject({
      item_id: added.item.id,
      output_index: added.output_index,
      content_index: 0,
      part: { type: "refusal", refusal: "" },
    });
    expect(byName("response.refusal.delta")).toMatchObject({
      item_id: added.item.id,
      output_index: added.output_index,
      content_index: 0,
      delta: "No.",
    });
    expect(byName("response.refusal.done")).toMatchObject({ content_index: 0, refusal: "No." });
    expect(byName("response.content_part.done").part).toEqual({ type: "refusal", refusal: "No." });
    expect(byName("response.output_item.done").item.content).toEqual([
      { type: "refusal", refusal: "No." },
    ]);

    const done = terminal(events).data;
    expect(done.type).toBe("response.incomplete");
    expect(done.response.status).toBe("incomplete");
    expect(done.response.incomplete_details).toEqual({ reason: "content_filter" });
    expect(done.response.output).toHaveLength(1);
    expect(done.response.output[0].content).toEqual([{ type: "refusal", refusal: "No." }]);
    // the message of an incomplete response is itself incomplete
    expect(byName("response.output_item.done").item.status).toBe("incomplete");
    expect(done.response.output[0].status).toBe("incomplete");
  });

  it("text then refusal: two sequential content parts on one message item", () => {
    const events = run([
      chunk({ role: "assistant", content: "par" }),
      chunk({ content: "tial" }),
      chunk({ refusal: "Stop." }, "content_filter"),
    ]);

    expect(names(events)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.content_part.added",
      "response.refusal.delta",
      "response.refusal.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.incomplete",
    ]);
    const parts = events.filter((e) => e.event === "response.content_part.done");
    expect(parts.map((e) => e.data.content_index)).toEqual([0, 1]);
    expect(events.find((e) => e.event === "response.refusal.delta").data.content_index).toBe(1);
    expect(events.find((e) => e.event === "response.output_text.done").data.text).toBe("partial");
    expect(terminal(events).data.response.output[0].content).toEqual([
      { type: "output_text", annotations: [], logprobs: [], text: "partial" },
      { type: "refusal", refusal: "Stop." },
    ]);
  });

  it("streamed refusal deltas (OpenAI-native, finish stop) accumulate into one part", () => {
    const events = run([
      chunk({ role: "assistant", refusal: "I can" }),
      chunk({ refusal: "'t help." }),
      chunk({}, "stop"),
    ]);
    expect(events.filter((e) => e.event === "response.refusal.delta")).toHaveLength(2);
    expect(events.find((e) => e.event === "response.refusal.done").data.refusal).toBe(
      "I can't help.",
    );
    const done = terminal(events).data;
    expect(done.type).toBe("response.completed");
    expect(done.response.status).toBe("completed");
    expect(done.response.output[0].content).toEqual([
      { type: "refusal", refusal: "I can't help." },
    ]);
    expect(done.response.output[0].status).toBe("completed");
  });

  it("length ends with response.incomplete / max_output_tokens (matches non-streaming)", () => {
    const events = run([chunk({ role: "assistant", content: "cut" }), chunk({}, "length")]);
    const done = terminal(events).data;
    expect(done.type).toBe("response.incomplete");
    expect(done.response.status).toBe("incomplete");
    expect(done.response.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });
});

describe("non-streaming chat.completion → Responses: refusal (YAN-1027)", () => {
  const body = (message, finish_reason) => ({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1700000000,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

  it("message.refusal + content_filter → refusal part, status incomplete", () => {
    const out = translateNonStreamingResponse(
      body({ content: "", refusal: "No." }, "content_filter"),
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
    );
    expect(out.status).toBe("incomplete");
    expect(out.incomplete_details).toEqual({ reason: "content_filter" });
    expect(out.output).toEqual([
      {
        type: "message",
        role: "assistant",
        status: "incomplete",
        content: [{ type: "refusal", refusal: "No." }],
      },
    ]);
  });

  it("text + refusal share one message item, text first", () => {
    const out = translateNonStreamingResponse(
      body({ content: "partial", refusal: "No." }, "content_filter"),
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
    );
    expect(out.output[0].content).toEqual([
      { type: "output_text", text: "partial", annotations: [] },
      { type: "refusal", refusal: "No." },
    ]);
  });

  it("Claude refusal body → Responses body (pivot keeps the refusal)", () => {
    const out = translateNonStreamingResponse(
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-x",
        content: [],
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber", explanation: "X" },
        usage: { input_tokens: 1, output_tokens: 0 },
      },
      FORMATS.CLAUDE,
      FORMATS.OPENAI_RESPONSES,
    );
    expect(out.status).toBe("incomplete");
    expect(out.incomplete_details).toEqual({ reason: "content_filter" });
    expect(out.output[0].content).toEqual([{ type: "refusal", refusal: "X" }]);
  });

  it("length is unchanged: incomplete / max_output_tokens", () => {
    const out = translateNonStreamingResponse(
      body({ content: "cut" }, "length"),
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
    );
    expect(out.status).toBe("incomplete");
    expect(out.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });

  it("stop without refusal stays completed with no refusal part", () => {
    const out = translateNonStreamingResponse(
      body({ content: "hi" }, "stop"),
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
    );
    expect(out.status).toBe("completed");
    expect(out).not.toHaveProperty("incomplete_details");
    expect(out.output[0].content).toEqual([{ type: "output_text", text: "hi", annotations: [] }]);
    expect(out.output[0]).not.toHaveProperty("status");
  });
});
