// YAN-764: createSSEStream onStreamResult — first meaningful emitted payload,
// single notification at the actual client terminal / flush, error propagation.
// Time is driven by a mocked Date.now; chunks are stepped manually (enqueue at
// an explicit timestamp, then read) so timing is fully deterministic.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Capture the fallback request-log entry finalizeStream() writes when there is
// no usage — its status must not be polluted by routing-only tail errors.
const { requestLogCalls } = vi.hoisted(() => ({ requestLogCalls: [] }));
vi.mock("@/lib/usageDb.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    trackPendingRequest: vi.fn(),
    appendRequestLog: vi.fn(async (entry) => {
      requestLogCalls.push(entry);
    }),
  };
});

import { createSSEStream } from "../../open-sse/utils/stream.js";
import { hasMeaningfulToken } from "../../open-sse/utils/streamHelpers.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const te = new TextEncoder();
const dec = new TextDecoder();

let now = 1000;
let nowSpy;

beforeEach(() => {
  now = 1000;
  nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  nowSpy.mockRestore();
});

const ROLE = 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n';
const TOK = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
const DONE = "data: [DONE]\n\n";
const HEARTBEAT = ": keep-alive\n\n";

// Persistent pump owns the reader (no lost reads). feed() sets the mocked clock,
// writes one upstream chunk, then lets the pipeline settle on a short REAL timer
// (only Date.now is mocked) so the transform runs before the clock moves again.
const settle = () => new Promise((r) => setTimeout(r, 5));

function rig(streamOpts) {
  const cb = vi.fn();
  const ts = createSSEStream({ ...streamOpts, onStreamResult: cb });
  const up = new TransformStream();
  const writer = up.writable.getWriter();
  const rd = up.readable.pipeThrough(ts).getReader();
  let text = "";
  let finished = false;
  const pump = (async () => {
    try {
      for (;;) {
        const f = await rd.read();
        if (f.done) break;
        text += dec.decode(f.value);
      }
    } catch {
      // cancelled / errored
    }
    finished = true;
  })();
  const feed = async (chunk, t) => {
    now = t;
    await writer.write(te.encode(chunk));
    await settle();
  };
  const finish = async () => {
    await writer.close();
    await pump;
  };
  return { cb, feed, finish, rd, text: () => text, finished: () => finished };
}

describe("createSSEStream onStreamResult", () => {
  it("firstTokenAt ignores headers/role/heartbeat; stamps the content chunk", async () => {
    const r = rig({ mode: "passthrough", provider: "x" });
    await r.feed(HEARTBEAT, 1000);
    await r.feed(ROLE, 1500);
    await r.feed(TOK, 2500);
    await r.feed(DONE, 3000);
    await r.finish();
    expect(r.cb).toHaveBeenCalledTimes(1);
    expect(r.cb.mock.calls[0][0]).toEqual({ firstTokenAt: 2500, error: null, cancelled: false });
  });

  it("notify once at the terminal even with trailing upstream frames", async () => {
    const r = rig({ mode: "passthrough", provider: "x" });
    await r.feed(TOK, 1000);
    await r.feed(DONE, 1100);
    await r.feed("event: extra\n\n", 1200);
    await r.finish();
    expect(r.cb).toHaveBeenCalledTimes(1);
    expect(r.cb.mock.calls[0][0].firstTokenAt).toBe(1000);
  });

  it("mid-stream error after content: error set AND firstTokenAt kept", async () => {
    const r = rig({ mode: "passthrough", provider: "x" });
    await r.feed(TOK, 1000);
    await r.feed('data: {"error":{"message":"boom"}}\n\n', 2000);
    await r.feed(DONE, 2100);
    await r.finish();
    expect(r.cb).toHaveBeenCalledTimes(1);
    const res = r.cb.mock.calls[0][0];
    expect(res.firstTokenAt).toBe(1000);
    expect(res.error?.message).toBe("boom");
    expect(res.cancelled).toBe(false);
  });

  it("empty stream (role/usage/finish only): firstTokenAt null, still notified once", async () => {
    const r = rig({ mode: "passthrough", provider: "x" });
    await r.feed(ROLE, 1000);
    await r.feed('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', 1100);
    await r.feed('data: {"usage":{"prompt_tokens":5}}\n\n', 1200);
    await r.feed(DONE, 1300);
    await r.finish();
    expect(r.cb).toHaveBeenCalledTimes(1);
    expect(r.cb.mock.calls[0][0].firstTokenAt).toBeNull();
    expect(r.cb.mock.calls[0][0].error).toBeNull();
  });

  it("empty stream is logged 200 EMPTY, not 200 OK (YAN-1023)", async () => {
    requestLogCalls.length = 0;
    const onStreamComplete = vi.fn();
    const r = rig({ mode: "passthrough", provider: "x", onStreamComplete });
    await r.feed(ROLE + DONE, 1000);
    await r.finish();
    expect(requestLogCalls.at(-1).status).toBe("200 EMPTY");
    expect(onStreamComplete.mock.calls[0][3].firstTokenAt).toBeNull();
  });

  it("downstream cancel before the terminal: no notification", async () => {
    const r = rig({ mode: "passthrough", provider: "x" });
    await r.feed(ROLE, 1000);
    await r.feed(TOK, 2000);
    await r.rd.cancel("client closed");
    await settle();
    expect(r.cb).not.toHaveBeenCalled();
  });

  it("downstream cancel after the terminal: result retained", async () => {
    const r = rig({ mode: "passthrough", provider: "x" });
    await r.feed(TOK, 1000);
    await r.feed(DONE, 1100);
    expect(r.cb).toHaveBeenCalledTimes(1);
    await r.rd.cancel("late close");
    await settle();
    expect(r.cb).toHaveBeenCalledTimes(1);
    expect(r.cb.mock.calls[0][0].firstTokenAt).toBe(1000);
  });

  it("Responses terminal event is the terminal (no [DONE] needed)", async () => {
    const r = rig({
      mode: "translate",
      targetFormat: FORMATS.OPENAI_RESPONSES,
      sourceFormat: FORMATS.OPENAI_RESPONSES,
    });
    await r.feed(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      1000,
    );
    await r.feed(
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
      1500,
    );
    expect(r.cb).toHaveBeenCalledTimes(1); // before upstream even closes
    await r.finish();
    expect(r.cb).toHaveBeenCalledTimes(1);
    expect(r.cb.mock.calls[0][0]).toEqual({ firstTokenAt: 1000, error: null, cancelled: false });
  });

  it("Responses stream that never terminates: synthesized failure is an error", async () => {
    const r = rig({
      mode: "translate",
      targetFormat: FORMATS.OPENAI_RESPONSES,
      sourceFormat: FORMATS.OPENAI_RESPONSES,
    });
    await r.feed(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      1000,
    );
    await r.feed(DONE, 1200);
    await r.finish();
    expect(r.cb).toHaveBeenCalledTimes(1);
    const res = r.cb.mock.calls[0][0];
    expect(res.firstTokenAt).toBe(1000);
    expect(res.error?.message).toContain("stream closed before response.completed");
  });

  it("translated stream: upstream [DONE] must NOT notify before the translator tail (flush)", async () => {
    const r = rig({
      mode: "translate",
      targetFormat: FORMATS.OPENAI,
      sourceFormat: FORMATS.OPENAI,
    });
    await r.feed(TOK, 1000);
    expect(r.text()).toContain("hi");

    // Upstream sentinel: swallowed mid-stream, no client terminal yet, no notify.
    await r.feed(DONE, 2000);
    expect(r.cb).not.toHaveBeenCalled();

    await r.finish();
    expect(r.cb).toHaveBeenCalledTimes(1);
    expect(r.cb.mock.calls[0][0].firstTokenAt).toBe(1000);
    expect(r.cb.mock.calls[0][0].error).toBeNull();
    // Client terminal comes after the tail, exactly once.
    expect(r.text().trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(r.text().match(/\[DONE\]/g)).toHaveLength(1);
  });

  it("flush failure notifies with an error, never success", async () => {
    const r = rig({
      mode: "translate",
      targetFormat: FORMATS.OPENAI,
      sourceFormat: FORMATS.CLAUDE,
      reqLogger: {
        appendConvertedChunk() {
          throw new Error("logger boom");
        },
      },
    });
    // No trailing newline: the chunk stays buffered and is only processed in
    // flush(), where the throwing logger forces flush()'s catch path.
    await r.feed('data: {"choices":[{"delta":{"content":"z"}}]}', 1000);
    await r.finish().catch(() => {});
    expect(r.cb).toHaveBeenCalledTimes(1);
    expect(r.cb.mock.calls[0][0].error?.message).toBe("logger boom");
    expect(r.cb.mock.calls[0][0].cancelled).toBe(false);
  });

  it("throwing onStreamResult never breaks the stream", async () => {
    const cb = vi.fn(() => {
      throw new Error("observer boom");
    });
    const ts = createSSEStream({ mode: "passthrough", provider: "x", onStreamResult: cb });
    const text = await new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(te.encode(TOK));
          c.enqueue(te.encode(DONE));
          c.close();
        },
      }).pipeThrough(ts),
    ).text();
    expect(cb).toHaveBeenCalledTimes(1); // called despite throwing
    expect(text).toContain("hi");
  });
});

// YAN-1014: Gemini-family passthrough has no [DONE]; a clean EOF without a
// non-empty finishReason is a truncated stream, a routing failure (bytes untouched).
describe("createSSEStream Gemini-family truncated EOF", () => {
  const gem = (cand) => `data: ${JSON.stringify({ candidates: [cand] })}\n\n`;
  const part = { content: { parts: [{ text: "hi" }] } };
  const TXT = gem(part);
  const wrap = (cand) => `data: ${JSON.stringify({ response: { candidates: [cand] } })}\n\n`;
  const TRUNC = "stream closed before finishReason";

  it.each([
    ["gemini, no finishReason", "gemini", [TXT], TRUNC],
    ["vertex, no finishReason", "vertex", [TXT], TRUNC],
    ["antigravity wrapped, no finishReason", "antigravity", [wrap(part)], TRUNC],
    ["empty finishReason", "gemini", [TXT, gem({ finishReason: "" })], TRUNC],
    ["null finishReason", "gemini", [TXT, gem({ finishReason: null })], TRUNC],
    [
      "FINISH_REASON_UNSPECIFIED",
      "gemini",
      [TXT, gem({ finishReason: "FINISH_REASON_UNSPECIFIED" })],
      TRUNC,
    ],
    [
      "upstream error keeps precedence",
      "gemini",
      [TXT, 'data: {"error":{"message":"boom"}}\n\n'],
      "boom",
    ],
    ["gemini terminal STOP", "gemini", [TXT, gem({ finishReason: "STOP" })], null],
    ["vertex unlisted terminal reason", "vertex", [TXT, gem({ finishReason: "NEW_REASON" })], null],
    [
      "antigravity wrapped terminal",
      "antigravity",
      [wrap(part), wrap({ finishReason: "STOP" })],
      null,
    ],
    ["non-Gemini provider unchanged", "x", [TXT], null],
    [
      "text and finishReason in one frame",
      "gemini",
      [gem({ ...part, finishReason: "STOP" })],
      null,
    ],
    [
      "second candidate finishes",
      "gemini",
      [`data: ${JSON.stringify({ candidates: [part, { finishReason: "STOP" }] })}\n\n`],
      null,
    ],
    [
      "blocked prompt is terminal",
      "gemini",
      [TXT, `data: ${JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } })}\n\n`],
      null,
    ],
    [
      "antigravity wrapped blocked prompt is terminal",
      "antigravity",
      [
        wrap(part),
        `data: ${JSON.stringify({ response: { promptFeedback: { blockReason: "OTHER" } } })}\n\n`,
      ],
      null,
    ],
    [
      "unspecified blockReason is not terminal",
      "gemini",
      [
        TXT,
        `data: ${JSON.stringify({ promptFeedback: { blockReason: "BLOCK_REASON_UNSPECIFIED" } })}\n\n`,
      ],
      TRUNC,
    ],
  ])("%s", async (_name, provider, frames, expected) => {
    const r = rig({ mode: "passthrough", provider });
    let t = 1000;
    for (const f of frames) {
      t += 100;
      await r.feed(f, t);
    }
    await r.finish();
    expect(r.cb).toHaveBeenCalledTimes(1);
    const res = r.cb.mock.calls[0][0];
    expect(res.firstTokenAt).toBe(1100);
    expect(res.cancelled).toBe(false);
    if (expected) expect(res.error?.message).toBe(expected);
    else expect(res.error).toBeNull();
    // Bytes unchanged; non-Gemini providers still get the [DONE] sentinel appended.
    const sentinel = ["gemini", "vertex", "antigravity"].includes(provider)
      ? ""
      : "data: [DONE]\n\n";
    expect(r.text()).toBe(frames.join("") + sentinel);
  });

  it("final terminal frame without trailing newline counts", async () => {
    const r = rig({ mode: "passthrough", provider: "gemini" });
    await r.feed(TXT, 1100);
    await r.feed(gem({ finishReason: "STOP" }).trimEnd(), 1200);
    await r.finish();
    expect(r.cb).toHaveBeenCalledTimes(1);
    expect(r.cb.mock.calls[0][0]).toEqual({ firstTokenAt: 1100, error: null, cancelled: false });
  });

  it("unterminated final error frame reports the upstream error", async () => {
    const r = rig({ mode: "passthrough", provider: "gemini" });
    await r.feed(TXT, 1100);
    await r.feed('data: {"error":{"message":"boom"}}', 1200);
    await r.finish();
    expect(r.cb).toHaveBeenCalledTimes(1);
    expect(r.cb.mock.calls[0][0].error?.message).toBe("boom");
  });

  it("tail error is routing-only: completion and request log stay successful", async () => {
    requestLogCalls.length = 0;
    const onStreamComplete = vi.fn();
    const r = rig({ mode: "passthrough", provider: "gemini", onStreamComplete });
    // Text first: a tokenless stream is logged "200 EMPTY" (YAN-1023).
    await r.feed(`${TXT}data: {"error":{"message":"tail boom"}}`, 1100);
    await r.finish();
    expect(r.cb.mock.calls[0][0].error?.message).toBe("tail boom");
    expect(onStreamComplete).toHaveBeenCalledTimes(1);
    expect(onStreamComplete.mock.calls[0][3].error).toBeNull();
    expect(requestLogCalls.at(-1).status).toBe("200 OK");
  });

  it.each([false, true])("Gemini DONE waits for EOF validation (finish=%s)", async (finish) => {
    const r = rig({ mode: "passthrough", provider: "gemini" });
    const frames = TXT + (finish ? gem({ finishReason: "STOP" }) : "") + "data: [DONE]\n\n";
    await r.feed(frames, 1100);
    expect(r.cb).not.toHaveBeenCalled();
    await r.finish();
    expect(r.cb).toHaveBeenCalledTimes(1);
    expect(r.cb.mock.calls[0][0].error?.message ?? null).toBe(finish ? null : TRUNC);
    expect(r.text()).toBe(frames);
  });
});

describe("hasMeaningfulToken", () => {
  // OpenAI chat / completions
  it("role-only, usage-only, finish-only frames are not tokens", () => {
    expect(hasMeaningfulToken({ choices: [{ delta: { role: "assistant" } }] })).toBe(false);
    expect(hasMeaningfulToken({ choices: [{ delta: {}, finish_reason: "stop" }] })).toBe(false);
    expect(hasMeaningfulToken({ choices: [], usage: { prompt_tokens: 1 } })).toBe(false);
    expect(hasMeaningfulToken({ usage: { prompt_tokens: 1 } })).toBe(false);
  });
  it("non-empty text counts, including whitespace", () => {
    expect(hasMeaningfulToken({ choices: [{ delta: { content: "hi" } }] })).toBe(true);
    expect(hasMeaningfulToken({ choices: [{ delta: { content: " " } }] })).toBe(true);
    expect(hasMeaningfulToken({ choices: [{ delta: { content: "" } }] })).toBe(false);
    expect(hasMeaningfulToken({ choices: [{ text: "x" }] })).toBe(true); // legacy/FIM
    expect(hasMeaningfulToken({ choices: [{ text: "" }] })).toBe(false);
  });
  it("reasoning counts", () => {
    expect(hasMeaningfulToken({ choices: [{ delta: { reasoning_content: "th" } }] })).toBe(true);
    expect(hasMeaningfulToken({ choices: [{ delta: { reasoning_content: "" } }] })).toBe(false);
  });
  it("tool lifecycle shells are not tokens; productive tool payloads are", () => {
    expect(hasMeaningfulToken({ choices: [{ delta: { tool_calls: [] } }] })).toBe(false);
    // id-only shell: empty function name and arguments
    expect(
      hasMeaningfulToken({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "call_1", function: { name: "", arguments: "" } }],
            },
          },
        ],
      }),
    ).toBe(false);
    expect(
      hasMeaningfulToken({
        choices: [{ delta: { tool_calls: [{ function: { name: "get_x" } }] } }],
      }),
    ).toBe(true);
    expect(
      hasMeaningfulToken({ choices: [{ delta: { tool_calls: [{ function: { name: "" } }] } }] }),
    ).toBe(false);
    expect(
      hasMeaningfulToken({
        choices: [{ delta: { tool_calls: [{ function: { arguments: '{"a":' } }] } }],
      }),
    ).toBe(true);
    expect(
      hasMeaningfulToken({
        choices: [{ delta: { tool_calls: [{ function: { arguments: "" } }] } }],
      }),
    ).toBe(false);
  });

  // Claude
  it("Claude: text/thinking deltas count; partial_json args do not; tool name does", () => {
    expect(hasMeaningfulToken({ type: "content_block_delta", delta: { text: "x" } })).toBe(true);
    expect(hasMeaningfulToken({ type: "content_block_delta", delta: { text: "" } })).toBe(false);
    expect(hasMeaningfulToken({ type: "content_block_delta", delta: { thinking: "hm" } })).toBe(
      true,
    );
    expect(
      hasMeaningfulToken({ type: "content_block_delta", delta: { partial_json: '{"a":' } }),
    ).toBe(false);
    expect(
      hasMeaningfulToken({
        type: "content_block_start",
        content_block: { type: "tool_use", id: "t", name: "get_x", input: {} },
      }),
    ).toBe(true);
    expect(
      hasMeaningfulToken({
        type: "content_block_start",
        content_block: { type: "tool_use", id: "t", name: "", input: {} },
      }),
    ).toBe(false);
    expect(hasMeaningfulToken({ type: "message_start", message: {} })).toBe(false);
    expect(hasMeaningfulToken({ type: "ping" })).toBe(false);
    expect(hasMeaningfulToken({ type: "content_block_stop" })).toBe(false);
    expect(hasMeaningfulToken({ type: "message_delta", delta: { stop_reason: "end_turn" } })).toBe(
      false,
    );
  });

  // Responses API
  it("Responses: token deltas count; lifecycle/added shells do not", () => {
    expect(hasMeaningfulToken({ type: "response.output_text.delta", delta: "x" })).toBe(true);
    expect(hasMeaningfulToken({ type: "response.output_text.delta", delta: "" })).toBe(false);
    expect(hasMeaningfulToken({ type: "response.reasoning_text.delta", delta: "hm" })).toBe(true);
    expect(
      hasMeaningfulToken({ type: "response.function_call_arguments.delta", delta: "{}" }),
    ).toBe(true);
    expect(
      hasMeaningfulToken({
        type: "response.output_item.added",
        item: { type: "function_call", name: "" },
      }),
    ).toBe(false);
    expect(
      hasMeaningfulToken({
        type: "response.output_item.added",
        item: { type: "function_call", name: "f" },
      }),
    ).toBe(true);
    expect(hasMeaningfulToken({ type: "response.created", response: {} })).toBe(false);
    expect(hasMeaningfulToken({ type: "response.completed", response: {} })).toBe(false);
  });
  it("unwraps the {event,data} formatSSE envelope", () => {
    expect(
      hasMeaningfulToken({
        event: "response.output_text.delta",
        data: { type: "response.output_text.delta", delta: "x" },
      }),
    ).toBe(true);
    expect(
      hasMeaningfulToken({ event: "response.completed", data: { type: "response.completed" } }),
    ).toBe(false);
  });

  // Gemini / Ollama / misc
  it("Gemini parts text and function calls count", () => {
    expect(hasMeaningfulToken({ candidates: [{ content: { parts: [{ text: "x" }] } }] })).toBe(
      true,
    );
    expect(hasMeaningfulToken({ candidates: [{ content: { parts: [{ text: "" }] } }] })).toBe(
      false,
    );
    expect(
      hasMeaningfulToken({
        candidates: [{ content: { parts: [{ functionCall: { name: "f" } }] } }],
      }),
    ).toBe(true);
  });
  it("Ollama message content counts; junk does not", () => {
    expect(hasMeaningfulToken({ message: { content: "x" } })).toBe(true);
    expect(hasMeaningfulToken({ message: { content: "" } })).toBe(false);
    expect(hasMeaningfulToken(null)).toBe(false);
    expect(hasMeaningfulToken("text")).toBe(false);
    expect(hasMeaningfulToken({})).toBe(false);
  });
});
