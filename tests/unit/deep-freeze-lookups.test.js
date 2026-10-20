// YAN-1106: one shared deepFreeze helper; chatLookups freezes only objects it owns.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  getComboByName: vi.fn(),
}));
vi.mock("@/sse/services/model.js", () => mocks);

import { deepFreeze } from "@/lib/utils/deepFreeze.js";
import { createChatLookups } from "@/sse/handlers/chatLookups.js";

describe("deepFreeze", () => {
  it("freezes nested objects and arrays and returns the same value", () => {
    const v = { a: { b: [1, { c: 2 }] } };
    expect(deepFreeze(v)).toBe(v);
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.a)).toBe(true);
    expect(Object.isFrozen(v.a.b)).toBe(true);
    expect(Object.isFrozen(v.a.b[1])).toBe(true);
  });

  it("passes primitives and null through, skips typed arrays, survives cycles", () => {
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(3)).toBe(3);
    expect(deepFreeze("x")).toBe("x");
    const buf = Buffer.from("abc");
    expect(() => deepFreeze({ buf })).not.toThrow();
    expect(Object.isFrozen(buf)).toBe(false);
    const cyc = { name: "c" };
    cyc.self = cyc;
    expect(() => deepFreeze(cyc)).not.toThrow();
    expect(Object.isFrozen(cyc)).toBe(true);
  });
});

describe("chatLookups ownership", () => {
  beforeEach(() => vi.clearAllMocks());

  it("hands out frozen copies and never freezes the object the service returned", async () => {
    const sharedCombo = { name: "c", models: ["a/b", "c/d"] };
    const sharedModels = sharedCombo.models; // a reference INTO the combo, as getComboModels returns
    const sharedInfo = { provider: "openai", model: "gpt-4o" };
    mocks.getComboByName.mockResolvedValue(sharedCombo);
    mocks.getComboModels.mockResolvedValue(sharedModels);
    mocks.getModelInfo.mockResolvedValue(sharedInfo);
    const lookups = createChatLookups({ workspaceId: "w1" });

    const combo = await lookups.comboByName("c");
    const models = await lookups.comboModels("c");
    const info = await lookups.modelInfo("openai/gpt-4o");

    // Handed-out values are frozen, equal in content, and are not the shared objects.
    expect(combo).toEqual(sharedCombo);
    expect(models).toEqual(["a/b", "c/d"]);
    expect(info).toEqual(sharedInfo);
    for (const v of [combo, combo.models, models, info]) expect(Object.isFrozen(v)).toBe(true);
    expect(combo).not.toBe(sharedCombo);
    expect(models).not.toBe(sharedModels);
    expect(info).not.toBe(sharedInfo);

    // The service's own objects stay writable for their other holders.
    for (const v of [sharedCombo, sharedCombo.models, sharedInfo]) {
      expect(Object.isFrozen(v)).toBe(false);
    }
    sharedCombo.models.push("e/f");
    sharedInfo.model = "changed";
  });

  it("still memoizes: repeat lookups return the same frozen value from one read", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "m" });
    const lookups = createChatLookups(null);
    const [a, b] = await Promise.all([lookups.modelInfo("x"), lookups.modelInfo("x")]);
    expect(a).toBe(b);
    expect(await lookups.modelInfo("x")).toBe(a);
    expect(mocks.getModelInfo).toHaveBeenCalledTimes(1);
  });

  it("null results pass through and a rejected lookup is retried", async () => {
    mocks.getComboByName.mockResolvedValueOnce(null);
    const lookups = createChatLookups(null);
    expect(await lookups.comboByName("none")).toBeNull();
    mocks.getModelInfo
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ provider: "p", model: "m" });
    await expect(lookups.modelInfo("y")).rejects.toThrow("boom");
    expect(await lookups.modelInfo("y")).toEqual({ provider: "p", model: "m" });
  });
});
