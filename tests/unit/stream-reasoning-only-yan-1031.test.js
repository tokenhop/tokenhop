// YAN-1031: reasoning-only streams are not successes — no answer token means
// request detail is an error and account health is not cleared.
import { describe, it, expect, vi } from "vitest";

const { details, requestLogs } = vi.hoisted(() => ({ details: [], requestLogs: [] }));
vi.mock("@/lib/usageDb.js", async (importOriginal) => ({
  ...(await importOriginal()),
  saveRequestDetailUnscoped: vi.fn(async (d) => details.push(d)),
  saveUsageStats: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async (e) => requestLogs.push(e)),
  trackPendingRequest: vi.fn(),
}));

import { hasAnswerToken, hasMeaningfulToken } from "../../open-sse/utils/streamHelpers.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";
const { handleStreamingResponse, buildOnStreamComplete } = await import(
  "../../open-sse/handlers/chatCore/streamingHandler.js"
);

const encoder = new TextEncoder();
const data = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const doneLine = "data: [DONE]\n\n";
const quietLog = { line() {}, errorLine() {} };

describe("hasAnswerToken vs hasMeaningfulToken (YAN-1031)", () => {
  it.each([
    ["OpenAI reasoning", { choices: [{ delta: { reasoning_content: "hm" } }] }, true, false],
    ["OpenAI text", { choices: [{ delta: { content: "hi" } }] }, true, true],
    ["OpenAI refusal", { choices: [{ delta: { refusal: "no" } }] }, true, true],
    [
      "OpenAI tool call",
      { choices: [{ delta: { tool_calls: [{ function: { name: "get_x" } }] } }] },
      true,
      true,
    ],
    [
      "Claude thinking delta",
      { type: "content_block_delta", delta: { thinking: "hm" } },
      true,
      false,
    ],
    ["Claude text delta", { type: "content_block_delta", delta: { text: "hi" } }, true, true],
    [
      "Claude thinking block start",
      { type: "content_block_start", content_block: { type: "thinking", thinking: "hm" } },
      true,
      false,
    ],
    [
      "Claude tool_use start",
      { type: "content_block_start", content_block: { type: "tool_use", name: "get_x" } },
      true,
      true,
    ],
    ["Responses reasoning", { type: "response.reasoning_text.delta", delta: "hm" }, true, false],
    [
      "Responses reasoning summary",
      { type: "response.reasoning_summary_text.delta", delta: "hm" },
      true,
      false,
    ],
    ["Responses text", { type: "response.output_text.delta", delta: "hi" }, true, true],
    [
      "Responses tool args",
      { type: "response.function_call_arguments.delta", delta: "{}" },
      true,
      true,
    ],
    // YAN-1030: reasoning next to an answer kind in ONE delta is an answer.
    [
      "OpenAI reasoning + tool_calls in one delta",
      {
        choices: [
          { delta: { reasoning_content: "hm", tool_calls: [{ function: { name: "get_x" } }] } },
        ],
      },
      true,
      true,
    ],
    [
      "OpenAI reasoning + empty tool_calls shell stays reasoning",
      {
        choices: [{ delta: { reasoning_content: "hm", tool_calls: [{ function: { name: "" } }] } }],
      },
      true,
      false,
    ],
    [
      "OpenAI reasoning + images in one delta",
      { choices: [{ delta: { reasoning_content: "hm", images: [{ type: "image_url" }] } }] },
      true,
      true,
    ],
    [
      "OpenAI reasoning + audio in one delta",
      { choices: [{ delta: { reasoning_content: "hm", audio: { data: "AA==" } } }] },
      true,
      true,
    ],
    [
      "Ollama thinking + tool_calls (translated delta)",
      {
        choices: [
          { delta: { reasoning_content: "hm", tool_calls: [{ function: { name: "get_x" } }] } },
        ],
      },
      true,
      true,
    ],
    [
      "Ollama message.thinking is reasoning",
      { message: { content: "", thinking: "hm" } },
      true,
      false,
    ],
    [
      "Ollama message.thinking + tool_calls is an answer",
      { message: { thinking: "hm", tool_calls: [{ function: { name: "x" } }] } },
      true,
      true,
    ],
    ["Ollama reasoning", { message: { content: "", reasoning_content: "hm" } }, true, false],
    ["Ollama text", { message: { content: "hi" } }, true, true],
    [
      "Gemini thought part",
      { candidates: [{ content: { parts: [{ text: "hm", thought: true }] } }] },
      true,
      false,
    ],
    ["Gemini text part", { candidates: [{ content: { parts: [{ text: "hi" }] } }] }, true, true],
    ["role only", { choices: [{ delta: { role: "assistant" } }] }, false, false],
  ])("%s: meaningful=%s answer=%s", (_l, frame, meaningful, answer) => {
    expect(hasMeaningfulToken(frame)).toBe(meaningful);
    expect(hasAnswerToken(frame)).toBe(answer);
  });

  it("unwraps the {event,data} envelope for answer detection", () => {
    expect(
      hasAnswerToken({
        event: "response.reasoning_text.delta",
        data: { type: "response.reasoning_text.delta", delta: "hm" },
      }),
    ).toBe(false);
    expect(
      hasAnswerToken({
        event: "response.output_text.delta",
        data: { type: "response.output_text.delta", delta: "hi" },
      }),
    ).toBe(true);
  });
});

describe("buildOnStreamComplete reasoning-only status (YAN-1031)", () => {
  const complete = () =>
    buildOnStreamComplete({ provider: "p", model: "m", requestStartTime: Date.now(), body: {} })
      .onStreamComplete;

  it("reasoning-only → error with reasoning-only message, thinking kept", () => {
    details.length = 0;
    complete()({ content: "", thinking: "hm" }, null, null, {
      firstTokenAt: 123,
      firstAnswerAt: null,
    });
    const d = details.at(-1);
    expect(d.status).toBe("error");
    expect(d.response.error.message).toBe("no answer content (reasoning only)");
    expect(d.response.thinking).toBe("hm");
  });

  it("fully empty → existing empty-stream message", () => {
    details.length = 0;
    complete()({}, null, null, { firstTokenAt: null, firstAnswerAt: null });
    expect(details.at(-1).status).toBe("error");
    expect(details.at(-1).response.error.message).toBe("empty streaming response");
  });

  it("untracked firstAnswerAt (undefined) falls back to old behaviour", () => {
    details.length = 0;
    complete()({ content: "", thinking: "hm" }, null, null, { firstTokenAt: 123 });
    expect(details.at(-1).status).toBe("success");
  });

  it("text → success; tool-only (answer token seen) → success", () => {
    details.length = 0;
    complete()({ content: "hi" }, null, null, { firstTokenAt: 123, firstAnswerAt: 124 });
    expect(details.at(-1).status).toBe("success");
    details.length = 0;
    complete()({}, null, null, { firstTokenAt: 123, firstAnswerAt: 124 });
    expect(details.at(-1).status).toBe("success");
  });
});

describe("createSSEStream firstAnswerAt (YAN-1031)", () => {
  async function run(frames) {
    const complete = vi.fn();
    const onFirstAnswerToken = vi.fn();
    const onFirstToken = vi.fn();
    const ts = createSSEStream({
      mode: "passthrough",
      provider: "openai",
      model: "m",
      body: { messages: [] },
      onStreamComplete: complete,
      onFirstAnswerToken,
      onFirstToken,
    });
    const src = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(frames));
        c.close();
      },
    });
    await new Response(src.pipeThrough(ts)).text();
    return { complete, onFirstAnswerToken, onFirstToken };
  }

  it("reasoning-only: firstToken set, firstAnswerAt null, no answer callback", async () => {
    const r = await run(data({ choices: [{ delta: { reasoning_content: "hm" } }] }) + doneLine);
    expect(r.onFirstToken).toHaveBeenCalledOnce();
    expect(r.onFirstAnswerToken).not.toHaveBeenCalled();
    const arg4 = r.complete.mock.calls[0][3];
    expect(arg4.firstTokenAt).not.toBeNull();
    expect(arg4.firstAnswerAt).toBeNull();
  });

  it("text: firstAnswerAt set and answer callback fires once", async () => {
    const r = await run(
      data({ choices: [{ delta: { reasoning_content: "hm" } }] }) +
        data({ choices: [{ delta: { content: "hi" } }] }) +
        data({ choices: [{ delta: { content: "!" } }] }) +
        doneLine,
    );
    expect(r.onFirstAnswerToken).toHaveBeenCalledOnce();
    expect(r.complete.mock.calls[0][3].firstAnswerAt).not.toBeNull();
  });
});

describe("handleStreamingResponse reasoning-only (YAN-1031)", () => {
  async function run(frames, onRequestSuccess) {
    details.length = 0;
    const { onStreamComplete, streamDetailId } = buildOnStreamComplete({
      provider: "openai",
      model: "m",
      requestStartTime: Date.now(),
      body: { messages: [], model: "m", stream: true },
    });
    let upstream;
    const body = new ReadableStream({
      start(c) {
        upstream = c;
      },
    });
    upstream.enqueue(encoder.encode(frames));
    upstream.close();
    const result = await handleStreamingResponse({
      providerResponse: new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
      provider: "openai",
      model: "m",
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      body: { messages: [], model: "m", stream: true },
      stream: true,
      requestStartTime: Date.now(),
      log: quietLog,
      streamController: createStreamController({ log: quietLog, provider: "openai", model: "m" }),
      onRequestSuccess,
      onStreamComplete,
      streamDetailId,
      comboAttempt: null,
    });
    await new Response(result.response.body).text();
    await Promise.resolve();
    return result;
  }

  it("reasoning-only stream → detail error, onRequestSuccess NOT called", async () => {
    const onRequestSuccess = vi.fn();
    await run(
      data({ choices: [{ delta: { reasoning_content: "hm" } }] }) + doneLine,
      onRequestSuccess,
    );
    expect(onRequestSuccess).not.toHaveBeenCalled();
    const d = details.at(-1);
    expect(d.status).toBe("error");
    expect(d.response.error.message).toBe("no answer content (reasoning only)");
    expect(d.response.thinking).toBe("hm");
  });

  it("text stream → success, onRequestSuccess called once", async () => {
    const onRequestSuccess = vi.fn();
    await run(
      data({ choices: [{ delta: { reasoning_content: "hm" } }] }) +
        data({ choices: [{ delta: { content: "hello" } }] }) +
        doneLine,
      onRequestSuccess,
    );
    expect(onRequestSuccess).toHaveBeenCalledOnce();
    expect(details.at(-1).status).toBe("success");
  });

  it("tool-call-only stream → success, onRequestSuccess called once", async () => {
    const onRequestSuccess = vi.fn();
    await run(
      data({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { name: "get_x", arguments: "{}" } }] } },
        ],
      }) + doneLine,
      onRequestSuccess,
    );
    expect(onRequestSuccess).toHaveBeenCalledOnce();
    expect(details.at(-1).status).toBe("success");
  });
});
