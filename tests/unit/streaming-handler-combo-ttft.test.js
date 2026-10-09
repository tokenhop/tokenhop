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

// Upstream body driven explicitly by the test: enqueue/error/close happen only
// after the previous chunk's COMPLETE SSE frame was observed downstream, so
// each transform runs at the test's clock. (A pull-based source is eager, and
// the microtask ordering of its pulls vs the pipe's transforms varies across
// Node versions — the clock could advance before the pending transform ran.)
function controlledProviderResponse() {
  let upstream;
  const body = new ReadableStream({
    start(controller) {
      upstream = controller;
    },
  });
  return {
    upstream,
    response: new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
  };
}

// Read until the accumulated downstream bytes contain `text` — proof the
// matching transform already ran, so it is safe to advance the clock.
async function readUntil(reader, text) {
  const decoder = new TextDecoder();
  let acc = "";
  while (!acc.includes(text)) {
    const { done, value } = await reader.read();
    if (done) {
      throw new Error(`stream ended before ${JSON.stringify(text)}; got ${JSON.stringify(acc)}`);
    }
    acc += decoder.decode(value, { stream: true });
  }
  return acc;
}

async function drain(reader) {
  for (;;) {
    const { done } = await reader.read();
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
    const { upstream, response } = controlledProviderResponse();
    upstream.close();
    const result = await run(response, { comboAttempt, streamController });

    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);
    expect(comboAttempt.registerStream).toHaveBeenCalledOnce();
    // No bytes flowed yet — the attempt must still be unsettled.
    expect(settleSpy).not.toHaveBeenCalled();

    await drain(result.response.body.getReader());
  });

  it("settles once at [DONE] with firstTokenAt at the first content chunk, ignoring role-only chunks", async () => {
    const { settleSpy, comboAttempt, streamController } = setupAttempt();
    const { upstream, response } = controlledProviderResponse();
    const result = await run(response, { comboAttempt, streamController });
    const reader = result.response.body.getReader();

    now = 10;
    upstream.enqueue(encoder.encode(roleChunk));
    await readUntil(reader, "\n\n"); // full role frame observed downstream

    now = 400;
    upstream.enqueue(encoder.encode(contentChunk));
    await readUntil(reader, "\n\n"); // full content frame observed downstream

    now = 900;
    upstream.enqueue(encoder.encode(doneLine));
    upstream.close();
    await drain(reader);

    expect(settleSpy).toHaveBeenCalledOnce();
    const info = settleSpy.mock.calls[0][0];
    expect(info.firstTokenAt).toBe(400);
    expect(info.error).toBeNull();
    expect(info.cancelled).toBe(false);
  });

  it("settles {cancelled:true} when the client cancels before the terminal", async () => {
    const { settleSpy, comboAttempt, streamController } = setupAttempt();
    // Provider body yields one chunk, then hangs (no terminal, no close).
    const { upstream, response } = controlledProviderResponse();
    const result = await run(response, { comboAttempt, streamController });

    const reader = result.response.body.getReader();
    now = 400;
    upstream.enqueue(encoder.encode(contentChunk));
    const first = await reader.read();
    expect(first.done).toBe(false);

    await reader.cancel();

    expect(settleSpy).toHaveBeenCalledOnce();
    expect(settleSpy.mock.calls[0][0]).toEqual({ cancelled: true });
  });

  it("settles with the upstream error when the provider stream fails mid-stream", async () => {
    const { settleSpy, comboAttempt, streamController } = setupAttempt();
    const { upstream, response } = controlledProviderResponse();
    const result = await run(response, { comboAttempt, streamController });
    const reader = result.response.body.getReader();

    now = 400;
    upstream.enqueue(encoder.encode(contentChunk));
    await readUntil(reader, "\n\n");

    now = 500;
    upstream.error(new Error("upstream boom"));
    // Terminal error bytes are appended and the stream closes.
    await drain(reader);

    expect(settleSpy).toHaveBeenCalledOnce();
    const info = settleSpy.mock.calls[0][0];
    expect(info.error?.message).toBe("upstream boom");
    expect(info.cancelled).toBeUndefined();
  });

  it("keeps the success settle when the client cancels after the terminal", async () => {
    const { settleSpy, comboAttempt, streamController } = setupAttempt();
    const { upstream, response } = controlledProviderResponse();
    const result = await run(response, { comboAttempt, streamController });
    const reader = result.response.body.getReader();

    now = 400;
    upstream.enqueue(encoder.encode(contentChunk));
    await readUntil(reader, "\n\n");

    now = 900;
    upstream.enqueue(encoder.encode(doneLine));
    await readUntil(reader, "[DONE]\n\n"); // terminal observed; no EOF required

    expect(settleSpy).toHaveBeenCalledOnce();
    const info = settleSpy.mock.calls[0][0];
    expect(info.firstTokenAt).toBe(400);
    expect(info.error).toBeNull();
    expect(info.cancelled).toBe(false);

    await reader.cancel(); // client closes right after the terminal — settle is once-only
    expect(settleSpy).toHaveBeenCalledOnce();
  });
});
