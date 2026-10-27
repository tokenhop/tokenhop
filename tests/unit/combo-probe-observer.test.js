import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  handleComboChat,
  getRotatedModels,
  getWeightedModels,
  handleFusionChat,
  resetComboRotation,
} from "../../open-sse/services/combo.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };

function okResponse(content = "ok") {
  const json = { choices: [{ message: { role: "assistant", content } }] };
  const make = () => ({ ok: true, status: 200, clone: make, json: async () => json });
  return make();
}

function errResponse(status, message = "boom") {
  const make = () => ({
    ok: false,
    status,
    headers: { get: () => null },
    statusText: message,
    clone: make,
    json: async () => ({ error: { message } }),
  });
  return make();
}

const body = { messages: [{ role: "user", content: "hi" }] };

beforeEach(() => {
  resetComboRotation();
});

describe("combo attempt observer (YAN-299 probe hook)", () => {
  it("records each attempt on a 429 -> 200 fallback chain with zero routing change", async () => {
    const calls = [];
    const handleSingleModel = vi.fn(async (b, m) => {
      calls.push(m);
      return m === "p/bad" ? errResponse(429, "rate limited") : okResponse("served");
    });
    const attempts = [];
    const res = await handleComboChat({
      body,
      models: ["p/bad", "p/good"],
      handleSingleModel,
      log,
      comboName: "probe-fallback",
      onAttempt: (a) => attempts.push(a),
    });

    expect(res.ok).toBe(true);
    expect(calls).toEqual(["p/bad", "p/good"]);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ model: "p/bad", status: 429, outcome: "skipped" });
    expect(attempts[0].errorType).toBe("rate limited");
    expect(attempts[0].latencyMs).toEqual(expect.any(Number));
    expect(attempts[1]).toMatchObject({ model: "p/good", status: 200, outcome: "served" });
  });

  it("marks the terminal step failed when the error is not fallback-eligible", async () => {
    const attempts = [];
    const res = await handleComboChat({
      body,
      models: ["p/bad"],
      handleSingleModel: async () => errResponse(400, "bad request body"),
      log,
      comboName: "probe-nofallback",
      onAttempt: (a) => attempts.push(a),
    });
    expect(res.ok).toBe(false);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].outcome).toBe("failed");
  });

  it("records an exception step and keeps falling through", async () => {
    const attempts = [];
    const handleSingleModel = vi.fn(async (b, m) => {
      if (m === "p/throw") throw new Error("kaboom");
      return okResponse("served");
    });
    const res = await handleComboChat({
      body,
      models: ["p/throw", "p/good"],
      handleSingleModel,
      log,
      comboName: "probe-throw",
      onAttempt: (a) => attempts.push(a),
    });
    expect(res.ok).toBe(true);
    expect(attempts[0]).toMatchObject({ model: "p/throw", status: null, outcome: "skipped" });
    expect(attempts[0].errorType).toBe("exception");
  });

  it("fail-open: a throwing observer never breaks routing", async () => {
    const res = await handleComboChat({
      body,
      models: ["p/good"],
      handleSingleModel: async () => okResponse("served"),
      log,
      comboName: "probe-observer-throw",
      onAttempt: () => {
        throw new Error("observer blew up");
      },
    });
    expect(res.ok).toBe(true);
  });

  it("no observer: normal /v1 traffic is unaffected (regression)", async () => {
    const calls = [];
    const res = await handleComboChat({
      body,
      models: ["p/bad", "p/good"],
      handleSingleModel: async (b, m) => {
        calls.push(m);
        return m === "p/bad" ? errResponse(429, "rate limited") : okResponse("served");
      },
      log,
      comboName: "probe-noobserver",
    });
    expect(res.ok).toBe(true);
    expect(calls).toEqual(["p/bad", "p/good"]);
  });

  it("round-robin next pick is recorded as the first attempt", async () => {
    const models = ["p/a", "p/b"];
    getRotatedModels(models, "probe-rr", "round-robin"); // consume a → next is b
    const attempts = [];
    await handleComboChat({
      body,
      models,
      handleSingleModel: async (b, m) => okResponse(m),
      log,
      comboName: "probe-rr",
      comboStrategy: "round-robin",
      onAttempt: (a) => attempts.push(a),
    });
    expect(attempts[0].model).toBe("p/b");
  });

  it("weighted pick is recorded as the first attempt", async () => {
    const models = ["p/a", "p/b"];
    const first = getWeightedModels(models, "probe-w", { "p/b": 100, "p/a": 1 }, undefined, 1)[0];
    resetComboRotation("probe-w");
    const attempts = [];
    // Re-run selection inside handleComboChat via the same state is sticky;
    // just assert the recorded attempt matches the deterministic weighted head.
    await handleComboChat({
      body,
      models,
      handleSingleModel: async (b, m) => okResponse(m),
      log,
      comboName: "probe-w",
      comboStrategy: "weighted",
      comboWeights: { "p/b": 100, "p/a": 1 },
      onAttempt: (a) => attempts.push(a),
    });
    expect(first).toBe("p/b");
    expect(attempts[0].model).toBe(first);
  });

  it("fusion panel + judge outcomes are visible through the leaf observer", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (b, m) => {
      seen.push(m);
      if (m === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${m}`);
    });
    const res = await handleFusionChat({
      body,
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      comboName: "probe-fusion",
      judgeModel: "p/judge",
    });
    expect(res.ok).toBe(true);
    expect(seen.slice(0, 2).sort()).toEqual(["p/a", "p/b"]);
    expect(seen[2]).toBe("p/judge");
  });

  // YAN-1030: a rejected empty judge is "skipped/empty"; the fallback is its own role.
  it("empty judge is skipped (empty) and the fallback call is reported as role fallback", async () => {
    const attempts = [];
    const emptyJson = () => {
      const json = { choices: [{ message: { role: "assistant", content: "" } }] };
      const make = () => ({ ok: true, status: 200, body: {}, clone: make, json: async () => json });
      return make();
    };
    const handleSingleModel = async (_b, m, isPanel) => {
      if (isPanel) return okResponse(`ans-${m}`);
      return m === "p/judge" ? emptyJson() : okResponse("FALLBACK");
    };
    const res = await handleFusionChat({
      body,
      models: ["p/a", "p/b"],
      handleSingleModel,
      log,
      comboName: "probe-fusion-empty",
      judgeModel: "p/judge",
      onAttempt: (a) => attempts.push(a),
    });
    expect(res.ok).toBe(true);
    const judge = attempts.find((a) => a.role === "judge");
    expect(judge).toMatchObject({ model: "p/judge", outcome: "skipped", errorType: "empty" });
    const fb = attempts.find((a) => a.role === "fallback");
    expect(fb).toMatchObject({ model: "p/a", outcome: "served", errorType: null });
    expect(attempts.filter((a) => a.outcome === "served")).toHaveLength(1);
  });

  it("all-fail surfaces 503 with every attempt recorded", async () => {
    const attempts = [];
    const res = await handleComboChat({
      body,
      models: ["p/a", "p/b"],
      handleSingleModel: async () => errResponse(503, "overloaded"),
      log,
      comboName: "probe-allfail",
      onAttempt: (a) => attempts.push(a),
    });
    expect(res.status).toBe(503);
    expect(attempts).toHaveLength(2);
    expect(attempts.every((a) => a.outcome === "skipped")).toBe(true);
  });

  // YAN-1030: if the emptiness check itself throws, the observer still hears about it.
  it("reports the judge as skipped/exception when the answer check throws", async () => {
    const attempts = [];
    const lockedStream = () => {
      const res = new Response(new ReadableStream({ start() {} }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
      res.body.getReader(); // lock the body: probeStreamHead's getReader() throws
      return res;
    };
    await expect(
      handleFusionChat({
        body,
        models: ["p/a", "p/b"],
        handleSingleModel: async (_b, m, isPanel) =>
          isPanel ? okResponse(`ans-${m}`) : lockedStream(),
        log,
        comboName: "probe-check-throws",
        judgeModel: "p/judge",
        onAttempt: (a) => attempts.push(a),
      }),
    ).rejects.toThrow();
    expect(attempts.find((a) => a.role === "judge")).toMatchObject({
      model: "p/judge",
      outcome: "skipped",
      errorType: "exception",
    });
  });
});
