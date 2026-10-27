// YAN-1211: conversation cache affinity for combo members (Lane B).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleFusionChat,
  handleComboChat,
  recordComboLatency,
  resetComboRotation,
} from "../../open-sse/services/combo.js";
import { comboRotationKey } from "../../src/lib/comboKeys.js";
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

describe("capacity-adapter members", () => {
  it("an adapter-added member serving a turn never moves the pin", async () => {
    const { handle, failing } = makeHandler();
    const extra = { models: ["p/a", "p/b", "p/x"], pinExclude: ["p/x"] };
    expect(await turn(handle, extra)).toBe("p/a");
    failing.add("p/a");
    failing.add("p/b");
    expect(await turn(handle, extra)).toBe("p/x");
    expect(comboPins.get("\nc\nconv1")).toBe("p/a");
    failing.clear();
    expect(await turn(handle, extra)).toBe("p/a");
  });
});

describe("hedged rank2+ re-pin", () => {
  it("pins the third member when both hedged members fail", async () => {
    const { handle, failing } = makeHandler(new Set(["p/a", "p/b"]));
    const res = await turn(handle, { comboStrategy: "fastest", hedgeDelayMs: 30 });
    expect(res).toBe("p/c");
    expect(failing.size).toBe(2);
    expect(comboPins.get("\nc\nconv1")).toBe("p/c");
  });
});

describe("workspace isolation", () => {
  it("comboRotationKey-built names keep per-workspace pins independent", async () => {
    const { handle, failing } = makeHandler();
    const ws1 = comboRotationKey("w1", "c");
    const ws2 = comboRotationKey("w2", "c");
    expect(await turn(handle, { comboName: ws1 })).toBe("p/a");
    expect(await turn(handle, { comboName: ws2 })).toBe("p/a");
    failing.add("p/a");
    expect(await turn(handle, { comboName: ws1 })).toBe("p/b");
    failing.clear();
    expect(comboPins.get(`\n${ws1}\nconv1`)).toBe("p/b");
    expect(comboPins.get(`\n${ws2}\nconv1`)).toBe("p/a");
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
    comboPins.set("\nc\nconv1", "p/a");
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
    expect(comboPins.get("\nc\nconv1")).toBe("p/b");
    calls.length = 0;
    await turn(handler, opts);
    expect(calls).toEqual(["p/b"]);
  });
});

describe("weighted drain", () => {
  it("ignores a pin whose weight dropped to 0 and re-pins to the served member", async () => {
    const { handle } = makeHandler();
    const base = { comboStrategy: "weighted", models: ["p/a", "p/b"] };
    comboPins.set("\nc\nconv1", "p/a");
    expect(await turn(handle, { ...base, comboWeights: { "p/a": 1, "p/b": 1 } })).toBe("p/a");
    const served = await turn(handle, { ...base, comboWeights: { "p/a": 0, "p/b": 1 } });
    expect(served).toBe("p/b");
    expect(comboPins.get("\nc\nconv1")).toBe("p/b");
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
    comboPins.set("\nc\nconv1", "p/gone");
    expect(await turn(handle)).toBe("p/a");
    expect(comboPins.get("\nc\nconv1")).toBe("p/a");
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
    expect(pins.get("\nc\nconv1")).toBe("p/a");
    vi.setSystemTime(Date.now() + CACHE_AFFINITY_TTL_MS + 1);
    expect(pins.get("\nc\nconv1")).toBeUndefined();
    await t("conv1"); // strategy resumes: rotation head is p/b
    expect(pins.get("\nc\nconv1")).toBe("p/b");
  });
});

describe("resetComboRotation", () => {
  it("clears that combo's pins only", async () => {
    const { handle } = makeHandler();
    await turn(handle, { comboName: "c" });
    await turn(handle, { comboName: "c2" });
    resetComboRotation("c");
    expect(comboPins.get("\nc\nconv1")).toBeUndefined();
    expect(comboPins.get("\nc2\nconv1")).toBe("p/a");
    resetComboRotation();
    expect(comboPins.size).toBe(0);
  });
});

describe("workspace-scoped pins and resets (YAN-1221)", () => {
  const inWorkspace = (workspaceId) => ({
    workspaceId,
    comboName: comboRotationKey(workspaceId, "c"),
  });

  it("resetComboRotation({ workspaceId }) clears that workspace's pins and rotation only", async () => {
    const { handle } = makeHandler();
    await turn(handle, inWorkspace("wsA")); // wsA rotation: next head is p/b
    await turn(handle, { ...inWorkspace("wsB"), conversationKey: "other" });
    expect(comboPins.size).toBe(2);
    resetComboRotation(undefined, { workspaceId: "wsA" });
    expect(comboPins.size).toBe(1);
    expect(comboPins.get(`wsB\n${comboRotationKey("wsB", "c")}\nother`)).toBe("p/a");
    // wsA rotation restarted at p/a; wsB kept advancing (p/b next).
    expect(await turn(handle, { ...inWorkspace("wsA"), conversationKey: "n1" })).toBe("p/a");
    expect(await turn(handle, { ...inWorkspace("wsB"), conversationKey: "n1" })).toBe("p/b");
  });

  it("two workspaces with the same combo name and conversation pin independently", async () => {
    const { handle, failing } = makeHandler();
    expect(await turn(handle, inWorkspace("wsA"))).toBe("p/a");
    expect(await turn(handle, inWorkspace("wsB"))).toBe("p/a");
    failing.add("p/a");
    expect(await turn(handle, inWorkspace("wsA"))).toBe("p/b");
    failing.clear();
    expect(await turn(handle, inWorkspace("wsB"))).toBe("p/a");
  });
});

describe("first-turn convergence and commit-on-serve (YAN-1222)", () => {
  const slowHandler = (calls) => async (_body, model) => {
    calls.push(model);
    await sleep(20);
    return ok();
  };

  it("concurrent first turns of one conversation go to one member", async () => {
    const calls = [];
    const handle = slowHandler(calls);
    const run = (conversationKey) =>
      handleComboChat({
        body: { messages: [{ role: "user", content: "x" }] },
        models: ["p/a", "p/b", "p/c"],
        comboName: "c",
        comboStrategy: "round-robin",
        handleSingleModel: handle,
        log,
        conversationKey,
        cacheAffinity: true,
      });
    await Promise.all([run("conv1"), run("conv1")]);
    expect(calls).toEqual(["p/a", "p/a"]);
    // The strategy advanced once: the next new conversation gets p/b.
    await run("conv2");
    expect(calls[2]).toBe("p/b");
  });

  it("a first turn where nothing served leaves no pin behind", async () => {
    const { handle } = makeHandler(new Set(["p/a", "p/b", "p/c"]));
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
    expect(comboPins.size).toBe(0);
  });

  it("commitOnServe runs only for the served member, once it served", async () => {
    const commits = [];
    const failing = new Set(["p/a"]);
    const handle = async (_body, model, attempt) => {
      attempt?.commitOnServe(() => commits.push(model));
      expect(commits).toEqual([]); // never before the member is chosen
      return failing.has(model) ? fail() : ok();
    };
    const res = await handleComboChat({
      body: { messages: [] },
      models: ["p/a", "p/b"],
      comboName: "c",
      comboStrategy: "round-robin",
      handleSingleModel: handle,
      log,
      conversationKey: "conv1",
      cacheAffinity: true,
    });
    expect(res.status).toBe(200);
    expect(commits).toEqual(["p/b"]);
  });

  it("a hedged loser never commits; the winner does", async () => {
    const commits = [];
    const handle = async (_body, model, attempt) => {
      if (model === "p/a") {
        attempt.commitOnServe(() => commits.push("a"));
        await sleep(200).catch(() => {}); // slow leader, aborted when the backup wins
        return ok();
      }
      attempt.commitOnServe(() => commits.push("b"));
      await sleep(10);
      return ok();
    };
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "x" }] },
      models: ["p/a", "p/b"],
      comboName: "c",
      comboStrategy: "fastest",
      hedgeDelayMs: 30,
      handleSingleModel: async (body, model, attempt) => {
        const out = await handle(body, model, attempt);
        return out;
      },
      log,
      conversationKey: "conv1",
      cacheAffinity: true,
    });
    expect(res.status).toBe(200);
    await sleep(250);
    expect(commits).toEqual(["b"]);
    expect(comboPins.get("\nc\nconv1")).toBe("p/b");
  });
});

describe("combo pin lifetime (YAN-1224)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("a prompt-hash pin expires after the max age even under steady turns; a session pin slides", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.resetModules();
    const { comboPins: pins, comboPinKey } = await import(
      "../../open-sse/services/cacheAffinity.js"
    );
    const { CACHE_AFFINITY_PROMPT_PIN_MAX_AGE_MS: maxAge } = await import(
      "../../open-sse/config/runtimeConfig.js"
    );
    const p = comboPinKey(null, "c", "p:abc");
    const s = comboPinKey(null, "c", "s:abc");
    pins.set(p, "p/a");
    pins.set(s, "p/a");
    const step = Math.floor(maxAge / 5);
    for (let i = 0; i < 4; i++) {
      vi.setSystemTime(Date.now() + step);
      expect(pins.get(p)).toBe("p/a"); // each turn re-pins and renews the sliding TTL
      pins.set(p, "p/a");
      expect(pins.get(s)).toBe("p/a");
    }
    vi.setSystemTime(Date.now() + step + 1);
    expect(pins.get(p)).toBeUndefined();
    expect(pins.get(s)).toBe("p/a");
  });
});

describe("serve-only attempts and cleanup review regressions", () => {
  const run = (handleSingleModel, extra = {}) =>
    handleComboChat({
      body: { messages: [] },
      models: ["p/a", "p/b"],
      comboName: "c",
      comboStrategy: "fallback",
      conversationKey: "conv1",
      handleSingleModel,
      log,
      ...extra,
    });

  it("an empty fallback member releases its queued account pin instead of committing", async () => {
    const commits = [];
    const releases = [];
    const res = await run(async (_body, model, attempt) => {
      attempt.commitOnServe(
        () => commits.push(model),
        () => releases.push(model),
      );
      return model === "p/a"
        ? new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
        : ok();
    });
    expect(res.ok).toBe(true);
    expect(commits).toEqual(["p/b"]);
    expect(releases).toEqual(["p/a"]);
  });

  it("a nested fastest combo still hedges under an affinity-enabled round-robin combo", async () => {
    const calls = [];
    const commits = [];
    const releases = [];
    const res = await run(
      (_body, _model, parentAttempt) =>
        run(
          async (_b, model, attempt) => {
            calls.push(model);
            attempt.commitOnServe(
              () => commits.push(model),
              () => releases.push(model),
            );
            if (model === "p/a") await sleep(80);
            return ok();
          },
          { comboName: "inner", comboStrategy: "fastest", hedgeDelayMs: 5, parentAttempt },
        ),
      {
        models: ["inner"],
        comboStrategy: "round-robin",
        cacheAffinity: true,
      },
    );
    expect(res.ok).toBe(true);
    expect(calls).toEqual(["p/a", "p/b"]);
    expect(commits).toEqual(["p/b"]);
    expect(releases).toEqual(["p/a"]);
  });

  it("a failing concurrent first turn never deletes another turn's confirmed same-member pin", async () => {
    let failLeader;
    const leaderWait = new Promise((resolve) => {
      failLeader = resolve;
    });
    const first = run(
      async () => {
        await leaderWait;
        return fail(404);
      },
      {
        models: ["p/a"],
        comboStrategy: "round-robin",
        cacheAffinity: true,
      },
    );
    await run(async () => ok(), {
      models: ["p/a"],
      comboStrategy: "round-robin",
      cacheAffinity: true,
    });
    failLeader();
    await first;
    expect(comboPins.peek("\nc\nconv1")).toBe("p/a");
  });

  // YAN-1624: a nested affinity combo whose leaf serves at once; `outer` then
  // shapes what the outer level sees after the inner combo served.
  const nested =
    (name, outer, failing = new Set()) =>
    async (_body, _model, parentAttempt) => {
      const res = await run(async (_b, model) => (failing.has(model) ? fail() : ok()), {
        comboName: name,
        models: [`${name}/a`, `${name}/b`],
        comboStrategy: "round-robin",
        cacheAffinity: true,
        parentAttempt,
      });
      return outer ? outer(res, parentAttempt) : res;
    };

  it("a nested combo that loses the outer hedge writes no pin; the winner's nested pin commits (YAN-1624)", async () => {
    // The leader's inner combo served but the outer race is still open: it only
    // returns once the backup won and the race aborted it.
    const waitForAbort = (res, attempt) =>
      new Promise((resolve) =>
        attempt.signal.addEventListener("abort", () => resolve(res), { once: true }),
      );
    const members = { slow: nested("slow", waitForAbort), fast: nested("fast") };
    const res = await run((body, model, attempt) => members[model](body, model, attempt), {
      comboName: "outer",
      models: ["slow", "fast"],
      comboStrategy: "fastest",
      hedgeDelayMs: 10,
    });
    expect(res.ok).toBe(true);
    expect(comboPins.peek("\nslow\nconv1")).toBeUndefined();
    expect(comboPins.peek("\nfast\nconv1")).toBe("fast/a");
  });

  it("a nested combo the outer probe skips leaves neither its pin nor its provisional pin (YAN-1624)", async () => {
    // inner/a fails (provisional pin on a), inner/b serves, then the outer probe
    // finds an empty stream and moves on to p/b.
    const emptyStream = () =>
      new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    const inner = nested("inner", emptyStream, new Set(["inner/a"]));
    const res = await run(
      (body, model, attempt) => (model === "inner" ? inner(body, model, attempt) : ok()),
      { models: ["inner", "p/b"] },
    );
    expect(res.ok).toBe(true);
    expect(comboPins.peek("\ninner\nconv1")).toBeUndefined();
  });

  it("a deferred nested pin never replaces a pin a later turn confirmed meanwhile (YAN-1624)", async () => {
    // Turn 1's outer level is still deciding: its queued commit is held here.
    const held = [];
    const parentAttempt = { commitOnServe: (fn, release) => held.push({ fn, release }) };
    const innerTurn = (failing, extra = {}) =>
      run(async (_b, model) => (failing.has(model) ? fail() : ok()), {
        comboName: "inner",
        models: ["inner/a", "inner/b"],
        comboStrategy: "round-robin",
        cacheAffinity: true,
        ...extra,
      });
    await innerTurn(new Set(), { parentAttempt }); // turn 1 serves inner/a, pin queued
    comboPins.set("\ninner\nconv1", "inner/b"); // turn 2 failed over and confirmed b
    held[0].fn(); // turn 1's outer level wins late
    expect(comboPins.peek("\ninner\nconv1")).toBe("inner/b");
  });

  it("a reset between serve and a deferred pin commit leaves no pin (YAN-1676)", async () => {
    // Turn 1's outer level is still deciding: its queued commit is held here.
    const held = [];
    const parentAttempt = { commitOnServe: (fn, release) => held.push({ fn, release }) };
    const run = (handleSingleModel, extra = {}) =>
      handleComboChat({
        body: { messages: [] },
        models: ["p/a", "p/b"],
        comboStrategy: "round-robin",
        comboName: "inner",
        conversationKey: "conv1",
        handleSingleModel,
        log,
        parentAttempt,
        cacheAffinity: true,
        ...extra,
      });
    const res = await run(async () => ok());
    expect(res.ok).toBe(true);
    expect(comboPins.peek("\ninner\nconv1")).toBe("p/a"); // provisional pin until the outer level decides
    resetComboRotation(); // routing-settings reset lands before the outer level commits
    held[0].fn();
    expect(comboPins.peek("\ninner\nconv1")).toBeUndefined();
  });

  it.each([
    ["a first turn", undefined],
    ["an established pin", "p/a"],
  ])(
    "an unrelated reset still lets %s confirm the member that served (YAN-1676)",
    async (_label, existing) => {
      if (existing) comboPins.set("\ninner\nconv1", existing);
      const held = [];
      const parentAttempt = { commitOnServe: (fn, release) => held.push({ fn, release }) };
      const failing = new Set(["p/a"]);
      const res = await handleComboChat({
        body: { messages: [] },
        models: ["p/a", "p/b"],
        comboStrategy: "round-robin",
        comboName: "inner",
        conversationKey: "conv1",
        handleSingleModel: async (_b, model) => (failing.has(model) ? fail() : ok()),
        log,
        parentAttempt,
        cacheAffinity: true,
      });
      expect(res.ok).toBe(true); // p/a (provisional or pinned) failed, p/b served
      resetComboRotation("other"); // another combo saved before the outer level commits
      held[0].fn();
      expect(comboPins.peek("\ninner\nconv1")).toBe("p/b"); // never the failed p/a
    },
  );
});

describe("fusion panel pins (YAN-1673)", () => {
  const answer = (content) =>
    new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const emptyStream = () =>
    new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  const tuning = { minPanel: 2, stragglerGraceMs: 20, panelHardTimeoutMs: 2000 };

  // Panel member "inner" is an affinity combo; "p/x" a plain model; "p/judge" the judge.
  const fusion =
    ({ judge = () => answer("fused"), failing = new Set(), served = [], direct = null } = {}) =>
    (body, _model, parentAttempt) =>
      handleFusionChat({
        body,
        models: ["inner", "p/x"],
        judgeModel: "p/judge",
        tuning,
        log,
        parentAttempt,
        handleSingleModel: async (b, m, isPanel, attempt) => {
          if (m === "p/judge") return judge(b, attempt);
          if (direct && !isPanel) return direct(m, attempt);
          if (failing.has(m)) return fail();
          if (m !== "inner") return answer(`from ${m}`);
          await sleep(1); // async lookups before a real call picks its member
          return handleComboChat({
            body: b,
            models: ["inner/a", "inner/b"],
            comboName: "inner",
            comboStrategy: "round-robin",
            handleSingleModel: async (_bb, leaf) => {
              served.push(leaf);
              return answer(`from ${leaf}`);
            },
            log,
            conversationKey: "conv1",
            cacheAffinity: true,
            parentAttempt: attempt,
          });
        },
      });
  const outer = (members, handlers) =>
    handleComboChat({
      body: { messages: [{ role: "user", content: "x" }] },
      models: members,
      comboName: "outer",
      comboStrategy: "fallback",
      handleSingleModel: (b, m, attempt) => handlers[m](b, m, attempt),
      log,
      conversationKey: "conv1",
    });

  it("an empty judge falls back to the first source and keeps its panel pin (YAN-1030)", async () => {
    const res = await outer(["fusion", "p/b"], {
      fusion: fusion({ judge: emptyStream }),
      "p/b": async () => ok(),
    });
    expect(res.ok).toBe(true);
    expect(await res.json()).toMatchObject({ choices: [{ message: { content: "from inner/a" } }] });
    expect(comboPins.peek("\ninner\nconv1")).toBe("inner/a");
  });

  it("an outer combo that skips the fusion member leaves no pin from its panel", async () => {
    // Judge and fallback both stream nothing: the fusion 502s and the outer serves p/b.
    const res = await outer(["fusion", "p/b"], {
      fusion: fusion({ judge: emptyStream, direct: emptyStream }),
      "p/b": async () => ok(),
    });
    expect(res.ok).toBe(true);
    expect(comboPins.peek("\ninner\nconv1")).toBeUndefined();
  });

  it("a failed judge leaves no pin from its panel", async () => {
    const res = await outer(["fusion", "p/b"], {
      fusion: fusion({ judge: () => fail(500) }),
      "p/b": async () => ok(),
    });
    expect(res.ok).toBe(true);
    expect(comboPins.peek("\ninner\nconv1")).toBeUndefined();
  });

  it("a served fusion keeps the pin of the panel combo whose answer it used", async () => {
    const res = await outer(["fusion"], { fusion: fusion() });
    expect(res.ok).toBe(true);
    expect(comboPins.peek("\ninner\nconv1")).toBe("inner/a");
  });

  it("a single-answer fusion re-asks the panel member that answered, then keeps its pin", async () => {
    const served = [];
    const res = await outer(["fusion"], { fusion: fusion({ failing: new Set(["p/x"]), served }) });
    expect(res.ok).toBe(true);
    expect(served).toEqual(["inner/a", "inner/a"]);
    expect(comboPins.peek("\ninner\nconv1")).toBe("inner/a");
  });

  // YAN-1030 findings 3+6: a rejected empty served call (judge) leaves no pin and
  // no sample on the enclosing attempt; the accepted fallback's pins/feedback stay.
  const pinningJudge = (released) => (_b, attempt) => {
    attempt.commitOnServe(
      () => comboPins.set("\njudge\nconv1", "judge-acct"),
      () => released.push("judge"),
    );
    return emptyStream();
  };

  it("an empty judge leaves no pin of its own while the fallback's pin is kept (nested)", async () => {
    const released = [];
    const res = await outer(["fusion", "p/b"], {
      fusion: fusion({ judge: pinningJudge(released) }),
      "p/b": async () => ok(),
    });
    expect(res.ok).toBe(true);
    expect(comboPins.peek("\njudge\nconv1")).toBeUndefined();
    expect(released).toEqual(["judge"]);
    expect(comboPins.peek("\ninner\nconv1")).toBe("inner/a");
  });

  it("an empty top-level judge leaves no pin either; an accepted one commits", async () => {
    const released = [];
    const run = (judge) =>
      fusion({ judge })({ messages: [{ role: "user", content: "x" }] }, "fusion", null);
    const res = await run(pinningJudge(released));
    expect(res.ok).toBe(true);
    expect(comboPins.peek("\njudge\nconv1")).toBeUndefined();
    expect(released).toEqual(["judge"]);

    const accepted = await run((_b, attempt) => {
      attempt.commitOnServe(() => comboPins.set("\njudge\nconv1", "judge-acct"));
      return answer("fused");
    });
    expect(accepted.ok).toBe(true);
    expect(comboPins.peek("\njudge\nconv1")).toBe("judge-acct");
  });

  it("a rejected judge stream records nothing on the parent; the accepted fallback registers and feeds it", async () => {
    const parentSettles = [];
    const parentAttempt = {
      registerStream: vi.fn(() => (info) => parentSettles.push(info)),
      commitOnServe: (fn) => fn(),
    };
    let fallbackSettle;
    const judgeSettle = (_b, attempt) => {
      // streamingHandler registers when the stream is built, before the emptiness check.
      attempt.registerStream()?.({ error: new Error("empty-stream") });
      return emptyStream();
    };
    const res = await fusion({
      judge: judgeSettle,
      direct: (_m, attempt) => {
        fallbackSettle = attempt.registerStream();
        return answer("fb");
      },
    })({ messages: [{ role: "user", content: "x" }] }, "fusion", parentAttempt);
    expect(res.ok).toBe(true);
    // Rejected judge never reached the parent; only the accepted fallback did.
    expect(parentAttempt.registerStream).toHaveBeenCalledTimes(1);
    expect(parentSettles).toEqual([]);
    fallbackSettle({ firstTokenAt: 42 });
    expect(parentSettles).toEqual([{ firstTokenAt: 42 }]);
  });

  // YAN-1030: a served call that throws closes its scope; its queued pin is released.
  it("a judge that pins and then throws commits no pin and the error propagates", async () => {
    const released = [];
    const boom = new Error("judge exploded");
    await expect(
      fusion({
        judge: (_b, attempt) => {
          attempt.commitOnServe(
            () => comboPins.set("\njudge\nconv1", "judge-acct"),
            () => released.push("judge"),
          );
          throw boom;
        },
      })({ messages: [{ role: "user", content: "x" }] }, "fusion", null),
    ).rejects.toBe(boom);
    expect(comboPins.peek("\njudge\nconv1")).toBeUndefined();
    expect(released).toEqual(["judge"]);
  });
});
