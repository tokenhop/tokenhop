import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDisconnectAwareStream,
  pipeWithDisconnect,
} from "../../open-sse/utils/streamHandler.js";
import { SSE_KEEPALIVE } from "../../open-sse/utils/sseConstants.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const INTERVAL = 1000;

function makeController() {
  let connected = true;
  const calls = { complete: 0, error: [], disconnect: 0, abort: 0 };
  return {
    calls,
    signal: new AbortController().signal,
    startTime: Date.now(),
    isConnected: () => connected,
    handleComplete: () => {
      calls.complete++;
      connected = false;
    },
    handleError: (e) => {
      calls.error.push(e);
      connected = false;
    },
    handleDisconnect: () => {
      calls.disconnect++;
      connected = false;
    },
    abort: () => {
      calls.abort++;
      connected = false;
    },
  };
}

// Upstream readable whose controller the test drives by hand.
function manualUpstream() {
  let ctrl;
  const readable = new ReadableStream({
    start(c) {
      ctrl = c;
    },
  });
  return {
    readable,
    push: (text) => ctrl.enqueue(enc.encode(text)),
    end: () => ctrl.close(),
  };
}

const wrap = (readable) => ({
  readable,
  writable: { getWriter: () => ({ abort: () => Promise.resolve() }) },
});

// Drain everything the client can read so far into `out` (non-blocking).
function collector(stream) {
  const reader = stream.getReader();
  const out = [];
  let done = false;
  (async () => {
    while (true) {
      const r = await reader.read();
      if (r.done) {
        done = true;
        return;
      }
      out.push(dec.decode(r.value));
    }
  })().catch(() => {
    done = true;
  });
  return { reader, out, isDone: () => done };
}

const keepalives = (out) => out.filter((c) => c === SSE_KEEPALIVE).length;

describe("SSE keepalive (createDisconnectAwareStream)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits a keepalive comment after silence, including before the first chunk", async () => {
    const up = manualUpstream();
    const stream = createDisconnectAwareStream(wrap(up.readable), makeController(), null, {
      keepaliveIntervalMs: INTERVAL,
    });
    const c = collector(stream);

    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(c.out).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.out).toEqual([SSE_KEEPALIVE]);

    // Keeps firing while the silence lasts.
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(keepalives(c.out)).toBe(3);

    up.push('data: {"a":1}\n\n');
    up.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.out.at(-1)).toBe('data: {"a":1}\n\n');
    expect(c.isDone()).toBe(true);
  });

  it("does not emit while chunks keep flowing", async () => {
    const up = manualUpstream();
    const stream = createDisconnectAwareStream(wrap(up.readable), makeController(), null, {
      keepaliveIntervalMs: INTERVAL,
    });
    const c = collector(stream);

    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(INTERVAL / 2);
      up.push(`data: ${i}\n\n`);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(keepalives(c.out)).toBe(0);
    expect(c.out).toHaveLength(10);

    // Silence after the last chunk: the timer was reset by it.
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(keepalives(c.out)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(keepalives(c.out)).toBe(1);
  });

  it("never writes a keepalive inside a partially written event", async () => {
    const up = manualUpstream();
    const stream = createDisconnectAwareStream(wrap(up.readable), makeController(), null, {
      keepaliveIntervalMs: INTERVAL,
    });
    const c = collector(stream);

    up.push("event: message\n");
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(keepalives(c.out)).toBe(0);

    up.push("data: {}\n");
    up.push("\n"); // event now complete
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(keepalives(c.out)).toBe(1);
    expect(c.out.join("")).toBe(`event: message\ndata: {}\n\n${SSE_KEEPALIVE}`);
  });

  it("stops after the stream ends (no timers left, no write after close)", async () => {
    const up = manualUpstream();
    const ctrl = makeController();
    const stream = createDisconnectAwareStream(wrap(up.readable), ctrl, null, {
      keepaliveIntervalMs: INTERVAL,
    });
    const c = collector(stream);

    up.push("data: x\n\n");
    up.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.isDone()).toBe(true);
    expect(ctrl.calls.complete).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(keepalives(c.out)).toBe(0);
  });

  it("stops after an upstream error", async () => {
    let upCtrl;
    const readable = new ReadableStream({
      start(c) {
        upCtrl = c;
      },
    });
    const stream = createDisconnectAwareStream(wrap(readable), makeController(), null, {
      keepaliveIntervalMs: INTERVAL,
    });
    const c = collector(stream);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(keepalives(c.out)).toBe(1);

    upCtrl.error(new Error("socket hang up"));
    await vi.advanceTimersByTimeAsync(0);
    expect(c.isDone()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops after a client abort (cancel)", async () => {
    const up = manualUpstream();
    const ctrl = makeController();
    const stream = createDisconnectAwareStream(wrap(up.readable), ctrl, null, {
      keepaliveIntervalMs: INTERVAL,
    });
    const c = collector(stream);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(keepalives(c.out)).toBe(1);

    await c.reader.cancel("client_closed");
    expect(ctrl.calls.disconnect).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(keepalives(c.out)).toBe(1);
  });

  it("stops once the controller reports a disconnect (e.g. hedge cancel)", async () => {
    const up = manualUpstream();
    const ctrl = makeController();
    const stream = createDisconnectAwareStream(wrap(up.readable), ctrl, null, {
      keepaliveIntervalMs: INTERVAL,
    });
    const c = collector(stream);
    ctrl.handleDisconnect();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(keepalives(c.out)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is disabled at 0 (and by default)", async () => {
    for (const opts of [{ keepaliveIntervalMs: 0 }, undefined]) {
      const up = manualUpstream();
      const stream = createDisconnectAwareStream(wrap(up.readable), makeController(), null, opts);
      const c = collector(stream);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(INTERVAL * 10);
      expect(c.out).toEqual([]);
      await c.reader.cancel();
    }
  });
});

describe("SSE keepalive (pipeWithDisconnect)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps keepalives out of the transform and the stall watchdog", async () => {
    const up = manualUpstream();
    const seenByTransform = [];
    const transform = new TransformStream({
      transform(chunk, controller) {
        seenByTransform.push(dec.decode(chunk));
        controller.enqueue(chunk);
      },
    });
    const ctrl = makeController();
    const stallMs = INTERVAL * 5;
    const stream = pipeWithDisconnect(
      new Response(up.readable),
      transform,
      ctrl,
      null,
      stallMs,
      INTERVAL,
    );
    const c = collector(stream);

    // Keepalives flow to the client during upstream silence...
    await vi.advanceTimersByTimeAsync(stallMs - 1);
    expect(keepalives(c.out)).toBe(4);
    expect(seenByTransform).toEqual([]);
    expect(ctrl.calls.error).toHaveLength(0);

    // ...but do not count as upstream activity: the stall timeout still fires.
    await vi.advanceTimersByTimeAsync(1);
    expect(ctrl.calls.error.map((e) => e.message)).toEqual(["stream stall timeout"]);
    expect(ctrl.calls.abort).toBe(1);

    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(keepalives(c.out)).toBe(4);
    await c.reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("STREAM_KEEPALIVE_INTERVAL_MS", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const load = async () =>
    (await import("../../open-sse/config/runtimeConfig.js")).STREAM_KEEPALIVE_INTERVAL_MS;

  it.each([
    [undefined, 15000],
    ["", 15000],
    ["0", 0],
    ["5000", 5000],
    ["-1", 15000],
    ["abc", 15000],
  ])("env %j → %d", async (raw, expected) => {
    vi.resetModules();
    if (raw !== undefined) vi.stubEnv("STREAM_KEEPALIVE_INTERVAL_MS", raw);
    expect(await load()).toBe(expected);
  });
});
