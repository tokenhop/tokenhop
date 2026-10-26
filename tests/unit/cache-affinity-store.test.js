// YAN-1211/1213: pin store (sliding TTL + LRU), key builders, clear helpers, orderAroundPin.
import { describe, it, expect } from "vitest";
import {
  accountPinKey,
  clearAccountPins,
  clearComboPins,
  comboPinKey,
  comboPins,
  accountPins,
  createPinStore,
  orderAroundPin,
} from "../../open-sse/services/cacheAffinity.js";

function makeStore(opts = {}) {
  const clock = { t: 1000 };
  const store = createPinStore({ ttlMs: 100, maxPins: 3, now: () => clock.t, ...opts });
  return { store, clock };
}

describe("createPinStore", () => {
  it("round-trips get/set and delete", () => {
    const { store } = makeStore();
    store.set("k", "a");
    expect(store.get("k")).toBe("a");
    store.delete("k");
    expect(store.get("k")).toBeUndefined();
  });

  it("expired entry returns undefined and is removed", () => {
    const { store, clock } = makeStore();
    store.set("k", "a");
    clock.t += 101;
    expect(store.get("k")).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("sliding TTL: a get before expiry extends it", () => {
    const { store, clock } = makeStore();
    store.set("k", "a");
    clock.t += 80;
    expect(store.get("k")).toBe("a");
    clock.t += 80;
    expect(store.get("k")).toBe("a");
    clock.t += 101;
    expect(store.get("k")).toBeUndefined();
  });

  it("LRU cap evicts the oldest; a touched entry survives", () => {
    const { store } = makeStore();
    store.set("a", 1);
    store.set("b", 2);
    store.set("c", 3);
    store.get("a");
    store.set("d", 4);
    expect(store.size).toBe(3);
    expect(store.get("b")).toBeUndefined();
    expect(store.get("a")).toBe(1);
    expect(store.get("d")).toBe(4);
  });

  it("deleteWhere and clear", () => {
    const { store } = makeStore();
    store.set("x1", 1);
    store.set("x2", 2);
    store.set("y1", 3);
    store.deleteWhere((k) => k.startsWith("x"));
    expect(store.size).toBe(1);
    store.clear();
    expect(store.size).toBe(0);
  });
});

describe("createPinStore scopes and max age (YAN-1221, YAN-1224)", () => {
  const key = (ws, conv) => `${ws}\nc\n${conv}`;

  it("per-scope cap evicts only inside that scope", () => {
    const { store } = makeStore({ maxPins: 100, maxPinsPerScope: 2 });
    store.set(key("wsB", "s:1"), "b");
    for (const n of [1, 2, 3, 4]) store.set(key("wsA", `s:${n}`), "a");
    expect(store.get(key("wsB", "s:1"))).toBe("b");
    expect(store.get(key("wsA", "s:1"))).toBeUndefined();
    expect(store.get(key("wsA", "s:2"))).toBeUndefined();
    expect(store.get(key("wsA", "s:3"))).toBe("a");
    expect(store.get(key("wsA", "s:4"))).toBe("a");
  });

  it("the global cap still holds across scopes", () => {
    const { store } = makeStore({ maxPins: 3, maxPinsPerScope: 2 });
    store.set(key("w1", "s:1"), 1);
    store.set(key("w2", "s:1"), 2);
    store.set(key("w3", "s:1"), 3);
    store.set(key("w4", "s:1"), 4);
    expect(store.size).toBe(3);
    expect(store.get(key("w1", "s:1"))).toBeUndefined();
  });

  it("deleteScope drops one scope only and keeps the scope index consistent", () => {
    const { store } = makeStore({ maxPins: 100, maxPinsPerScope: 1 });
    store.set(key("wsA", "s:1"), 1);
    store.set(key("wsB", "s:1"), 2);
    store.deleteScope("wsA");
    expect(store.size).toBe(1);
    store.set(key("wsA", "s:2"), 3);
    store.set(key("wsA", "s:3"), 4); // cap 1 evicts s:2
    expect(store.get(key("wsA", "s:2"))).toBeUndefined();
    expect(store.get(key("wsB", "s:1"))).toBe(2);
  });

  it("an absolute max age expires a key despite steady gets; re-set keeps createdAt", () => {
    const { store, clock } = makeStore({ ttlMs: 100, maxAgeFor: () => 250 });
    store.set("k", "a");
    for (let i = 0; i < 2; i++) {
      clock.t += 80;
      expect(store.get("k")).toBe("a");
    }
    clock.t += 80;
    store.set("k", "b"); // re-pin must not extend the lifetime
    expect(store.peek("k")).toBe("b");
    clock.t += 30; // 270ms after the first write
    expect(store.get("k")).toBeUndefined();
    store.set("k", "c"); // an expired key starts a fresh lifetime
    clock.t += 80;
    expect(store.get("k")).toBe("c");
  });

  it("keys without a max age slide as before", () => {
    const { store, clock } = makeStore({
      ttlMs: 100,
      maxAgeFor: (k) => (k.startsWith("p:") ? 150 : Infinity),
    });
    store.set("s:1", "a");
    store.set("p:1", "b");
    for (let i = 0; i < 3; i++) {
      clock.t += 80;
      store.get("s:1");
      store.get("p:1");
    }
    expect(store.get("s:1")).toBe("a");
    expect(store.get("p:1")).toBeUndefined();
  });

  it("peek returns the value without renewing TTL or LRU position", () => {
    const { store, clock } = makeStore();
    store.set("a", 1);
    store.set("b", 2);
    store.set("c", 3);
    clock.t += 60;
    expect(store.peek("a")).toBe(1);
    clock.t += 60; // 120ms after set: expired unless peek had renewed it
    expect(store.get("a")).toBeUndefined();
    store.set("a", 1);
    store.peek("b");
    store.set("d", 4); // b stays the LRU victim
    expect(store.get("b")).toBeUndefined();
  });
});

describe("pin keys", () => {
  it("return null for missing parts", () => {
    expect(comboPinKey(null, "", "s:1")).toBeNull();
    expect(comboPinKey(null, "c", null)).toBeNull();
    expect(accountPinKey("ws", "", "s:1")).toBeNull();
    expect(accountPinKey("ws", "openai", null)).toBeNull();
  });

  it("different workspaces produce different keys; legacy uses empty workspace", () => {
    expect(accountPinKey("wsA", "openai", "s:1")).not.toBe(accountPinKey("wsB", "openai", "s:1"));
    expect(accountPinKey(null, "openai", "s:1")).toBe("\nopenai\ns:1");
    expect(comboPinKey("ws1", "c", "s:1")).not.toBe(comboPinKey("ws2", "c", "s:1"));
    expect(comboPinKey(null, "c", "s:1")).toBe("\nc\ns:1");
  });
});

describe("clear helpers", () => {
  it("clearComboPins drops one combo only (prefix, not substring)", () => {
    comboPins.clear();
    comboPins.set(comboPinKey(null, "ws1:c", "s:1"), "m");
    comboPins.set(comboPinKey(null, "ws1:c2", "s:1"), "m");
    comboPins.set(comboPinKey(null, "ws2:c", "s:1"), "m");
    clearComboPins("ws1:c");
    expect(comboPins.get(comboPinKey(null, "ws1:c", "s:1"))).toBeUndefined();
    expect(comboPins.get(comboPinKey(null, "ws1:c2", "s:1"))).toBe("m");
    expect(comboPins.get(comboPinKey(null, "ws2:c", "s:1"))).toBe("m");
    clearComboPins();
    expect(comboPins.size).toBe(0);
  });

  it("clearComboPins / clearAccountPins can be limited to one workspace", () => {
    comboPins.clear();
    accountPins.clear();
    comboPins.set(comboPinKey("wsA", "wsA:c", "s:1"), "m");
    comboPins.set(comboPinKey("wsB", "wsB:c", "s:1"), "m");
    clearComboPins(undefined, { workspaceId: "wsA" });
    expect(comboPins.size).toBe(1);
    expect(comboPins.get(comboPinKey("wsB", "wsB:c", "s:1"))).toBe("m");

    accountPins.set(accountPinKey("wsA", "openai", "s:1"), "c1");
    accountPins.set(accountPinKey("wsB", "openai", "s:1"), "c2");
    accountPins.set(accountPinKey("wsA", "claude", "s:1"), "c3");
    clearAccountPins("openai", { workspaceId: "wsA" });
    expect(accountPins.size).toBe(2);
    expect(accountPins.get(accountPinKey("wsB", "openai", "s:1"))).toBe("c2");
    clearAccountPins(undefined, { workspaceId: "wsA" });
    expect(accountPins.size).toBe(1);
  });

  it("clearAccountPins drops one provider only", () => {
    accountPins.clear();
    accountPins.set(accountPinKey("ws", "openai", "s:1"), "c1");
    accountPins.set(accountPinKey(null, "openai", "s:2"), "c2");
    accountPins.set(accountPinKey("ws", "claude", "s:1"), "c3");
    clearAccountPins("openai");
    expect(accountPins.size).toBe(1);
    expect(accountPins.get(accountPinKey("ws", "claude", "s:1"))).toBe("c3");
    clearAccountPins();
    expect(accountPins.size).toBe(0);
  });
});

describe("orderAroundPin", () => {
  it("moves a present pin first without mutating the input", () => {
    const order = ["a", "b", "c"];
    expect(orderAroundPin(order, "c")).toEqual(["c", "a", "b"]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("returns a copy when the pin is absent or already first", () => {
    const order = ["a", "b"];
    const absent = orderAroundPin(order, "z");
    expect(absent).toEqual(["a", "b"]);
    expect(absent).not.toBe(order);
    expect(orderAroundPin(order, "a")).toEqual(["a", "b"]);
  });
});
