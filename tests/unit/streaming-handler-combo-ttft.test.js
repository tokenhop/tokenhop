import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";

// Sever the DB import chain (usageDb -> @/lib/db/*) — persistence is not under test.
vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetailUnscoped: vi.fn(async () => {}),
  saveRequestUsageUnscoped: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

// Wall-clock control: firstTokenAt must come from Date.now() at emit time,
// not from real elapsed time — no sleeps.
let now;
let nowSpy;
beforeEach(() => {
  now = 0;
  gate = Promise.resolve();
  release = undefined;
  nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => {
  nowSpy.mockRestore();
});

const encoder = new TextEncoder();
const data = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const roleChunk = data({ id: "c1", choices: [{ index: 0, delta: { role: "assistant" } }] });
const contentChunk = data({ id: "c1", choices: [{ index: 0, delta: { content: "hello" } }] });
const doneLine = "data: [DONE]\n\n";

// One upstream pull per step: sets the clock, then enqueues or errors. Each
// pull after the first waits until the test released the previous one (the
// downstream read loop calls release()), so transform N always runs at step N's
// clock — upstream pulls are otherwise eager and would race ahead of the reads.
let release;
let gate = Promise.resolve();
function timedProviderResponse(steps) {
  return new Response(
    new ReadableStream({
      async pull(controller) {
        await gate;
        const step = steps.shift();
        if (!step) {
          controller.close();
          return;
        }
        now = step.t;
        gate = new Promise((r) => {
          release = r;
        });
        if (step.error) {
          controller.error(step.error);
          return;
        }
        controller.enqueue(encoder.encode(step.text));
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

// Drain the streamed Response chunk by chunk, releasing the upstream clock
// gate after each read so the next timed step can flow.
async function drain(body) {
  const reader = body.getReader();
  for (;;) {
    const { done } = await reader.read();
    release?.();
    if (done) break;
  }
}

const quietLog = { line() {}, errorLine() {} };

function setupAttempt() {
  const settleSpy = vi.fn();
  const comboAttempt = { registerStream: vi.fn(() => settleSpy) };
  const streamController = createStreamController({
    log: quietLog,
    provider: "openai",
    model: "m",
  });
  return { settleSpy, comboAttempt, streamController };
}

function run(providerResponse, { comboAttempt, streamController }) {
  return handleStreamingResponse({
    providerResponse,
    provider: "openai",
    model: "m",
    sourceFormat: FORMATS.OPENAI,
    targetFormat: FORMATS.OPENAI,
    userAgent: "",
    reqLogger: null,
    toolNameMap: null,
    customToolNames: null,
    body: { messages: [], model: "m", stream: true },
    stream: true,
    requestStartTime: 0,
    connectionId: null,
    apiKey: null,
    clientRawRequest: null,
    pxpipe: null,
    reqTag: "TEST",
    log: quietLog,
    streamController,
    onStreamComplete: null,
    streamDetailId: null,
    credentials: null,
    comboAttempt,
  });
}

describe("handleStreamingResponse combo TTFT feedback (YAN-764)", () => {
  it("calls registerStream before the streamed Response is returned", async () => {
    const { settleSpy, comboAttempt, streamController } = setupAttempt();
    const result = await run(timedProviderResponse([]), { comboAttempt, streamController });

    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);
    expect(comboAttempt.registerStream).toHaveBeenCalledOnce();
    // No bytes flowed yet — the attempt must still be unsettled.
    expect(settleSpy).not.toHaveBeenCalled();

    await drain(result.response.body);
  });

  it("settles once at [DONE] with firstTokenAt at the first content chunk, ignoring role-only chunks", async () => {
    const { settleSpy, comboAttempt, streamController } = setupAttempt();
    const result = await run(
      timedProviderResponse([
        { t: 10, text: roleChunk },
        { t: 400, text: contentChunk },
        { t: 900, text: doneLine },
      ]),
      { comboAttempt, streamController },
    );
    await drain(result.response.body);

    expect(settleSpy).toHaveBeenCalledOnce();
    const info = settleSpy.mock.calls[0][0];
    expect(info.firstTokenAt).toBe(400);
    expect(info.error).toBeNull();
    expect(info.cancelled).toBe(false);
  });

  it("settles {cancelled:true} when the client cancels before the terminal", async () => {
    const { settleSpy, comboAttempt, streamController } = setupAttempt();
    // Provider body yields one chunk, then hangs (no terminal, no close).
    const providerResponse = new Response(
      new ReadableStream({
        start(controller) {
          now = 400;
          controller.enqueue(encoder.encode(contentChunk));
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    const result = await run(providerResponse, { comboAttempt, streamController });

    const reader = result.response.body.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    await reader.cancel();

    expect(settleSpy).toHaveBeenCalledOnce();
    expect(settleSpy.mock.calls[0][0]).toEqual({ cancelled: true });
  });

  it("settles with the upstream error when the provider stream fails mid-stream", async () => {
    const { settleSpy, comboAttempt, streamController } = setupAttempt();
    const result = await run(
      timedProviderResponse([
        { t: 400, text: contentChunk },
        { t: 500, error: new Error("upstream boom") },
      ]),
      { comboAttempt, streamController },
    );
    // Terminal error bytes are appended and the stream closes.
    await drain(result.response.body);

    expect(settleSpy).toHaveBeenCalledOnce();
    const info = settleSpy.mock.calls[0][0];
    expect(info.error?.message).toBe("upstream boom");
    expect(info.cancelled).toBeUndefined();
  });

  it("keeps the success settle when the client cancels after the terminal", async () => {
    const { settleSpy, comboAttempt, streamController } = setupAttempt();
    const result = await run(
      timedProviderResponse([
        { t: 400, text: contentChunk },
        { t: 900, text: doneLine },
      ]),
      { comboAttempt, streamController },
    );

    const reader = result.response.body.getReader();
    for (;;) {
      const { done } = await reader.read();
      release?.();
      if (done) break;
    }

    expect(settleSpy).toHaveBeenCalledOnce();
    const info = settleSpy.mock.calls[0][0];
    expect(info.firstTokenAt).toBe(400);
    expect(info.error).toBeNull();
    expect(info.cancelled).toBe(false);

    await reader.cancel(); // stream already closed — settle is once-only
    expect(settleSpy).toHaveBeenCalledOnce();
  });
});
