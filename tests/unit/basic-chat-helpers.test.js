import { describe, expect, it } from "vitest";
import {
  dedupeChatModels,
  makeChatSessionTitle,
  chatTextValue,
  parseProviderModels,
} from "@/app/(dashboard)/dashboard/basic-chat/chatHelpers";

describe("chatHelpers", () => {
  it("flattens values to text", () => {
    expect(chatTextValue("hi")).toBe("hi");
    expect(chatTextValue(null)).toBe("");
    expect(chatTextValue([{ a: 1 }, "x"])).toContain("x");
    expect(chatTextValue({ message: "m" })).toBe("m");
    expect(chatTextValue({ error: "e" })).toBe("e");
  });

  it("titles sessions from first message", () => {
    expect(makeChatSessionTitle("")).toBe("New chat");
    expect(makeChatSessionTitle("  hello   world ")).toBe("hello world");
    expect(makeChatSessionTitle("a".repeat(60))).toMatch(/…$/);
  });

  it("parses provider model payload shapes", () => {
    expect(parseProviderModels({ models: [1] })).toEqual([1]);
    expect(parseProviderModels({ data: [2] })).toEqual([2]);
    expect(parseProviderModels({ results: [3] })).toEqual([3]);
    expect(parseProviderModels([4])).toEqual([4]);
    expect(parseProviderModels({})).toEqual([]);
  });

  it("dedupes models by id", () => {
    expect(dedupeChatModels([{ id: "a" }, { id: "a" }, { id: "b" }]).map((m) => m.id)).toEqual([
      "a",
      "b",
    ]);
  });
});
