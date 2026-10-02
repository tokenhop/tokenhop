// Real Antigravity-MITM requests (Gemini-internal: { request: { contents, ... } }) → OpenAI.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest, translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.js";
import { ANTIGRAVITY_DEFAULT_SYSTEM } from "../../open-sse/config/appConstants.js";

const AG2O = (req) =>
  translateRequest(FORMATS.ANTIGRAVITY, FORMATS.OPENAI, "m", { request: req }, true, null, null);

describe("Antigravity → OpenAI", () => {
  // antigravity-to-openai.js — parallel same-name functionCalls without ids must get
  // distinct ids, FIFO-paired to their functionResponses in order (YAN-31/#165)
  it("parallel same-name calls get distinct ids paired to results in order", () => {
    const out = AG2O({
      contents: [
        {
          role: "model",
          parts: [
            { functionCall: { name: "read_file", args: { path: "a" } } },
            { functionCall: { name: "read_file", args: { path: "b" } } },
          ],
        },
        {
          role: "user",
          parts: [
            { functionResponse: { name: "read_file", response: { result: "AAA" } } },
            { functionResponse: { name: "read_file", response: { result: "BBB" } } },
          ],
        },
      ],
    });
    const asst = out.messages.find((m) => m.tool_calls);
    const callIds = asst?.tool_calls?.map((tc) => tc.id) ?? [];
    const tools = out.messages.filter((m) => m.role === "tool");
    expect(new Set(callIds).size, "parallel call ids collided").toBe(2);
    expect(tools).toHaveLength(2);
    expect(tools[0]?.tool_call_id, "first result not paired to first call").toBe(callIds[0]);
    expect(tools[1]?.tool_call_id, "second result not paired to second call").toBe(callIds[1]);
    expect(tools[0]?.content).toBe('"AAA"');
    expect(tools[1]?.content).toBe('"BBB"');
  });

  // antigravity-to-openai.js — content with BOTH functionResponse and functionCall/text
  // previously returned toolResults early → dropped tool calls / text (fixed in #2225).
  // Ordering: the assistant call must precede its corresponding tool result.
  it("functionResponse + functionCall in same content keeps both", () => {
    const out = AG2O({
      contents: [
        {
          role: "model",
          parts: [
            { functionResponse: { id: "c1", name: "prev", response: { result: "done" } } },
            { functionCall: { id: "c2", name: "next", args: {} } },
          ],
        },
      ],
    });
    const json = JSON.stringify(out);
    expect(json, "functionCall lost when sharing content with functionResponse").toContain(
      '"next"',
    );
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]?.role, "assistant call must precede tool result").toBe("assistant");
    expect(out.messages[0]?.tool_calls?.[0]?.id).toBe("c2");
    expect(out.messages[1]?.role).toBe("tool");
    expect(out.messages[1]?.tool_call_id).toBe("c1");
  });

  it("keeps user text role when sharing a function response", () => {
    const out = AG2O({
      contents: [
        { role: "model", parts: [{ functionCall: { id: "c1", name: "foo" } }] },
        {
          role: "user",
          parts: [
            { text: "next prompt" },
            { functionResponse: { id: "c1", name: "foo", response: { result: "ok" } } },
          ],
        },
      ],
    });
    expect(out.messages.map((message) => message.role)).toEqual(["assistant", "tool", "user"]);
    expect(out.messages[1]?.tool_call_id).toBe("c1");
    expect(out.messages[2]?.content).toBe("next prompt");
  });

  // antigravity-to-openai.js:167 — functionCall without id gets a random Date.now() id
  // KNOWN BUG: unstable id breaks matching with its functionResponse
  it("functionCall without id keeps a stable matchable id", () => {
    const out = AG2O({
      contents: [
        { role: "model", parts: [{ functionCall: { name: "search", args: { q: "x" } } }] },
        {
          role: "user",
          parts: [{ functionResponse: { name: "search", response: { result: "r" } } }],
        },
      ],
    });
    const asst = out.messages.find((m) => m.tool_calls);
    const tool = out.messages.find((m) => m.role === "tool");
    expect(tool?.tool_call_id, "id mismatch between call and response").toBe(
      asst?.tool_calls?.[0]?.id,
    );
  });

  // antigravity-to-openai.js:144-147 — signature-only part handling (regression guard)
  it("signature-only part does not produce empty text", () => {
    const out = AG2O({
      contents: [{ role: "model", parts: [{ thoughtSignature: "sig", text: "" }] }],
    });
    const asst = out.messages.find((m) => m.role === "assistant");
    const content = asst?.content;
    const hasEmpty = Array.isArray(content)
      ? content.some((c) => c.type === "text" && c.text === "")
      : content === "";
    expect(hasEmpty, "empty text part emitted").toBe(false);
  });
});

describe("Antigravity → Claude", () => {
  it("tool call input_json_delta includes Anthropic index", () => {
    const state = initState(FORMATS.CLAUDE);
    const events = translateResponse(
      FORMATS.ANTIGRAVITY,
      FORMATS.CLAUDE,
      {
        response: {
          responseId: "resp-1",
          modelVersion: "gemini-pro-agent",
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ functionCall: { name: "bash", args: { command: "git status" } } }],
              },
              finishReason: "STOP",
              index: 0,
            },
          ],
        },
      },
      state,
    );

    const jsonDelta = events.find(
      (event) => event.type === "content_block_delta" && event.delta?.type === "input_json_delta",
    );
    expect(jsonDelta).toMatchObject({ index: expect.any(Number) });
    expect(JSON.parse(jsonDelta.delta.partial_json)).toEqual({ command: "git status" });
  });
});

describe("Antigravity executor", () => {
  it("strips optional from nested tool schemas", () => {
    const out = new AntigravityExecutor().transformRequest(
      "gemini-2.5-pro",
      {
        request: {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          tools: [
            {
              functionDeclarations: [
                {
                  name: "lookup",
                  description: "Lookup a value",
                  parameters: {
                    type: "object",
                    properties: {
                      query: {
                        type: "string",
                        description: "Search query",
                        optional: true,
                      },
                    },
                  },
                },
              ],
            },
          ],
        },
      },
      true,
      { projectId: "project-1", connectionId: "conn-1" },
    );

    const query = out.request.tools[0].functionDeclarations[0].parameters.properties.query;
    expect(query).toEqual({ type: "string", description: "Search query" });
  });

  it("does not inject the legacy Antigravity default system prompt for Gemini-backed models", () => {
    const out = openaiToAntigravityRequest(
      "gemini-3.5-flash-low",
      {
        messages: [
          { role: "system", content: "USER_SYSTEM_PROMPT" },
          { role: "user", content: "hello" },
        ],
      },
      true,
      { projectId: "project-1", connectionId: "conn-1" },
    );

    const system = JSON.stringify(out.request.systemInstruction);
    expect(system).toContain("USER_SYSTEM_PROMPT");
    expect(system).not.toContain(ANTIGRAVITY_DEFAULT_SYSTEM);
    expect(system).not.toContain("Please ignore the following [ignore]");
  });

  it("does not inject the legacy Antigravity default system prompt for Claude-backed models", () => {
    const out = openaiToAntigravityRequest(
      "claude-opus-4-6-thinking",
      {
        messages: [
          { role: "system", content: "USER_SYSTEM_PROMPT" },
          { role: "user", content: "hello" },
        ],
      },
      true,
      { projectId: "project-1", connectionId: "conn-1" },
    );

    const system = JSON.stringify(out.request.systemInstruction);
    expect(system).toContain("USER_SYSTEM_PROMPT");
    expect(system).not.toContain(ANTIGRAVITY_DEFAULT_SYSTEM);
    expect(system).not.toContain("Please ignore the following [ignore]");
  });

  // YAN-41 / #500 — Claude envelope keeps user images and tool-result images as inlineData.
  it("Claude-backed envelope keeps user and tool-result images as inlineData", () => {
    const img = { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } };
    const out = openaiToAntigravityRequest(
      "claude-sonnet-4-6",
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "what" }, img] },
          {
            role: "assistant",
            tool_calls: [
              { id: "c1", type: "function", function: { name: "shot", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "c1", content: [{ type: "text", text: "done" }, img] },
        ],
      },
      true,
      { projectId: "project-1", connectionId: "conn-1" },
    );
    const [user, , toolTurn] = out.request.contents;
    expect(user.parts).toContainEqual({ inlineData: { mimeType: "image/png", data: "QUJD" } });
    expect(toolTurn.parts[0].functionResponse.response.result).toBe("done");
    expect(toolTurn.parts).toContainEqual({ inlineData: { mimeType: "image/png", data: "QUJD" } });
  });
});
