import { describe, expect, it } from "vitest";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";

function createState() {
  return { toolCalls: new Map(), nextBlockIndex: 0 };
}

function getInputJsonDelta(events) {
  return events.find(
    (event) => event.type === "content_block_delta" && event.delta?.type === "input_json_delta",
  )?.delta.partial_json;
}

describe("openaiToClaudeResponse tool argument sanitization", () => {
  it("drops invalid Read pages and clamps numeric bounds", () => {
    const state = createState();

    openaiToClaudeResponse(
      {
        id: "chatcmpl-test-read",
        model: "test-model",
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "toolu_read", function: { name: "Read" } }] } },
        ],
      },
      state,
    );

    const events = openaiToClaudeResponse(
      {
        id: "chatcmpl-test-read",
        model: "test-model",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments: JSON.stringify({
                      file_path: "F:/repo/file.js",
                      offset: -5,
                      limit: 999999999,
                      pages: "",
                    }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      state,
    );

    expect(JSON.parse(getInputJsonDelta(events))).toEqual({
      file_path: "F:/repo/file.js",
      offset: 0,
      limit: 2000,
    });
  });

  it("keeps valid PDF pages", () => {
    const state = createState();

    openaiToClaudeResponse(
      {
        id: "chatcmpl-test-pdf",
        model: "test-model",
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "toolu_pdf", function: { name: "proxy_Read" } }],
            },
          },
        ],
      },
      state,
    );

    const events = openaiToClaudeResponse(
      {
        id: "chatcmpl-test-pdf",
        model: "test-model",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments: JSON.stringify({ file_path: "F:/repo/doc.pdf", pages: "1-3" }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      state,
    );

    expect(JSON.parse(getInputJsonDelta(events))).toEqual({
      file_path: "F:/repo/doc.pdf",
      pages: "1-3",
    });
  });

  it("emits complete object args without finish_reason exactly once", () => {
    const state = createState();

    openaiToClaudeResponse(
      {
        id: "chatcmpl-test-early",
        model: "test-model",
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "toolu_e", function: { name: "Read" } }] } },
        ],
      },
      state,
    );

    // Complete args object in a chunk with NO finish_reason (the original bug:
    // delta was silently dropped on this path).
    const early = openaiToClaudeResponse(
      {
        id: "chatcmpl-test-early",
        model: "test-model",
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '{"file_path":"a.js","limit":"3000"}' } },
              ],
            },
          },
        ],
      },
      state,
    );
    expect(JSON.parse(getInputJsonDelta(early))).toEqual({ file_path: "a.js", limit: 2000 });

    // Finish chunk must not re-emit the args (buffer was flushed and cleared).
    const finish = openaiToClaudeResponse(
      {
        id: "chatcmpl-test-early",
        model: "test-model",
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      },
      state,
    );
    expect(getInputJsonDelta(finish)).toBeUndefined();
    expect(finish.some((e) => e.type === "content_block_stop")).toBe(true);
  });

  it("does not emit partial split scalar args early; finish emits the joined value", () => {
    const state = createState();

    const openEvents = openaiToClaudeResponse(
      {
        id: "chatcmpl-test-scalar",
        model: "test-model",
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "toolu_s", function: { name: "Count" } }] } },
        ],
      },
      state,
    );
    expect(openEvents).not.toBeNull();

    // `"12"` parses as complete JSON but is only the first half of `"1234"`.
    const partial = openaiToClaudeResponse(
      {
        id: "chatcmpl-test-scalar",
        model: "test-model",
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"12' } }] } }],
      },
      state,
    );
    expect(partial === null ? undefined : getInputJsonDelta(partial)).toBeUndefined();

    const finish = openaiToClaudeResponse(
      {
        id: "chatcmpl-test-scalar",
        model: "test-model",
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '34"' } }] },
            finish_reason: "tool_calls",
          },
        ],
      },
      state,
    );
    expect(getInputJsonDelta(finish)).toBe('"1234"');
  });
});
