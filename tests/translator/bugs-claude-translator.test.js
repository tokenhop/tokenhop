// Regression tests for Claude/OpenAI translator fixes. One focused test per bug.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { filterToOpenAIFormat } from "../../open-sse/translator/formats/openai.js";
import { ensureToolCallIds } from "../../open-sse/translator/concerns/toolCall.js";

// anthropic-compatible provider so prepareClaudeRequest runs the openai→claude path
const T = (body) =>
  translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "m", body, true, null, "anthropic-compatible-x");

const fnTool = (name) => ({
  type: "function",
  function: { name, parameters: { type: "object", properties: {} } },
});

describe("translator fixes (YAN-653/663/680/685/688)", () => {
  // openai-to-claude.js getContentBlocksFromMessage — strict Anthropic parsers
  // (e.g. Zed) 400 with "missing field `is_error`" when a tool_result omits it.
  it("YAN-653: every tool_result block carries is_error as a boolean", () => {
    const out = T({
      messages: [
        { role: "user", content: "run it" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "f", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_2", content: "boom", is_error: true },
            { type: "text", text: "see above" },
          ],
        },
      ],
      tools: [fnTool("f")],
    });
    const toolResults = out.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === "tool_result");
    expect(toolResults.length).toBe(2);
    for (const b of toolResults) {
      expect(typeof b.is_error, `is_error missing on ${JSON.stringify(b)}`).toBe("boolean");
    }
    expect(toolResults.map((b) => b.is_error)).toEqual([false, true]);
  });

  // convertToolChoice / convertOpenAIToolChoice / filterToOpenAIFormat — tool
  // policy restrictions were silently widened (none → auto) or dropped
  // (disable_parallel_tool_use, allowed_tools) between formats.
  it("YAN-663: tool_choice none / parallel policy / allowed_tools survive both directions", () => {
    // Claude → OpenAI
    expect(
      claudeToOpenAIRequest("m", { messages: [], tool_choice: { type: "none" } }, true).tool_choice,
    ).toBe("none");
    const par = claudeToOpenAIRequest(
      "m",
      { messages: [], tool_choice: { type: "any", disable_parallel_tool_use: true } },
      true,
    );
    expect(par.tool_choice).toBe("required");
    expect(par.parallel_tool_calls).toBe(false);
    // Unknown restrictions must not widen to "auto"
    expect(
      claudeToOpenAIRequest("m", { messages: [], tool_choice: { type: "weird" } }, true)
        .tool_choice,
    ).toBe("weird");
    expect(filterToOpenAIFormat({ messages: [], tool_choice: { type: "none" } }).tool_choice).toBe(
      "none",
    );
    expect(
      filterToOpenAIFormat({ messages: [], tool_choice: { type: "weird" } }).tool_choice,
    ).toEqual({ type: "weird" });
    // An already-OpenAI forced choice is left intact
    expect(
      filterToOpenAIFormat({
        messages: [],
        tool_choice: { type: "function", function: { name: "f" } },
      }).tool_choice,
    ).toEqual({ type: "function", function: { name: "f" } });

    // OpenAI → Claude
    expect(
      openaiToClaudeRequest("m", { messages: [], parallel_tool_calls: false }, true).tool_choice,
    ).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(
      openaiToClaudeRequest(
        "m",
        { messages: [], tool_choice: "none", parallel_tool_calls: false },
        true,
      ).tool_choice,
    ).toEqual({ type: "none", disable_parallel_tool_use: true });
    // Single-tool allowed_tools → forced tool
    expect(
      openaiToClaudeRequest(
        "m",
        {
          messages: [],
          tools: [fnTool("a"), fnTool("b")],
          tool_choice: {
            type: "allowed_tools",
            allowed_tools: { mode: "auto", tools: [fnTool("b")] },
          },
        },
        true,
      ).tool_choice,
    ).toEqual({ type: "tool", name: "b" });
    // Multi-tool allowed_tools filters the declared tools and keeps the mode
    const multi = openaiToClaudeRequest(
      "m",
      {
        messages: [],
        tools: [fnTool("a"), fnTool("b"), fnTool("c")],
        tool_choice: {
          type: "allowed_tools",
          mode: "required",
          tools: [fnTool("b"), fnTool("c")],
        },
      },
      true,
    );
    expect(multi.tool_choice).toEqual({ type: "any" });
    expect(multi.tools.map((t) => t.name)).toEqual(["b", "c"]);
  });

  // Anthropic rejects an input_schema whose top level is anyOf/oneOf/allOf —
  // the translator must normalize to a valid top-level type:"object" schema.
  it("YAN-680: top-level anyOf tool schema becomes type:object with merged properties", () => {
    const out = openaiToClaudeRequest(
      "m",
      {
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: {
              name: "union",
              parameters: {
                anyOf: [
                  {
                    type: "object",
                    properties: { a: { type: "string" }, b: { type: "number" } },
                    required: ["a"],
                  },
                  { type: "object", properties: { b: { type: "number" }, c: { type: "boolean" } } },
                ],
              },
            },
          },
        ],
      },
      true,
    );
    const schema = out.tools.find((t) => t.name === "union").input_schema;
    expect(schema.type).toBe("object");
    expect(schema.anyOf).toBeUndefined();
    expect(Object.keys(schema.properties).sort()).toEqual(["a", "b", "c"]);
    // Required only where every object branch requires it → "a" is relaxed
    expect(schema.required ?? []).not.toContain("a");
  });

  // hasValidContent's allowlist predated newer Anthropic block types — a
  // message made only of e.g. container_upload blocks counted as empty and
  // was dropped, forwarding `messages: []` upstream.
  it("YAN-685: messages made only of unlisted block types are never dropped", () => {
    const body = {
      model: "m",
      messages: [{ role: "user", content: [{ type: "container_upload", file_id: "f" }] }],
    };
    const out = prepareClaudeRequest(body, "claude");
    expect(out.messages.length, "container_upload-only message dropped").toBe(1);
    expect(out.messages[0].content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "container_upload" })]),
    );
    // OpenAI direction: the turn must survive the bridge, not vanish into []
    const oai = claudeToOpenAIRequest("m", body, true);
    expect(oai.messages.length, "OpenAI direction lost the user turn").toBeGreaterThan(0);
  });

  // ensureToolCallIds dereferenced msg/tc/block without null checks, so a
  // malformed body (null message, null tool_calls entry, null content block,
  // non-string function name) threw a TypeError → unhandled 500.
  it("YAN-688: ensureToolCallIds never throws on malformed messages", () => {
    const malformed = [
      { messages: [null] },
      { messages: [{ role: "assistant", tool_calls: [null] }] },
      { messages: [{ role: "user", content: [null] }] },
      { messages: [{ role: "assistant", tool_calls: [{ id: "!!!", function: { name: 42 } }] }] },
    ];
    for (const body of malformed) {
      expect(() => ensureToolCallIds(body), JSON.stringify(body)).not.toThrow();
    }
    // End-to-end: a malformed body still translates (no 500)
    expect(() =>
      translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "m", { messages: [null] }, true, null, "x"),
    ).not.toThrow();
  });
});
