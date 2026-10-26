// YAN-1211: conversation cache affinity for combo members (Lane B).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
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
});
