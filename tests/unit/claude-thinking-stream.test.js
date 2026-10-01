// YAN-33: Claude thinking blocks must NOT leak `<think>` tags into OpenAI
// chunks (reasoning goes out as reasoning_content), and must close the
// reasoning item before message/tool items when bridging to Responses clients.
import { describe, it, expect } from "vitest";
import "../translator/registerAll.js";
import { translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function runStream(targetFormat, sourceFormat, events) {
  const state = initState(sourceFormat);
  const all = [];
  for (const ev of events) {
    const out = translateResponse(targetFormat, sourceFormat, ev, state);
    if (Array.isArray(out)) all.push(...out);
    else if (out) all.push(out);
  }
  return all;
}

const THINKING_THEN_TEXT = [
  { type: "message_start", message: { id: "msg_1", model: "claude-opus-4-6" } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello" } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "end_turn" } },
  { type: "message_stop" },
];

const THINKING_THEN_TOOL = [
  { type: "message_start", message: { id: "msg_2", model: "claude-opus-4-6" } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
  { type: "content_block_stop", index: 0 },
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "tu_1", name: "get_weather" },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"a":1}' },
  },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" } },
  { type: "message_stop" },
];

describe("Claude thinking stream: no <think> tags, reasoning closed before next item", () => {
  it("→ OpenAI: reasoning_content carries thinking, content carries text only", () => {
    const chunks = runStream(FORMATS.CLAUDE, FORMATS.OPENAI, THINKING_THEN_TEXT);
    expect(chunks.map((c) => c?.choices?.[0]?.delta?.content ?? "").join("")).toBe("Hello");
    expect(chunks.map((c) => c?.choices?.[0]?.delta?.reasoning_content ?? "").join("")).toBe("hmm");
    expect(chunks.some((c) => JSON.stringify(c).includes("<think"))).toBe(false);
  });

  it("→ OpenAI Responses: reasoning item done before message item added", () => {
    const events = runStream(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, THINKING_THEN_TEXT);
    const findIdx = (type, itemType) =>
      events.findIndex(
        (ev) => ev?.event === type && (itemType ? ev?.data?.item?.type === itemType : true),
      );
    const reasoningDone = findIdx("response.output_item.done", "reasoning");
    const messageAdded = findIdx("response.output_item.added", "message");
    expect(reasoningDone).toBeGreaterThanOrEqual(0);
    expect(messageAdded).toBeGreaterThanOrEqual(0);
    expect(reasoningDone).toBeLessThan(messageAdded);
  });

  it("→ OpenAI Responses: reasoning item done before function_call added", () => {
    const events = runStream(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, THINKING_THEN_TOOL);
    const findIdx = (type, itemType) =>
      events.findIndex((ev) => ev?.event === type && ev?.data?.item?.type === itemType);
    const reasoningDone = findIdx("response.output_item.done", "reasoning");
    const toolAdded = findIdx("response.output_item.added", "function_call");
    expect(reasoningDone).toBeGreaterThanOrEqual(0);
    expect(toolAdded).toBeGreaterThanOrEqual(0);
    expect(reasoningDone).toBeLessThan(toolAdded);
  });
});
