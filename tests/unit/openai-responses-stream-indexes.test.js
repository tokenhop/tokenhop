// YAN-37: each Responses output item gets its own output_index, and
// response.completed carries output[] and usage (trailing usage chunk included).
import { describe, it, expect } from "vitest";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";
import { initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const delta = (d, finish = null) => ({
  id: "c1",
  model: "m",
  choices: [{ index: 0, delta: d, finish_reason: finish }],
});
const tool = (index, id, name, args) => ({
  tool_calls: [{ index, id, type: "function", function: { name, arguments: args } }],
});

function run(chunks) {
  const state = initState(FORMATS.OPENAI_RESPONSES);
  const events = [];
  for (const c of chunks) events.push(...openaiToOpenAIResponsesResponse(c, state));
  events.push(...openaiToOpenAIResponsesResponse(null, state));
  return events;
}

describe("Chat stream → Responses output indexes", () => {
  it("gives reasoning, message and each tool call a distinct, stable output_index", () => {
    const events = run([
      delta({ role: "assistant", reasoning_content: "think" }),
      delta({ content: "hello" }),
      delta(tool(0, "call_a", "a", "{}")),
      delta(tool(1, "call_b", "b", "{}")),
      delta({}, "tool_calls"),
      {
        id: "c1",
        choices: [],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      },
    ]);

    const added = events.filter((e) => e.event === "response.output_item.added");
    expect(added.map((e) => e.data.output_index)).toEqual([0, 1, 2, 3]);
    expect(added.map((e) => e.data.item.type)).toEqual([
      "reasoning",
      "message",
      "function_call",
      "function_call",
    ]);
    // every event for an item reuses the index its output_item.added got
    const byItem = new Map(added.map((e) => [e.data.item.id, e.data.output_index]));
    for (const e of events) {
      const id = e.data.item_id ?? e.data.item?.id;
      if (byItem.has(id)) expect(e.data.output_index).toBe(byItem.get(id));
    }

    const completed = events.filter((e) => e.event === "response.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0].data.response.output.map((i) => i.type)).toEqual([
      "reasoning",
      "message",
      "function_call",
      "function_call",
    ]);
    expect(completed[0].data.response.usage).toMatchObject({
      input_tokens: 7,
      output_tokens: 3,
      total_tokens: 10,
    });
  });

  it("closes the message before a later reasoning segment opens a new item", () => {
    const events = run([
      delta({ role: "assistant", content: "a" }),
      delta({ reasoning_content: "r" }),
      delta({ content: "b" }, "stop"),
    ]);
    const order = events
      .filter((e) => /output_item\.(added|done)$/.test(e.event))
      .map((e) => `${e.event.split(".").pop()}:${e.data.item.type}:${e.data.output_index}`);
    expect(order.slice(0, 3)).toEqual(["added:message:0", "done:message:0", "added:reasoning:1"]);
    expect(new Set(order.map((o) => o.split(":")[2])).size).toBe(order.length / 2);
  });
});
