import { describe, expect, it } from "vitest";
import { safeFormatJson } from "@/app/(dashboard)/dashboard/translator/translatorPresentation";

describe("safeFormatJson", () => {
  it("pretty-prints JSON", () => {
    expect(safeFormatJson('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it("returns null for non-JSON", () => {
    expect(safeFormatJson("not json {{{")).toBeNull();
    expect(safeFormatJson("")).toBeNull();
  });
});
