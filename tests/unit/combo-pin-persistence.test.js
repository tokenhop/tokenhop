// YAN-2468: combo conversation pins survive a gateway restart. Pins are mirrored
// to an injected store (open-sse never imports the DB) and reloaded at startup.
import { afterEach, describe, expect, it, vi } from "vitest";

import * as affinity from "../../open-sse/services/cacheAffinity.js";
import * as combo from "../../open-sse/services/combo.js";

const { createPinStore } = affinity;

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
  afterEach(() => {
    affinity.setComboPinPersistence(null);
    affinity.comboPins.clear();
    combo.resetComboRotation();
  });

  // The pin store is process-wide (globalThis), so a restart is simulated by
  // dropping in-memory state without mirroring the drop to the store.
  function restart() {
    affinity.setComboPinPersistence(null);
    affinity.comboPins.clear();
    combo.resetComboRotation();
  }

  const pinKey = () => affinity.comboPinKey(null, "Frontier", "s:conv-after-restart");
  const turn = (calls, handle) =>
    combo.handleComboChat({
      body: { messages: [{ role: "user", content: "x" }] },
      models: ["cc/claude-x", "cx/gpt-x", "ag/gemini-x"],
      comboName: "Frontier",
      comboStrategy: "weighted",
      comboWeights: { "cc/claude-x": 2, "cx/gpt-x": 1, "ag/gemini-x": 1 },
      handleSingleModel:
        handle ??
        (async (_b, m) => {
          calls.push(m);
          return new Response("{}", { status: 200 });
        }),
      log,
      conversationKey: "s:conv-after-restart",
      cacheAffinity: true,
    });

  it("a conversation keeps its model across a restart", async () => {
    const p = fakePersistence();
    affinity.setComboPinPersistence(p.store);
    // The conversation is on the Codex member before the restart.
    affinity.comboPins.set(pinKey(), "cx/gpt-x");
    await tick();

    restart();
    affinity.setComboPinPersistence(p.store);
    expect(affinity.restoreComboPins(p.rows.entries()).restored).toBe(1);

    const calls = [];
    for (let i = 0; i < 3; i++) await turn(calls);
    expect(calls).toEqual(["cx/gpt-x", "cx/gpt-x", "cx/gpt-x"]);
  });

  it("without persistence the same restart re-routes the conversation (the bug)", async () => {
    affinity.comboPins.set(pinKey(), "cx/gpt-x");
    restart();
    const calls = [];
    await turn(calls);
    // Weighted rotation leads with the weight-2 Claude member for a new conversation.
    expect(calls[0]).toBe("cc/claude-x");
  });

  it("separate module copies share one pin store (review #1222)", async () => {
    vi.resetModules();
    const other = await import("../../open-sse/services/cacheAffinity.js");
    expect(other.comboPins).toBe(affinity.comboPins);
    other.restoreComboPins([
      [pinKey(), { value: "cx/gpt-x", createdAt: Date.now(), touchedAt: Date.now() }],
    ]);
    expect(affinity.comboPins.peek(pinKey())).toBe("cx/gpt-x");
  });

  it("an unconfirmed first-turn claim is not persisted; the serving member is (review #1222)", async () => {
    const p = fakePersistence();
    affinity.setComboPinPersistence(p.store);
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const pending = turn([], async (_b, m) => {
      await gate;
      return new Response("{}", { status: 200, headers: { "x-model": m } });
    });
    await tick();
    // In flight: the claim exists in memory only.
    expect(affinity.comboPins.peek(pinKey())).toBe("cc/claude-x");
    expect(p.rows.has(pinKey())).toBe(false);
    release();
    await pending;
    await tick();
    expect(p.rows.get(pinKey())).toMatchObject({ value: "cc/claude-x" });
  });

  it("a read of an unconfirmed claim never persists it", async () => {
    const p = fakePersistence();
    affinity.setComboPinPersistence(p.store);
    affinity.comboPins.set(pinKey(), "cx/gpt-x", { durable: false });
    affinity.comboPins.get(pinKey());
    await tick();
    expect(p.calls).toEqual([]);
  });
});
