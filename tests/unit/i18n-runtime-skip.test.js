import { describe, expect, it } from "vitest";
import { shouldSkipTextParent } from "../../src/i18n/runtime.js";

/** Minimal element stub: className, tag, attributes, parent chain. */
function el({ tag = "span", className = "", attrs = [], parent = null } = {}) {
  return {
    tagName: tag.toUpperCase(),
    className,
    parentElement: parent,
    hasAttribute: (name) => attrs.includes(name),
  };
}

describe("shouldSkipTextParent", () => {
  it("translates prose inside font-mono containers (Loading logs, Tunnel live at)", () => {
    const mono = el({ tag: "div", className: "font-mono text-xs text-muted" });
    expect(shouldSkipTextParent(el({ className: "", parent: mono }))).toBe(false);
    expect(shouldSkipTextParent(mono)).toBe(false);
  });

  it("skips material-symbols icon ligatures at any depth", () => {
    const icon = el({ className: "material-symbols-outlined" });
    expect(shouldSkipTextParent(icon)).toBe(true);
    expect(shouldSkipTextParent(el({ parent: icon }))).toBe(true);
  });

  it("skips data-i18n-skip subtrees and code tags", () => {
    const skip = el({ tag: "div", attrs: ["data-i18n-skip"] });
    expect(shouldSkipTextParent(el({ parent: skip }))).toBe(true);
    expect(shouldSkipTextParent(el({ tag: "code" }))).toBe(true);
  });

  it("skips code/pre ancestors, but translates table-cell copy", () => {
    const pre = el({ tag: "pre" });
    expect(shouldSkipTextParent(el({ tag: "span", parent: pre }))).toBe(true);
    const tr = el({ tag: "tr" });
    expect(shouldSkipTextParent(el({ tag: "td", parent: tr }))).toBe(false);
  });
});
