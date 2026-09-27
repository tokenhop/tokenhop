import { describe, expect, it } from "vitest";
import { isDirty, adapterWarnings } from "../../src/shared/components/combos/comboBuilder.js";

describe("combo save state", () => {
  const saved = { models: ["p/a", "p/b"], strategy: "fallback", weights: {}, judge: "" };
  it("detects route edits, reverts and strategy edits", () => {
    expect(isDirty({ saved, draft: { ...saved } })).toBe(false);
    expect(isDirty({ saved, draft: { ...saved, models: ["p/b", "p/a"] } })).toBe(true);
    expect(isDirty({ saved, draft: { ...saved, strategy: "fusion" } })).toBe(true);
    expect(isDirty({ saved, draft: { ...saved, weights: { "p/a": 2 } } })).toBe(true);
  });
});

describe("empty enabled adapter warning", () => {
  it("only warns for enabled empty pools, including missing default entries", () => {
    expect(adapterWarnings({})).toEqual(["vision", "audioInput"]);
    expect(
      adapterWarnings({
        vision: { enabled: false, models: [] },
        audioInput: { enabled: true, models: ["p/audio"] },
      }),
    ).toEqual([]);
    expect(
      adapterWarnings({
        vision: { enabled: true, models: [] },
        audioInput: { enabled: false, models: [] },
      }),
    ).toEqual(["vision"]);
  });
});
