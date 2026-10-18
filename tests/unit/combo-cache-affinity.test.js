// YAN-1211: conversation cache affinity for combo members (Lane B).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleComboChat,
  recordComboLatency,
  resetComboRotation,
} from "../../open-sse/services/combo.js";
import { comboPins } from "../../open-sse/services/cacheAffinity.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = () => new Response("{}", { status: 200 });
const fail = (status = 500) =>
  new Response(JSON.stringify({ error: { message: "boom" } }), { status });

// Fake member handler: records calls; `failing` is a live Set of models that 500.
function makeHandler(failing = new Set(), calls = []) {
  const handle = async (_body, model) => {
    calls.push(model);
    return failing.has(model) ? fail() : ok();
  };
  return { handle, calls, failing };
}

// Resolves with the member that served (first non-failing call of the turn).
async function turn(handle, extra = {}) {
  const served = [];
  const wrapped = async (body, model, ...rest) => {
    const res = await handle(body, model, ...rest);
    if (res.ok) served.push(model);
    return res;
  };
  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "x" }] },
    models: ["p/a", "p/b", "p/c"],
    comboName: "c",
    comboStrategy: "round-robin",
    handleSingleModel: wrapped,
    log,
    conversationKey: "conv1",
    cacheAffinity: true,
    ...extra,
  });
  expect(res.status).toBe(200);
  return served[0];
}

beforeEach(() => {
  resetComboRotation();
  comboPins.clear();
});

describe("pin precedence", () => {
  it.each([
    ["round-robin", {}],
    ["weighted", { comboWeights: { "p/a": 1, "p/b": 1 }, models: ["p/a", "p/b"] }],
    ["fastest", {}],
  ])("%s: 6 turns of one conversation stay on the first member", async (strategy, extra) => {
    const { handle } = makeHandler();
    const served = [];
    for (let i = 0; i < 6; i++) {
      served.push(await turn(handle, { comboStrategy: strategy, ...extra }));
    }
    expect(new Set(served).size).toBe(1);
  });
});

describe("isolation", () => {
  it("different conversations land on different members; pins are stable", async () => {
    const { handle } = makeHandler();
    const first = await turn(handle, { conversationKey: "conv1" });
    const second = await turn(handle, { conversationKey: "conv2" });
    expect(second).not.toBe(first);
    expect(await turn(handle, { conversationKey: "conv1" })).toBe(first);
    expect(await turn(handle, { conversationKey: "conv2" })).toBe(second);
  });

  it("the same conversationKey under different combo names pins independently", async () => {
    const { handle, failing } = makeHandler();
    expect(await turn(handle, { comboName: "ws1:c" })).toBe("p/a");
    expect(await turn(handle, { comboName: "ws2:c" })).toBe("p/a");
    failing.add("p/a");
    expect(await turn(handle, { comboName: "ws1:c" })).toBe("p/b"); // ws1 re-pins
    failing.clear();
    expect(await turn(handle, { comboName: "ws1:c" })).toBe("p/b");
    expect(await turn(handle, { comboName: "ws2:c" })).toBe("p/a"); // ws2 untouched
  });
});

describe("re-pin on failure", () => {
  it("serves from the next member and keeps the new pin after recovery", async () => {
    const { handle, failing } = makeHandler();
    expect(await turn(handle)).toBe("p/a");
    failing.add("p/a");
    expect(await turn(handle)).toBe("p/b");
    failing.clear();
    expect(await turn(handle)).toBe("p/b");
    expect(await turn(handle)).toBe("p/b");
  });

  it("an all-failed turn does not move the pin", async () => {
    const { handle, failing } = makeHandler();
    await turn(handle);
    for (const m of ["p/a", "p/b", "p/c"]) failing.add(m);
    const res = await handleComboChat({
      body: { messages: [] },
      models: ["p/a", "p/b", "p/c"],
      comboName: "c",
      comboStrategy: "round-robin",
      handleSingleModel: handle,
      log,
      conversationKey: "conv1",
      cacheAffinity: true,
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
    failing.clear();
    expect(await turn(handle)).toBe("p/a");
  });
});

describe("no state advance", () => {
  it("rotation advances once per conversation, not per turn", async () => {
    const { handle } = makeHandler();
    for (let i = 0; i < 5; i++) await turn(handle, { conversationKey: "conv1" });
    // conv1 consumed rotation slot 0 (p/a); the next new conversation gets p/b.
    expect(await turn(handle, { conversationKey: "conv2" })).toBe("p/b");
  });
});

describe("fastest", () => {
  it("keeps the pinned member first even when another is the latency leader", async () => {
    const { handle, calls } = makeHandler();
    const opts = { comboStrategy: "fastest", hedgeDelayMs: 0 };
    expect(await turn(handle, opts)).toBe("p/a");
    for (let i = 0; i < 5; i++) {
      recordComboLatency("c", "p/a", 5000);
      recordComboLatency("c", "p/b", 10);
      recordComboLatency("c", "p/c", 10);
    }
    calls.length = 0;
    expect(await turn(handle, opts)).toBe("p/a");
    expect(calls).toEqual(["p/a"]);
  });

  it("does not hedge when pinned (single member called)", async () => {
    const calls = [];
    const slow = async (_b, model) => {
      calls.push(model);
      await sleep(80);
      return ok();
    };
    const opts = { comboStrategy: "fastest", hedgeDelayMs: 30 };
    comboPins.set("c\nconv1", "p/a");
    expect(await turn(slow, opts)).toBe("p/a");
    expect(calls).toEqual(["p/a"]);
  });

  it("unpinned hedged turn pins the winner", async () => {
    const calls = [];
    const handler = async (_b, model, ..._r) => {
      calls.push(model);
      await sleep(model === "p/a" ? 200 : 5);
      return ok();
    };
    const opts = { comboStrategy: "fastest", hedgeDelayMs: 30 };
    expect(await turn(handler, opts)).toBe("p/b");
    expect(comboPins.get("c\nconv1")).toBe("p/b");
    calls.length = 0;
    await turn(handler, opts);
    expect(calls).toEqual(["p/b"]);
  });
});

describe("weighted drain", () => {
  it("ignores a pin whose weight dropped to 0 and re-pins to the served member", async () => {
    const { handle } = makeHandler();
    const base = { comboStrategy: "weighted", models: ["p/a", "p/b"] };
    comboPins.set("c\nconv1", "p/a");
    expect(await turn(handle, { ...base, comboWeights: { "p/a": 1, "p/b": 1 } })).toBe("p/a");
    const served = await turn(handle, { ...base, comboWeights: { "p/a": 0, "p/b": 1 } });
    expect(served).toBe("p/b");
    expect(comboPins.get("c\nconv1")).toBe("p/b");
  });
});

describe("off switches", () => {
  const heads = async (handle, extra) => {
    const out = [];
    for (let i = 0; i < 4; i++) out.push(await turn(handle, extra));
    return out;
  };

  it.each([
    ["cacheAffinity false", { cacheAffinity: false }],
    ["conversationKey null", { conversationKey: null }],
    ["onAttempt set (probe)", { onAttempt: () => {} }],
  ])("%s: round-robin alternates and writes no pin", async (_n, extra) => {
    const { handle } = makeHandler();
    const out = await heads(handle, { models: ["p/a", "p/b"], ...extra });
    expect(out).toEqual(["p/a", "p/b", "p/a", "p/b"]);
    expect(comboPins.size).toBe(0);
  });

  it("fallback strategy: order unchanged, no pin written", async () => {
    const { handle } = makeHandler();
    const out = await heads(handle, { comboStrategy: "fallback" });
    expect(out).toEqual(["p/a", "p/a", "p/a", "p/a"]);
    expect(comboPins.size).toBe(0);
  });
});

describe("pin validity", () => {
  it("ignores a pin that is no longer a combo member", async () => {
    const { handle } = makeHandler();
    comboPins.set("c\nconv1", "p/gone");
    expect(await turn(handle)).toBe("p/a");
    expect(comboPins.get("c\nconv1")).toBe("p/a");
  });
});

describe("TTL expiry", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("drops the pin after the sliding TTL and resumes the strategy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.resetModules();
    // Fresh modules so the pin store captures the fake Date.now.
    const combo = await import("../../open-sse/services/combo.js");
    const { comboPins: pins } = await import("../../open-sse/services/cacheAffinity.js");
    const { CACHE_AFFINITY_TTL_MS } = await import("../../open-sse/config/runtimeConfig.js");
    combo.resetComboRotation();
    const { handle } = makeHandler();
    const t = (key) =>
      combo.handleComboChat({
        body: { messages: [] },
        models: ["p/a", "p/b"],
        comboName: "c",
        comboStrategy: "round-robin",
        handleSingleModel: handle,
        log,
        conversationKey: key,
        cacheAffinity: true,
      });
    await t("conv1"); // pins p/a, rotation -> p/b
    expect(pins.get("c\nconv1")).toBe("p/a");
    vi.setSystemTime(Date.now() + CACHE_AFFINITY_TTL_MS + 1);
    expect(pins.get("c\nconv1")).toBeUndefined();
    await t("conv1"); // strategy resumes: rotation head is p/b
    expect(pins.get("c\nconv1")).toBe("p/b");
  });
});

describe("resetComboRotation", () => {
  it("clears that combo's pins only", async () => {
    const { handle } = makeHandler();
    await turn(handle, { comboName: "c" });
    await turn(handle, { comboName: "c2" });
    resetComboRotation("c");
    expect(comboPins.get("c\nconv1")).toBeUndefined();
    expect(comboPins.get("c2\nconv1")).toBe("p/a");
    resetComboRotation();
    expect(comboPins.size).toBe(0);
  });
});
