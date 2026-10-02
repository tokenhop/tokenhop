// Headroom used to compress a Claude body by translating it to OpenAI and back,
// then writing the rebuilt messages over the original — dropping thinking
// signatures and tool_result is_error, moving cache_control, and splitting
// image+text turns. The OpenAI hop also strips the `x-anthropic-billing-header`
// block that cloaking puts at system[0], and without it Anthropic bills a
// subscription (OAuth) request to extra usage: once that is spent, every Claude
// request that Headroom touched failed with 400 "You're out of extra usage".
// Only projected text fields round-trip now; everything else is written in place.
import { describe, it, expect, vi, afterEach } from "vitest";
import { compressWithHeadroom } from "../../open-sse/rtk/headroom.js";
import { translateRequest } from "../../open-sse/translator/index.js";

const MODEL = "claude-opus-5";
const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

// A cloaked Claude body, built the way chatCore builds one for an OpenAI client
// routed to a Claude OAuth account.
function cloakedClaudeBody() {
  const openaiBody = {
    model: MODEL,
    stream: true,
    messages: [
      { role: "system", content: "You are opencode." },
      { role: "user", content: "a long original message ".repeat(20) },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ],
  };
  return translateRequest(
    "openai",
    "claude",
    MODEL,
    openaiBody,
    true,
    { accessToken: "sk-ant-oat01-test" },
    "claude",
  );
}

// Headroom echoes the messages it was sent, with user text compressed.
function stubHeadroom() {
  global.fetch = vi.fn(async (_url, init) => {
    const { messages } = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        messages: messages.map((m) =>
          m.role === "user" ? { ...m, content: "compressed text" } : m,
        ),
        tokens_before: 100,
        tokens_after: 10,
        tokens_saved: 90,
      }),
      { status: 200 },
    );
  });
}

// Native Claude tool history the OpenAI hop used to mangle: thinking blocks
// with signatures, an errored tool_result, and cache_control on blocks.
function claudeToolHistoryBody() {
  return {
    model: MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Read a.js", cache_control: { type: "ephemeral" } }],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "pondering", signature: "sig-1" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "read",
            input: { path: "a.js" },
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            is_error: true,
            content: [{ type: "text", text: "boom" }],
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Try b.js instead." },
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "long tool output" }],
          },
        ],
      },
    ],
  };
}

describe("compressWithHeadroom claude format", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves system untouched, keeping the billing header at system[0]", async () => {
    const body = cloakedClaudeBody();
    const originalSystem = structuredClone(body.system);
    expect(originalSystem[0].text.startsWith(BILLING_HEADER_PREFIX)).toBe(true);
    stubHeadroom();

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: MODEL,
      format: "claude",
    });

    expect(data).not.toBeNull();
    expect(body.system).toEqual(originalSystem);
  });

  it("sends only conversation messages to the proxy and applies the compressed ones", async () => {
    const body = cloakedClaudeBody();
    stubHeadroom();

    await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: MODEL,
      format: "claude",
    });

    const sent = JSON.parse(global.fetch.mock.calls[0][1].body).messages;
    expect(sent.map((m) => m.role)).toEqual(["user"]);
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "compressed text" }] },
    ]);
  });

  it("leaves the body deep-equal when the proxy echoes messages back unchanged", async () => {
    const body = claudeToolHistoryBody();
    const original = structuredClone(body);
    global.fetch = vi.fn(async (_url, init) => {
      const { messages } = JSON.parse(init.body);
      return new Response(JSON.stringify({ messages }), { status: 200 });
    });

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: MODEL,
      format: "claude",
    });

    expect(data).not.toBeNull();
    expect(body).toEqual(original);
  });

  it("compresses tool_result text in place, preserving thinking, is_error and cache_control", async () => {
    const body = claudeToolHistoryBody();
    global.fetch = vi.fn(async (_url, init) => {
      const { messages } = JSON.parse(init.body);
      const compressed = messages.map((m) =>
        m.role === "tool" ? { ...m, content: "compressed output" } : m,
      );
      return new Response(JSON.stringify({ messages: compressed }), { status: 200 });
    });

    await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: MODEL,
      format: "claude",
    });

    const assistant = body.messages[1];
    expect(body.messages[0].content[0].text).toBe("Read a.js");
    expect(body.messages[3].content[1].content[0].text).toBe("compressed output");
    // the text block sharing the turn stays in place (no image+text splitting)
    expect(body.messages[3].content[0]).toEqual({ type: "text", text: "Try b.js instead." });
    // thinking + signature and tool_use ride along untouched
    expect(assistant.content[0]).toEqual({
      type: "thinking",
      thinking: "pondering",
      signature: "sig-1",
    });
    expect(assistant.content[1]).toEqual({
      type: "tool_use",
      id: "toolu_1",
      name: "read",
      input: { path: "a.js" },
      cache_control: { type: "ephemeral" },
    });
    // is_error results are never sent, so they can't be rewritten
    expect(body.messages[2].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_1",
      is_error: true,
      content: [{ type: "text", text: "boom" }],
    });
  });
});
