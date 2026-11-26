// YAN-2468: combo conversation pins survive a gateway restart. Pins are mirrored
// to an injected store (open-sse never imports the DB) and reloaded at startup.
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPinStore } from "../../open-sse/services/cacheAffinity.js";

const tick = () => new Promise((r) => setTimeout(r, 0));
const log = { info: () => {}, warn: () => {}, debug: () => {} };

function fakePersistence() {
  const rows = new Map();
  const calls = [];
  return {
    rows,
    calls,
    store: {
      save: (k, r) => {
        calls.push(["save", k]);
        rows.set(k, r);
      },
      remove: (k) => {
        calls.push(["remove", k]);
        rows.delete(k);
      },
      clear: () => {
        calls.push(["clear"]);
        rows.clear();
      },
    },
  };
}

function makeStore(p, opts = {}) {
  const clock = { t: 1000 };
  const store = createPinStore({
    ttlMs: 100,
    maxPins: 3,
    now: () => clock.t,
    persistence: () => p?.store ?? null,
    touchEveryMs: 30,
    ...opts,
  });
  return { store, clock };
}

describe("pin store write-through", () => {
  it("set saves value, createdAt and touchedAt", async () => {
    const p = fakePersistence();
    const { store } = makeStore(p);
    store.set("ws\nc\nconv", "p/a");
    await tick();
    expect(p.rows.get("ws\nc\nconv")).toEqual({ value: "p/a", createdAt: 1000, touchedAt: 1000 });
  });

  it("a read re-saves the last-used time at most every touchEveryMs", async () => {
    const p = fakePersistence();
    const { store, clock } = makeStore(p);
    store.set("k", "p/a");
    clock.t += 10;
    store.get("k");
    clock.t += 10;
    store.get("k");
    await tick();
    expect(p.calls.filter(([op]) => op === "save")).toHaveLength(1);
    clock.t += 15; // 35 since the save
    store.get("k");
    await tick();
    expect(p.calls.filter(([op]) => op === "save")).toHaveLength(2);
    expect(p.rows.get("k").touchedAt).toBe(1035);
  });

  it("delete, expiry, eviction and bulk deletes remove the persisted copy", async () => {
    const p = fakePersistence();
    const { store, clock } = makeStore(p);
    for (const k of ["a", "b", "c", "d"]) store.set(k, 1); // cap 3: "a" evicted
    await tick();
    expect([...p.rows.keys()]).toEqual(["b", "c", "d"]);
    store.delete("b");
    store.deleteWhere((k) => k === "c");
    await tick();
    expect([...p.rows.keys()]).toEqual(["d"]);
    clock.t += 101;
    expect(store.get("d")).toBeUndefined();
    await tick();
    expect(p.rows.size).toBe(0);
    store.set("e", 1);
    store.clear();
    await tick();
    expect(p.calls.at(-1)).toEqual(["clear"]);
  });

  it("a throwing or rejecting store never breaks routing reads and writes", () => {
    const bad = {
      store: {
        save: () => {
          throw new Error("disk");
        },
        remove: () => Promise.reject(new Error("disk")),
        clear: () => Promise.reject(new Error("disk")),
      },
    };
    const { store } = makeStore(bad);
    expect(() => store.set("k", "p/a")).not.toThrow();
    expect(store.get("k")).toBe("p/a");
    expect(() => store.delete("k")).not.toThrow();
    expect(() => store.clear()).not.toThrow();
  });
});

describe("restore", () => {
  it("restores a live pin with its expiry counted from the last touch", () => {
    const { store, clock } = makeStore(null);
    expect(store.restore("k", "p/a", 900, 950)).toBe(true);
    expect(store.peek("k")).toBe("p/a");
    clock.t = 1049; // 950 + 100 TTL - 1
    expect(store.peek("k")).toBe("p/a");
    clock.t = 1051;
    expect(store.peek("k")).toBeUndefined();
  });

  it("refuses an expired pin, a prompt-hash pin past its max age, and a malformed record", () => {
    const { store } = makeStore(null, {
      maxAgeFor: (key) => (key.includes("p:") ? 50 : Number.POSITIVE_INFINITY),
    });
    expect(store.restore("s:k", "p/a", 800, 899)).toBe(false); // 899 + 100 <= 1000
    expect(store.restore("p:k", "p/a", 900, 990)).toBe(false); // 100 old > 50 max age
    expect(store.restore("s:x", "p/a", undefined, 990)).toBe(false);
    expect(store.size).toBe(0);
  });

  it("never writes back what it restores", async () => {
    const p = fakePersistence();
    const { store } = makeStore(p);
    store.restore("k", "p/a", 990, 995);
    await tick();
    expect(p.calls).toEqual([]);
  });
});

describe("restart repro (YAN-2468)", () => {
  afterEach(async () => {
    const m = await import("../../open-sse/services/cacheAffinity.js");
    m.setComboPinPersistence(null);
    vi.resetModules();
  });

  async function freshModules() {
    vi.resetModules();
    const affinity = await import("../../open-sse/services/cacheAffinity.js");
    const combo = await import("../../open-sse/services/combo.js");
    return { affinity, combo };
  }

  const turn = (combo, calls) =>
    combo.handleComboChat({
      body: { messages: [{ role: "user", content: "x" }] },
      models: ["cc/claude-x", "cx/gpt-x", "ag/gemini-x"],
      comboName: "Frontier",
      comboStrategy: "weighted",
      comboWeights: { "cc/claude-x": 2, "cx/gpt-x": 1, "ag/gemini-x": 1 },
      handleSingleModel: async (_b, m) => {
        calls.push(m);
        return new Response("{}", { status: 200 });
      },
      log,
      conversationKey: "s:conv-after-restart",
      cacheAffinity: true,
    });

  it("a conversation keeps its model across a restart", async () => {
    const p = fakePersistence();
    let { affinity, combo } = await freshModules();
    affinity.setComboPinPersistence(p.store);
    // The conversation is on the Codex member before the restart.
    affinity.comboPins.set(
      affinity.comboPinKey(null, "Frontier", "s:conv-after-restart"),
      "cx/gpt-x",
    );
    await tick();

    // Restart: a fresh process has empty in-memory pins and rotation state.
    ({ affinity, combo } = await freshModules());
    affinity.setComboPinPersistence(p.store);
    const { restored } = affinity.restoreComboPins(p.rows.entries());
    expect(restored).toBe(1);

    const calls = [];
    for (let i = 0; i < 3; i++) await turn(combo, calls);
    expect(calls).toEqual(["cx/gpt-x", "cx/gpt-x", "cx/gpt-x"]);
  });

  it("without persistence the same restart re-routes the conversation (the bug)", async () => {
    let { affinity, combo } = await freshModules();
    affinity.comboPins.set(
      affinity.comboPinKey(null, "Frontier", "s:conv-after-restart"),
      "cx/gpt-x",
    );
    ({ affinity, combo } = await freshModules());
    const calls = [];
    await turn(combo, calls);
    // Weighted rotation leads with the weight-2 Claude member for a new conversation.
    expect(calls[0]).toBe("cc/claude-x");
  });
});
