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

describe("pin keys", () => {
  it("return null for missing parts", () => {
    expect(comboPinKey("", "s:1")).toBeNull();
    expect(comboPinKey("c", null)).toBeNull();
    expect(accountPinKey("ws", "", "s:1")).toBeNull();
    expect(accountPinKey("ws", "openai", null)).toBeNull();
  });

  it("different workspaces produce different keys; legacy uses empty workspace", () => {
    expect(accountPinKey("wsA", "openai", "s:1")).not.toBe(accountPinKey("wsB", "openai", "s:1"));
    expect(accountPinKey(null, "openai", "s:1")).toBe("\nopenai\ns:1");
    expect(comboPinKey("ws1:c", "s:1")).not.toBe(comboPinKey("ws2:c", "s:1"));
  });
});

describe("clear helpers", () => {
  it("clearComboPins drops one combo only (prefix, not substring)", () => {
    comboPins.clear();
    comboPins.set(comboPinKey("ws1:c", "s:1"), "m");
    comboPins.set(comboPinKey("ws1:c2", "s:1"), "m");
    comboPins.set(comboPinKey("ws2:c", "s:1"), "m");
    clearComboPins("ws1:c");
    expect(comboPins.get(comboPinKey("ws1:c", "s:1"))).toBeUndefined();
    expect(comboPins.get(comboPinKey("ws1:c2", "s:1"))).toBe("m");
    expect(comboPins.get(comboPinKey("ws2:c", "s:1"))).toBe("m");
    clearComboPins();
    expect(comboPins.size).toBe(0);
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
