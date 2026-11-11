import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// open-sse never imports the db: persistence is an injected kv store. Without one
// the cache is RAM-only; with one, writes reach it and a RAM miss falls back to it.
let store;
beforeEach(async () => {
  vi.resetModules();
  store = await import("../../open-sse/services/thoughtSignatureStore.js");
});
afterEach(() => store.setThoughtSignatureKv(null));

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("thoughtSignatureStore kv injection", () => {
  it("works RAM-only when no kv store is installed", async () => {
    store.storeGeminiThoughtSignature("call-ram", "sig-ram", null, "gemini-3");
    expect(store.getGeminiThoughtSignatureSync("call-ram", null, "gemini-3")).toBe("sig-ram");
    expect(await store.getGeminiThoughtSignature("missing")).toBeNull();
  });

  it("persists to the installed kv and reads back after a RAM miss", async () => {
    const rows = new Map();
    store.setThoughtSignatureKv({
      get: async (k) => rows.get(k) ?? null,
      set: async (k, v) => void rows.set(k, v),
      remove: async (k) => void rows.delete(k),
      getAll: async () => Object.fromEntries(rows),
    });
    store.storeGeminiThoughtSignature("call-kv", "sig-kv", null, "gemini-3");
    await tick();
    expect(rows.get("call-kv")).toMatchObject({ signature: "sig-kv", family: "gemini" });

    vi.resetModules();
    const fresh = await import("../../open-sse/services/thoughtSignatureStore.js");
    expect(fresh.getGeminiThoughtSignatureSync("call-kv", null, "gemini-3")).toBeNull();
    expect(await fresh.getGeminiThoughtSignature("call-kv", null, "gemini-3")).toBe("sig-kv");
  });
});
