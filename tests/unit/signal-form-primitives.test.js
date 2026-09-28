import { describe, expect, it, vi } from "vitest";
import {
  BUTTON_SIZES,
  BUTTON_VARIANTS,
  buttonClasses,
  clampNumber,
  copyTextToClipboard,
  describedByFor,
  hasPanelContent,
  isRovingKey,
  nextRovingIndex,
  SEGMENTED_SIZES,
  stepNumber,
} from "../../src/shared/components/formPrimitives.js";

describe("buttonClasses", () => {
  it("resolves every supported variant + size", () => {
    expect(buttonClasses("primary", "md")).toContain("bg-lime");
    expect(buttonClasses("secondary", "sm")).toContain("bg-raised");
    expect(buttonClasses("ghost", "md")).toContain("bg-transparent");
    // Kit.dc.html .btn.ghost: transparent fill, text color, line border.
    expect(BUTTON_VARIANTS.ghost).toContain("text-text");
    expect(BUTTON_VARIANTS.ghost).toContain("border-line");
    expect(BUTTON_VARIANTS.ghost).not.toContain("text-muted");
    expect(buttonClasses("danger", "sm")).toContain("text-err");
    for (const variant of Object.keys(BUTTON_VARIANTS)) {
      for (const size of Object.keys(BUTTON_SIZES)) {
        expect(buttonClasses(variant, size)).toBe(
          `${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]}`,
        );
      }
    }
  });

  it("keeps legacy variant/sizes working for old call sites", () => {
    expect(buttonClasses("outline", "sm")).toContain("text-text");
    expect(buttonClasses("success", "lg")).toContain("text-ok");
  });

  it("fails fast on typos instead of shipping unstyled buttons", () => {
    expect(() => buttonClasses("primay")).toThrow('unknown variant "primay"');
    expect(() => buttonClasses("primary", "xl")).toThrow('unknown size "xl"');
  });

  it("tracks the required spec sizes", () => {
    expect(BUTTON_SIZES.md).toContain("h-11");
    expect(BUTTON_SIZES.sm).toContain("h-10");
    expect(SEGMENTED_SIZES.md).toContain("h-9");
  });
});

describe("clampNumber", () => {
  it("snaps finite values into [min, max]", () => {
    expect(clampNumber(5, { min: 0, max: 10 })).toBe(5);
    expect(clampNumber(-3, { min: 0, max: 10 })).toBe(0);
    expect(clampNumber(99, { min: 0, max: 10 })).toBe(10);
    expect(clampNumber("7", { min: 1, max: 6 })).toBe(6);
  });

  it("passes partial/empty input through for editable state", () => {
    expect(clampNumber("", { min: 0, max: 10 })).toBe("");
    expect(clampNumber(undefined, { min: 0, max: 10 })).toBe(undefined);
    expect(clampNumber("abc", { min: 0, max: 10 })).toBe("abc");
  });

  it("ignores missing bounds", () => {
    expect(clampNumber(500, {})).toBe(500);
    expect(clampNumber(-500, { max: 0 })).toBe(-500);
  });
});

describe("stepNumber", () => {
  it("steps up and down with clamping", () => {
    expect(stepNumber(5, { min: 0, max: 10, step: 1, direction: 1 })).toBe(6);
    expect(stepNumber(5, { min: 0, max: 10, step: 1, direction: -1 })).toBe(4);
    expect(stepNumber(10, { min: 0, max: 10, step: 1, direction: 1 })).toBe(10);
    expect(stepNumber(0, { min: 0, max: 10, step: 1, direction: -1 })).toBe(0);
  });

  it("keeps float steps exact", () => {
    expect(stepNumber(0.1, { step: 0.2, direction: 1 })).toBe(0.3);
    expect(stepNumber(1.5, { step: 0.5, direction: -1 })).toBe(1);
  });

  it("starts non-numeric input from min or zero", () => {
    expect(stepNumber("", { min: 2, step: 1, direction: 1 })).toBe(3);
    expect(stepNumber(undefined, { step: 1, direction: 1 })).toBe(1);
  });
});

describe("nextRovingIndex", () => {
  it("wraps arrows around the option list", () => {
    expect(nextRovingIndex(2, "ArrowRight", { length: 3 })).toBe(0);
    expect(nextRovingIndex(0, "ArrowLeft", { length: 3 })).toBe(2);
    expect(nextRovingIndex(2, "ArrowDown", { length: 3 })).toBe(0);
    expect(nextRovingIndex(0, "ArrowUp", { length: 3 })).toBe(2);
  });

  it("jumps with Home/End", () => {
    expect(nextRovingIndex(2, "Home", { length: 3 })).toBe(0);
    expect(nextRovingIndex(0, "End", { length: 3 })).toBe(2);
  });

  it("flips left/right in RTL, keeps up/down", () => {
    expect(nextRovingIndex(0, "ArrowRight", { length: 3, rtl: true })).toBe(2);
    expect(nextRovingIndex(0, "ArrowLeft", { length: 3, rtl: true })).toBe(1);
    expect(nextRovingIndex(0, "ArrowDown", { length: 3, rtl: true })).toBe(1);
    expect(nextRovingIndex(0, "ArrowUp", { length: 3, rtl: true })).toBe(2);
  });

  it("ignores non-navigation keys and degenerate lists", () => {
    expect(nextRovingIndex(1, "Enter", { length: 3 })).toBe(1);
    expect(nextRovingIndex(0, "ArrowRight", { length: 0 })).toBe(0);
  });

  it("isRovingKey matches the handled key set", () => {
    for (const key of ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"]) {
      expect(isRovingKey(key)).toBe(true);
    }
    expect(isRovingKey("Enter")).toBe(false);
  });
});

describe("describedByFor", () => {
  it("points errors over hints", () => {
    expect(describedByFor("f", { error: "bad", hint: "tip" })).toBe("f-error");
    expect(describedByFor("f", { hint: "tip" })).toBe("f-hint");
    expect(describedByFor("f", {})).toBe(undefined);
  });
});

describe("copyTextToClipboard", () => {
  it("prefers navigator.clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await copyTextToClipboard("endpoint");
    expect(writeText).toHaveBeenCalledWith("endpoint");
    vi.unstubAllGlobals();
  });

  it("throws when every path fails", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", undefined);
    await expect(copyTextToClipboard("x")).rejects.toThrow("clipboard API unavailable");
    vi.unstubAllGlobals();
  });

  it("throws when the execCommand fallback fails", async () => {
    vi.stubGlobal("navigator", {});
    const removeChild = vi.fn();
    const textarea = { style: {}, select: vi.fn() };
    vi.stubGlobal("document", {
      createElement: vi.fn().mockReturnValue(textarea),
      body: { appendChild: vi.fn(), removeChild },
      execCommand: vi.fn().mockReturnValue(false),
    });
    await expect(copyTextToClipboard("x")).rejects.toThrow("execCommand");
    expect(removeChild).toHaveBeenCalledWith(textarea);
    vi.unstubAllGlobals();
  });
});

describe("hasPanelContent (tabs APG focus stop)", () => {
  it("is false for empty panels so they add no tab stop", () => {
    for (const empty of [undefined, null, false, ""]) expect(hasPanelContent(empty)).toBe(false);
  });
  it("is true for any rendered content", () => {
    for (const content of ["text", 0, { type: "div" }, ["a"]]) {
      expect(hasPanelContent(content)).toBe(true);
    }
  });
});
