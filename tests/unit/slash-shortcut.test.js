import { describe, expect, it } from "vitest";
import { shouldFocusSearch } from "@/shared/hooks/useSlashShortcut";

const plain = { tagName: "DIV", isContentEditable: false, closest: () => null };

describe("shouldFocusSearch", () => {
  it("returns true for a plain '/' keydown on a non-editable target", () => {
    expect(shouldFocusSearch({ key: "/", target: plain })).toBe(true);
  });

  it.each(["metaKey", "ctrlKey", "altKey"])("returns false with %s held", (modifier) => {
    expect(shouldFocusSearch({ key: "/", target: plain, [modifier]: true })).toBe(false);
  });

  it("returns false while composing (IME)", () => {
    expect(shouldFocusSearch({ key: "/", target: plain, isComposing: true })).toBe(false);
  });

  it.each(["INPUT", "TEXTAREA", "SELECT"])("returns false from a %s target", (tagName) => {
    const target = { ...plain, tagName };
    expect(shouldFocusSearch({ key: "/", target })).toBe(false);
  });

  it("returns false from a contentEditable target", () => {
    const target = { ...plain, isContentEditable: true };
    expect(shouldFocusSearch({ key: "/", target })).toBe(false);
  });

  it("returns false from inside a Monaco editor", () => {
    const target = { ...plain, closest: () => ({ className: "monaco-editor" }) };
    expect(shouldFocusSearch({ key: "/", target })).toBe(false);
  });

  it.each(["a", "k", "Enter", "Shift"])("returns false for '%s'", (key) => {
    expect(shouldFocusSearch({ key, target: plain })).toBe(false);
  });
});
