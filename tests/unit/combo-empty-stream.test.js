// YAN-1023: combo skips 2xx members whose SSE stream carries no meaningful
// token (role-only / usage-only / finish_reason / [DONE], or an in-stream
// error before any token) and falls through to the next member.
import { describe, it, expect, beforeEach, vi } from "vitest";

import { handleComboChat, resetComboRotation } from "../../open-sse/services/combo.js";
import { probeStreamHead } from "../../open-sse/utils/streamProbe.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };
const SSE = { "Content-Type": "text/event-stream" };
const NDJSON = { "Content-Type": "application/x-ndjson" };

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const chunk = (id, delta, extra = {}) =>
  frame({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta, ...extra }] });
const DONE = "data: [DONE]\n\n";

function stream(body, headers = SSE, status = 200) {
  return new Response(body, { status, headers });
}

const EMPTY_STREAM = stream(chunk("a", { role: "assistant" }) + chunk("a", {}) + DONE);
const TEXT_STREAM_RAW = chunk("b", { role: "assistant" }) + chunk("b", { content: "hi" }) + DONE;
const TEXT_STREAM = stream(TEXT_STREAM_RAW);

async function runCombo(stubs, extra = {}) {
  const fallbackCalls = [];
  const attempts = [];
  const res = await handleComboChat({
    body: {},
    models: Object.keys(stubs),
    comboName: `ce-${Math.random().toString(36).slice(2)}`,
    handleSingleModel: async (_b, m) => stubs[m](),
    onFallback: async (fb) => fallbackCalls.push(fb),
    onAttempt: (a) => attempts.push(a),
    log,
    ...extra,
  });
  return { res, fallbackCalls, attempts };
}

describe("combo empty-stream fallback", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("issue repro: empty SSE member falls through to the next member", async () => {
    const { res, fallbackCalls, attempts } = await runCombo({
      "p/a": () => EMPTY_STREAM.clone(),
      "p/b": () => TEXT_STREAM.clone(),
    });
    expect(res.ok).toBe(true);
    expect(await res.text()).toContain('"content":"hi"');
    expect(fallbackCalls).toEqual([{ model: "p/a", status: 502 }]);
    expect(attempts[0]).toMatchObject({
      model: "p/a",
      errorType: "empty-stream",
      outcome: "skipped",
    });
    expect(attempts.at(-1)).toMatchObject({ model: "p/b", outcome: "served" });
  });

  it.each([
    ["role-only", () => stream(chunk("a", { role: "assistant" }) + DONE)],
    ["usage-only", () => stream(frame({ choices: [], usage: { completion_tokens: 5 } }) + DONE)],
    ["finish-only, no [DONE]", () => stream(chunk("a", {}, { finish_reason: "stop" }))],
  ])("%s member falls through", async (_label, first) => {
    const { res, fallbackCalls } = await runCombo({
      "p/a": first,
      "p/b": () => TEXT_STREAM.clone(),
    });
    expect(res.ok).toBe(true);
    expect(await res.text()).toContain('"content":"hi"');
    expect(fallbackCalls).toEqual([{ model: "p/a", status: 502 }]);
  });

  it.each([
    [
      "reasoning-only",
      stream(
        chunk("a", { role: "assistant" }) + chunk("a", { reasoning_content: "thinking" }) + DONE,
      ),
    ],
    [
      "tool-call-only",
      stream(
        chunk("a", { role: "assistant" }) +
          chunk("a", {
            tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather" } }],
          }) +
          DONE,
      ),
    ],
  ])("%s member is served, not skipped", async (_label, first) => {
    const { res, fallbackCalls } = await runCombo({ "p/a": () => first });
    expect(res.ok).toBe(true);
    expect(fallbackCalls).toEqual([]);
  });

  it("in-stream error before any token falls through with stream-error", async () => {
    const { res, fallbackCalls, attempts } = await runCombo({
      "p/a": () => stream(frame({ error: { message: "upstream boom" } })),
      "p/b": () => TEXT_STREAM.clone(),
    });
    expect(res.ok).toBe(true);
    expect(fallbackCalls).toEqual([{ model: "p/a", status: 502 }]);
    expect(attempts[0]).toMatchObject({
      model: "p/a",
      errorType: "stream-error",
      outcome: "skipped",
    });
  });

  it("stream dropped before any token falls through", async () => {
    const dropped = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(chunk("a", { role: "assistant" })));
          c.error(new Error("socket reset"));
        },
      }),
      { status: 200, headers: SSE },
    );
    const { res, fallbackCalls } = await runCombo({
      "p/a": () => dropped,
      "p/b": () => TEXT_STREAM.clone(),
    });
    expect(res.ok).toBe(true);
    expect(fallbackCalls).toEqual([{ model: "p/a", status: 502 }]);
  });

  it("healthy stream body is byte-identical after probing", async () => {
    const raw = chunk("b", { role: "assistant" }) + chunk("b", { content: "hello" }) + DONE;
    const { res } = await runCombo({ "p/a": () => stream(raw) });
    expect(await res.text()).toBe(raw);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });

  it("HTTP 429 member still falls back (existing behavior)", async () => {
    const err = () =>
      new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    const { res } = await runCombo({ "p/a": err, "p/b": () => TEXT_STREAM.clone() });
    expect(res.ok).toBe(true);
  });

  it("JSON 200 is returned unprobed", async () => {
    const json = () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const { res, fallbackCalls } = await runCombo({ "p/a": json });
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ ok: true });
    expect(fallbackCalls).toEqual([]);
  });

  it("CRLF + split chunks + multiline data event classify correctly", async () => {
    const enc = new TextEncoder();
    const part1 = enc.encode('data: {"id":"a","choices":[{"index":0,"delta":{"role"');
    const part2 = enc.encode(':"assistant"}}]}\r\n\r\ndata: {"id"');
    const part3 = enc.encode(
      ':"a","choices":[{"index":0,"delta":{"content":"yo"}}]}\r\n\r\ndata: [DONE]\r\n\r\n',
    );
    const split = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(part1);
          c.enqueue(part2);
          c.enqueue(part3);
          c.close();
        },
      }),
      { status: 200, headers: SSE },
    );
    expect((await probeStreamHead(split)).outcome).toBe("release");

    // Multi-line data joins into one JSON event (an unparseable join would fail open).
    const multi = stream(`data: {"choices":[{"delta":\ndata: {}}]}\n\n${DONE}`);
    expect((await probeStreamHead(multi)).outcome).toBe("empty");
    const multiText = stream(`data: {"choices":[{"delta":\ndata: {"content":"x"}}]}\n\n`);
    expect((await probeStreamHead(multiText)).outcome).toBe("release");
  });

  it("byte cap releases fail-open with byte-exact replay", async () => {
    const enc = new TextEncoder();
    const head = chunk("a", { role: "assistant" });
    const tail = chunk("a", { content: "late" }) + DONE;
    let ctl;
    const live = new Response(
      new ReadableStream({
        start(c) {
          ctl = c;
          c.enqueue(enc.encode(head));
        },
      }),
      { status: 200, headers: SSE },
    );
    const out = await probeStreamHead(live, { maxBytes: 10, maxMs: 5000 });
    expect(out.outcome).toBe("release");
    ctl.enqueue(enc.encode(tail));
    ctl.close();
    expect(await out.response.text()).toBe(head + tail);
  });

  it("time cap releases fail-open without losing the pending chunk", async () => {
    let ctl;
    const hanging = new Response(
      new ReadableStream({
        start(c) {
          ctl = c;
        },
      }),
      { status: 200, headers: SSE },
    );
    const out = await probeStreamHead(hanging, { maxBytes: 262144, maxMs: 20 });
    expect(out.outcome).toBe("release");
    ctl.enqueue(new TextEncoder().encode(DONE));
    ctl.close();
    expect(await out.response.text()).toBe(DONE);
  });

  it("unframed body under an SSE label fails open", async () => {
    const raw = JSON.stringify({ choices: [{ message: { content: "ok" } }] });
    const out = await probeStreamHead(stream(raw));
    expect(out.outcome).toBe("release");
    expect(await out.response.text()).toBe(raw);
  });

  it("healthy ndjson stream is released", async () => {
    const nd = stream('{"message":{"role":"assistant","content":"yo"}}\n', NDJSON);
    const out = await probeStreamHead(nd);
    expect(out.outcome).toBe("release");
    expect(await out.response.text()).toContain("yo");
  });

  it("empty ndjson stream falls back", async () => {
    const { res, fallbackCalls } = await runCombo({
      "p/a": () => stream("{}\n", NDJSON),
      "p/b": () => TEXT_STREAM.clone(),
    });
    expect(res.ok).toBe(true);
    expect(fallbackCalls).toEqual([{ model: "p/a", status: 502 }]);
  });

  it("all members empty → 502 with 'empty streaming response'", async () => {
    const { res } = await runCombo({ "p/a": () => EMPTY_STREAM.clone() });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { message: "empty streaming response" },
    });
  });
});

describe("empty-stream probe modalities", () => {
  it.each([
    ["audio", { choices: [{ index: 0, delta: { audio: { data: "UklG" } } }] }],
    ["refusal", { choices: [{ index: 0, delta: { refusal: "no" } }] }],
    [
      "gemini inline image",
      { candidates: [{ content: { parts: [{ inlineData: { data: "iVBO" } }] } }] },
    ],
    ["responses audio", { type: "response.audio.delta", delta: "UklG" }],
  ])("%s output is served", async (_l, frameObj) => {
    const out = await probeStreamHead(stream(frame(frameObj) + DONE));
    expect(out.outcome).toBe("release");
  });
});

describe("nested combo empty-stream sampling", () => {
  it("a probed-and-skipped member never settles the ancestor attempt", async () => {
    const parentSettle = vi.fn();
    const parentAttempt = { registerStream: vi.fn(() => parentSettle) };
    const res = await handleComboChat({
      body: {},
      models: ["p/a", "p/b"],
      comboName: "nested-empty",
      parentAttempt,
      log,
      handleSingleModel: async (_b, m, attempt) => {
        const settle = attempt.registerStream();
        const raw = m === "p/a" ? chunk("a", { role: "assistant" }) + DONE : TEXT_STREAM_RAW;
        let sent = false;
        const body = new ReadableStream({
          pull(c) {
            if (sent) {
              // Model the transform settling at the terminal frame, while read.
              settle({ firstTokenAt: m === "p/a" ? null : Date.now() });
              c.close();
              return;
            }
            sent = true;
            c.enqueue(new TextEncoder().encode(raw));
          },
        });
        return new Response(body, { status: 200, headers: SSE });
      },
    });
    await res.text();
    // Skipped member a never samples; served member b samples exactly once.
    expect(parentSettle).toHaveBeenCalledTimes(1);
    expect(parentSettle.mock.calls[0][0].firstTokenAt).not.toBeNull();
  });
});
