// Real Codex CLI requests (OpenAI Responses API: { input:[], instructions }) → providers.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const R2O = (body) =>
  translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, "m", body, true, null, null);
const O2R = (body) =>
  translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "m", body, true, null, null);

describe("Codex CLI Responses → OpenAI", () => {
  // openai-responses.js:103 — function_call with empty name skipped, can leave tool_calls: []
  // KNOWN BUG: empty tool_calls array is rejected by OpenAI/Codex
  it.fails("assistant has no empty tool_calls array when all names are empty", () => {
    const out = R2O({
      input: [{ type: "function_call", call_id: "c1", name: "", arguments: "{}" }],
    });
    const asst = out.messages.find((m) => m.role === "assistant" && m.tool_calls);
    expect(asst?.tool_calls?.length ?? 0, "empty tool_calls[] produced").toBeGreaterThan(0);
  });

  it("function_call arguments end up as a string", () => {
    const out = R2O({
      input: [{ type: "function_call", call_id: "c1", name: "f", arguments: { a: 1 } }],
    });
    const asst = out.messages.find((m) => m.tool_calls);
    expect(typeof asst.tool_calls[0].function.arguments).toBe("string");
  });

  // openai-responses.js:75-77 — input_image uses file_id as raw url
  // KNOWN BUG
  it.fails("input_image with file_id is not used as a raw url", () => {
    const out = R2O({
      input: [
        { type: "message", role: "user", content: [{ type: "input_image", file_id: "file-abc" }] },
      ],
    });
    const userMsg = out.messages.find((m) => m.role === "user");
    const img = Array.isArray(userMsg?.content)
      ? userMsg.content.find((c) => c.type === "image_url")
      : null;
    // A bare file_id is not a valid image URL
    expect(img?.image_url?.url === "file-abc").toBe(false);
  });

  it("tool_choice {type:function|custom,name} becomes the Chat nested form", () => {
    for (const type of ["function", "custom"]) {
      const out = R2O({ input: "hi", tool_choice: { type, name: "f" } });
      expect(out.tool_choice).toEqual({ type: "function", function: { name: "f" } });
    }
    expect(R2O({ input: "hi", tool_choice: "required" }).tool_choice).toBe("required");
  });

  it("text.format json_schema → response_format and text is removed", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    const out = R2O({
      input: "hi",
      text: { format: { type: "json_schema", name: "n", schema, strict: true }, verbosity: "low" },
    });
    expect(out.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "n", schema, strict: true },
    });
    expect(out.verbosity).toBe("low");
    expect(out.text).toBeUndefined();
    const obj = R2O({ input: "hi", text: { format: { type: "json_object" } } });
    expect(obj.response_format).toEqual({ type: "json_object" });
    expect(obj.text).toBeUndefined();
  });

  it("input_file maps to a Chat file part", () => {
    const out = R2O({
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_file",
              filename: "a.pdf",
              file_data: "data:application/pdf;base64,QQ==",
            },
            { type: "input_file", file_id: "file-1" },
          ],
        },
      ],
    });
    expect(out.messages[0].content).toEqual([
      { type: "file", file: { filename: "a.pdf", file_data: "data:application/pdf;base64,QQ==" } },
      { type: "file", file: { file_id: "file-1" } },
    ]);
  });
});

describe("OpenAI → Codex Responses (reverse)", () => {
  it("maps developer messages to Responses API instructions", () => {
    const out = O2R({
      messages: [
        { role: "developer", content: "Follow the project rules." },
        { role: "user", content: "Hello" },
      ],
    });

    expect(out.instructions).toBe("Follow the project rules.");
    expect(out.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] },
    ]);
  });

  // openai-responses.js:13 — clampCallId NOT applied on Responses→Chat; but here Chat→Responses must clamp
  it("call_id longer than 64 chars is clamped", () => {
    const longId = "call_" + "x".repeat(80);
    const out = O2R({
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: longId, type: "function", function: { name: "f", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: longId, content: "ok" },
      ],
    });
    const fc = out.input.find((i) => i.type === "function_call");
    expect(fc.call_id.length).toBeLessThanOrEqual(64);
  });

  it("tool_choice function form is flattened, strings pass through", () => {
    const messages = [{ role: "user", content: "hi" }];
    const forced = O2R({ messages, tool_choice: { type: "function", function: { name: "f" } } });
    expect(forced.tool_choice).toEqual({ type: "function", name: "f" });
    expect(O2R({ messages, tool_choice: "none" }).tool_choice).toBe("none");
  });

  it("response_format → text.format without clobbering an existing text", () => {
    const messages = [{ role: "user", content: "hi" }];
    const json_schema = { name: "n", schema: { type: "object" }, strict: true };
    expect(O2R({ messages, response_format: { type: "json_schema", json_schema } }).text).toEqual({
      format: { type: "json_schema", ...json_schema },
    });
    expect(O2R({ messages, response_format: { type: "json_object" } }).text).toEqual({
      format: { type: "json_object" },
    });
    const text = { verbosity: "low" };
    expect(O2R({ messages, text, response_format: { type: "json_object" } }).text).toBe(text);
  });

  it("file part with only file_id becomes input_file by id", () => {
    const out = O2R({
      messages: [{ role: "user", content: [{ type: "file", file: { file_id: "file-1" } }] }],
    });
    expect(out.input[0].content).toEqual([{ type: "input_file", file_id: "file-1" }]);
  });
});
