// YAN-665: tool-result images must stay images across Responses <-> Chat <-> Claude.
import { describe, expect, it } from "vitest";
import {
  openaiResponsesToOpenAIRequest,
  openaiToOpenAIResponsesRequest,
} from "../../open-sse/translator/request/openai-responses.js";
import { convertResponsesApiFormat } from "../../open-sse/translator/formats/responsesApi.js";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("tool-result images (YAN-665)", () => {
  const responsesBody = {
    input: [
      { type: "function_call", call_id: "call_1", name: "shot", arguments: "{}" },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          { type: "input_text", text: "Image read" },
          { type: "input_image", image_url: PNG },
        ],
      },
    ],
  };

  it("Responses -> Chat keeps array output as text/image_url parts", () => {
    for (const out of [
      openaiResponsesToOpenAIRequest("m", responsesBody, true, null),
      convertResponsesApiFormat(responsesBody),
    ]) {
      const tool = out.messages.find((m) => m.role === "tool");
      expect(tool.content).toEqual([
        { type: "text", text: "Image read" },
        { type: "image_url", image_url: { url: PNG, detail: "auto" } },
      ]);
    }
  });

  it("Chat tool image -> Claude image block inside tool_result", () => {
    const chat = openaiResponsesToOpenAIRequest("m", responsesBody, true, null);
    const claude = openaiToClaudeRequest("claude-sonnet-4-5", chat, false);
    const result = claude.messages.flatMap((m) => m.content).find((b) => b.type === "tool_result");
    expect(result.content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
    });
  });

  it("Chat -> Responses moves tool image to a following user input_image message", () => {
    const out = openaiToOpenAIResponsesRequest(
      "gpt-5",
      {
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "shot", arguments: "{}" } },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_1",
            content: [
              { type: "text", text: "Image read" },
              { type: "image_url", image_url: { url: PNG } },
            ],
          },
        ],
      },
      true,
      null,
    );
    const fco = out.input.find((i) => i.type === "function_call_output");
    expect(fco.output).toBe("Image read");
    expect(fco.output).not.toContain("base64");
    const last = out.input.at(-1);
    expect(last.role).toBe("user");
    expect(last.content.some((c) => c.type === "input_image" && c.image_url === PNG)).toBe(true);
  });

  it("assistant image_url never becomes input_image inside an assistant message", () => {
    const out = openaiToOpenAIResponsesRequest(
      "gpt-5",
      {
        messages: [
          { role: "user", content: "draw" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "here" },
              { type: "image_url", image_url: { url: PNG } },
            ],
          },
        ],
      },
      true,
      null,
    );
    for (const item of out.input.filter((i) => i.role === "assistant")) {
      expect(item.content.every((c) => c.type !== "input_image")).toBe(true);
    }
  });
});
