// YAN-2468: an upstream refusal (e.g. Claude stop_reason "refusal" → OpenAI
// delta.refusal + finish_reason content_filter) is not a served answer for pin
// purposes. An unpinned combo turn skips a refusing member; a pinned turn, or the
// last member, serves the refusal; a refusal never takes the pin.
import { beforeEach, describe, expect, it } from "vitest";

import { handleComboChat, resetComboRotation } from "../../open-sse/services/combo.js";
import { comboPins } from "../../open-sse/services/cacheAffinity.js";
import { probeStreamHead, watchForLateRefusal } from "../../open-sse/utils/streamProbe.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };
const SSE = { "Content-Type": "text/event-stream" };
const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const chunk = (delta, extra = {}) =>
  frame({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta, ...extra }] });
const DONE = "data: [DONE]\n\n";
const REFUSAL_TEXT = "This request was blocked by the provider.";

const REFUSAL_RAW =
  chunk({ role: "assistant" }) +
  chunk({ refusal: REFUSAL_TEXT }, { finish_reason: "content_filter" }) +
  DONE;
const TEXT_RAW = chunk({ role: "assistant" }) + chunk({ content: "hi" }) + DONE;
const refusal = () => new Response(REFUSAL_RAW, { status: 200, headers: SSE });
const text = () => new Response(TEXT_RAW, { status: 200, headers: SSE });

const PIN_KEY = "\nc\nconv1";

async function turn(stubs, extra = {}) {
  const calls = [];
  const fallbacks = [];
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "x" }] },
    models: Object.keys(stubs),
    comboName: "c",
    comboStrategy: "round-robin",
    handleSingleModel: async (_b, m) => {
      calls.push(m);
      return stubs[m]();
    },
    onFallback: async (fb) => fallbacks.push(fb),
    log,
    conversationKey: "conv1",
    cacheAffinity: true,
    ...extra,
  });
  return { res, body: await res.text(), calls, fallbacks };
}

beforeEach(() => {
  resetComboRotation();
  comboPins.clear();
});

describe("probeStreamHead refusal detection", () => {
  it("a refusal before any answer token resolves refused with a byte-exact replay", async () => {
    const probe = await probeStreamHead(refusal());
    expect(probe.outcome).toBe("refused");
    expect(probe.refusal).toBe(REFUSAL_TEXT);
    expect(await probe.response.text()).toBe(REFUSAL_RAW);
  });

  it("a refusal after answer text is a normal release", async () => {
    const raw = chunk({ content: "partial" }) + chunk({ refusal: "no" }) + DONE;
    const probe = await probeStreamHead(new Response(raw, { status: 200, headers: SSE }));
    expect(probe.outcome).toBe("release");
  });

  it("a Claude-format message_delta refusal is detected", async () => {
    const raw =
      frame({ type: "message_start", message: { id: "m", role: "assistant" } }) +
      frame({
        type: "message_delta",
        delta: { stop_reason: "refusal", stop_details: { explanation: REFUSAL_TEXT } },
      });
    const probe = await probeStreamHead(new Response(raw, { status: 200, headers: SSE }));
    expect(probe.outcome).toBe("refused");
    expect(probe.refusal).toBe(REFUSAL_TEXT);
  });
});

describe("combo refusal handling", () => {
  it("issue repro: an unpinned turn skips the refusing member and pins the one that answers", async () => {
    // After a gateway restart the conversation has no pin; the strategy leads
    // with the Claude member, which refuses the other model's transcript.
    const stubs = { "cc/claude-x": refusal, "cx/gpt-x": text, "ag/gemini-x": text };
    const first = await turn(stubs);
    expect(first.res.status).toBe(200);
    expect(first.body).toContain('"content":"hi"');
    expect(first.calls).toEqual(["cc/claude-x", "cx/gpt-x"]);
    expect(first.fallbacks).toEqual([{ model: "cc/claude-x", status: 403 }]);
    expect(comboPins.get(PIN_KEY)).toBe("cx/gpt-x");

    const next = await turn(stubs);
    expect(next.calls).toEqual(["cx/gpt-x"]);
  });

  it("a pinned turn serves the pinned model's refusal and keeps the pin", async () => {
    comboPins.set(PIN_KEY, "p/a");
    const { res, body, calls } = await turn({ "p/a": refusal, "p/b": text });
    expect(res.status).toBe(200);
    expect(body).toContain(REFUSAL_TEXT);
    expect(calls).toEqual(["p/a"]);
    expect(comboPins.get(PIN_KEY)).toBe("p/a");
  });

  it("when every member refuses, the last refusal is served and no pin is written", async () => {
    const { res, body, calls } = await turn({ "p/a": refusal, "p/b": refusal });
    expect(res.status).toBe(200);
    expect(body).toContain(REFUSAL_TEXT);
    expect(calls).toEqual(["p/a", "p/b"]);
    expect(comboPins.get(PIN_KEY)).toBeUndefined();
  });

  it("without a conversation key a refusing member is still skipped", async () => {
    const { body, calls } = await turn({ "p/a": refusal, "p/b": text }, { conversationKey: null });
    expect(body).toContain('"content":"hi"');
    expect(calls).toEqual(["p/a", "p/b"]);
  });

  it("a hedged fastest race whose winner refuses writes no pin", async () => {
    const { res, body } = await turn(
      { "p/a": refusal, "p/b": refusal },
      { comboStrategy: "fastest", hedgeDelayMs: 5 },
    );
    expect(res.status).toBe(200);
    expect(body).toContain(REFUSAL_TEXT);
    expect(comboPins.get(PIN_KEY)).toBeUndefined();
  });

  it("a refusal after reasoning on an unpinned turn still skips the member (review #1221)", async () => {
    const thinkThenRefuse = () =>
      new Response(
        chunk({ role: "assistant" }) +
          chunk({ reasoning_content: "let me think" }) +
          chunk({ refusal: REFUSAL_TEXT }, { finish_reason: "content_filter" }) +
          DONE,
        { status: 200, headers: SSE },
      );
    const { body, calls } = await turn({ "p/a": thinkThenRefuse, "p/b": text });
    expect(body).toContain('"content":"hi"');
    expect(calls).toEqual(["p/a", "p/b"]);
    expect(comboPins.get(PIN_KEY)).toBe("p/b");
  });

  it("a reasoning-only stream on an unpinned turn is still served (YAN-1031)", async () => {
    const thinkOnly = () =>
      new Response(chunk({ reasoning_content: "hmm" }) + DONE, { status: 200, headers: SSE });
    const { body, calls } = await turn({ "p/a": thinkOnly, "p/b": text });
    expect(body).toContain("hmm");
    expect(calls).toEqual(["p/a"]);
  });
});

// Review on #1223: a member that cannot be skipped (last member, hedge winner)
// is released on reasoning; a refusal that follows withdraws the pin it took.
describe("late refusal after reasoning (YAN-2479)", () => {
  const THINK_THEN_REFUSE_RAW =
    chunk({ role: "assistant" }) +
    chunk({ reasoning_content: "let me think" }) +
    chunk({ refusal: REFUSAL_TEXT }, { finish_reason: "content_filter" }) +
    DONE;
  const thinkThenRefuse = () => new Response(THINK_THEN_REFUSE_RAW, { status: 200, headers: SSE });

  it("the last member's late refusal removes the pin once the stream is read", async () => {
    const { body, calls } = await turn({ "p/a": refusal, "p/b": thinkThenRefuse });
    expect(calls).toEqual(["p/a", "p/b"]);
    expect(body).toBe(THINK_THEN_REFUSE_RAW); // served byte-for-byte
    expect(comboPins.get(PIN_KEY)).toBeUndefined();
  });

  it("a pinned turn's late refusal keeps the pin", async () => {
    comboPins.set(PIN_KEY, "p/a");
    const { body } = await turn({ "p/a": thinkThenRefuse, "p/b": text });
    expect(body).toContain(REFUSAL_TEXT);
    expect(comboPins.get(PIN_KEY)).toBe("p/a");
  });

  it("a hedge winner's late refusal removes the pin", async () => {
    const { body } = await turn(
      { "p/a": thinkThenRefuse, "p/b": thinkThenRefuse },
      { comboStrategy: "fastest", hedgeDelayMs: 5 },
    );
    expect(body).toContain(REFUSAL_TEXT);
    expect(comboPins.get(PIN_KEY)).toBeUndefined();
  });

  it("reasoning then an answer keeps the pin", async () => {
    const thinkThenAnswer = () =>
      new Response(chunk({ reasoning_content: "hmm" }) + chunk({ content: "ok" }) + DONE, {
        status: 200,
        headers: SSE,
      });
    await turn({ "p/a": refusal, "p/b": thinkThenAnswer });
    expect(comboPins.get(PIN_KEY)).toBe("p/b");
  });

  it("watchForLateRefusal passes bytes through and reports only a refusal before an answer", async () => {
    const seen = [];
    const out = watchForLateRefusal(thinkThenRefuse(), (r) => seen.push(r));
    expect(await out.text()).toBe(THINK_THEN_REFUSE_RAW);
    expect(seen).toEqual([REFUSAL_TEXT]);

    const after = [];
    const raw = chunk({ content: "ok" }) + chunk({ refusal: "late" }) + DONE;
    const out2 = watchForLateRefusal(new Response(raw, { headers: SSE }), (r) => after.push(r));
    expect(await out2.text()).toBe(raw);
    expect(after).toEqual([]);
  });
});
