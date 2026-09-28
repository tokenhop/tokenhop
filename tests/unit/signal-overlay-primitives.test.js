import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { nextRovingIndex } from "../../src/shared/components/formPrimitives.js";
import {
  confirmMayStart,
  confirmSettleFresh,
  createDismissStack,
  createScrollLock,
  cycleTabFocus,
  drawerSideClass,
  drawerWidthClass,
  menuPosition,
  firstEnabledIndex,
  floatingPosition,
  isElementVisible,
  matchMenuTypeahead,
  modalSizeClass,
  nextEnabledIndex,
  TYPEAHEAD_TIMEOUT_MS,
  typeaheadStep,
  tooltipPositionClass,
  tooltipVariantClass,
  trapStack,
} from "../../src/shared/components/overlayPrimitives.js";

describe("confirm lifecycle guards", () => {
  it("confirmMayStart blocks a second press while locked or busy", () => {
    expect(confirmMayStart({ current: false }, false)).toBe(true);
    expect(confirmMayStart({ current: true }, false)).toBe(false);
    expect(confirmMayStart({ current: false }, true)).toBe(false);
    expect(confirmMayStart({ current: true }, true)).toBe(false);
  });

  it("confirmSettleFresh ignores stale requests and closed dialogs", () => {
    expect(confirmSettleFresh(2, { current: 2 }, true)).toBe(true);
    expect(confirmSettleFresh(1, { current: 2 }, true)).toBe(false); // superseded
    expect(confirmSettleFresh(2, { current: 2 }, false)).toBe(false); // closed
    expect(confirmSettleFresh(2, { current: 2 }, null)).toBe(false);
    expect(confirmSettleFresh(2, null, true)).toBe(false);
  });
});

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

describe("focus trap tab cycling", () => {
  it("cycles forward and backward, wrapping at first/last", () => {
    expect(cycleTabFocus(0, 3)).toBe(1);
    expect(cycleTabFocus(1, 3)).toBe(2);
    expect(cycleTabFocus(2, 3)).toBe(0);
    expect(cycleTabFocus(0, 3, true)).toBe(2);
    expect(cycleTabFocus(2, 3, true)).toBe(1);
  });

  it("enters from the matching edge when focus is outside", () => {
    expect(cycleTabFocus(-1, 2)).toBe(0);
    expect(cycleTabFocus(-1, 2, true)).toBe(1);
    expect(cycleTabFocus(7, 2)).toBe(0);
  });

  it("returns -1 with no focusables", () => {
    expect(cycleTabFocus(0, 0)).toBe(-1);
    expect(cycleTabFocus(-1, 0, true)).toBe(-1);
  });

  it("stays on a single focusable", () => {
    expect(cycleTabFocus(0, 1)).toBe(0);
    expect(cycleTabFocus(0, 1, true)).toBe(0);
  });
});

const fakeDocument = () => {
  const style = { overflow: "", paddingInlineEnd: "" };
  return {
    body: { style },
    documentElement: { clientWidth: 1000 },
    defaultView: { innerWidth: 1015 },
  };
};

describe("scroll lock", () => {
  it("locks once and restores original overflow and padding", () => {
    const doc = fakeDocument();
    const lock = createScrollLock(doc);
    expect(lock.lock()).toBe(1);
    expect(doc.body.style.overflow).toBe("hidden");
    expect(doc.body.style.paddingInlineEnd).toBe("15px");
    expect(lock.unlock()).toBe(0);
    expect(doc.body.style.overflow).toBe("");
    expect(doc.body.style.paddingInlineEnd).toBe("");
  });

  it("is ref-counted for nested overlays", () => {
    const doc = fakeDocument();
    const lock = createScrollLock(doc);
    lock.lock();
    lock.lock();
    expect(lock.count).toBe(2);
    lock.unlock();
    expect(doc.body.style.overflow).toBe("hidden"); // still locked by inner overlay
    lock.unlock();
    expect(doc.body.style.overflow).toBe("");
  });

  it("is idempotent: extra unlocks are no-ops", () => {
    const doc = fakeDocument();
    const lock = createScrollLock(doc);
    lock.unlock();
    expect(lock.count).toBe(0);
    lock.lock();
    lock.unlock();
    lock.unlock();
    expect(doc.body.style.overflow).toBe("");
  });

  it("preserves an inline padding set before locking", () => {
    const doc = fakeDocument();
    doc.body.style.paddingInlineEnd = "3px";
    const lock = createScrollLock(doc);
    lock.lock();
    lock.unlock();
    expect(doc.body.style.paddingInlineEnd).toBe("3px");
  });

  it("adds no padding without a scrollbar", () => {
    const doc = fakeDocument();
    doc.defaultView.innerWidth = 1000;
    const lock = createScrollLock(doc);
    lock.lock();
    expect(doc.body.style.paddingInlineEnd).toBe("");
  });

  it("fails fast without a document body", () => {
    const lock = createScrollLock();
    expect(() => lock.lock(null)).toThrow();
  });
});

describe("dismiss stack", () => {
  it("dispatches Escape to the most recent overlay only", () => {
    const stack = createDismissStack();
    const a = () => "a";
    const b = () => "b";
    stack.push(a);
    stack.push(b);
    expect(stack.top()).toBe(b);
    stack.pop(b);
    expect(stack.top()).toBe(a);
    stack.pop(a);
    expect(stack.top()).toBeNull();
  });

  it("ignores pops of unknown handlers", () => {
    const stack = createDismissStack();
    const a = () => "a";
    stack.push(a);
    expect(stack.pop(() => "nope")).toBe(1);
    expect(stack.top()).toBe(a);
  });
});

describe("menu typeahead", () => {
  const labels = ["Change Log", "Theme", "Shutdown", "Logout"];
  it("matches a single character from the next item", () => {
    expect(matchMenuTypeahead(labels, "t", -1)).toBe(1);
    expect(matchMenuTypeahead(labels, "t", 1)).toBe(1); // only one T: cycles back to it
    expect(matchMenuTypeahead(labels, "s", -1)).toBe(2);
  });
  it("matches a multi-character prefix from the current item", () => {
    expect(matchMenuTypeahead(["Log in", "Log out", "Settings"], "log", 0)).toBe(0);
    expect(matchMenuTypeahead(["Log in", "Log out", "Settings"], "set", 0)).toBe(2);
  });
  it("repeats a single character to cycle between matches", () => {
    const many = ["A1", "B1", "B2", "C1"];
    expect(matchMenuTypeahead(many, "b", 0)).toBe(1);
    expect(matchMenuTypeahead(many, "bb", 1)).toBe(2);
    expect(matchMenuTypeahead(many, "bb", 2)).toBe(1); // wraps
  });
  it("is case-insensitive and returns the current index on no match", () => {
    expect(matchMenuTypeahead(labels, "THEME", -1)).toBe(1);
    expect(matchMenuTypeahead(labels, "zzz", 2)).toBe(2);
  });
  it("returns the current index for empty input", () => {
    expect(matchMenuTypeahead(labels, "", 1)).toBe(1);
    expect(matchMenuTypeahead([], "a", -1)).toBe(-1);
  });
  it("keeps a multi-char buffer as a prefix from the current item (recheck: s+h => Shutdown, not Theme)", () => {
    expect(matchMenuTypeahead(labels, "sh", 0)).toBe(2);
  });
});

describe("typeaheadStep", () => {
  const labels = ["Change Log", "Theme", "Shutdown", "Logout"];
  it("recheck: s then h within 500ms focuses Shutdown even if focus was still on Change Log", () => {
    const first = typeaheadStep(null, "s", 1000, labels, 0);
    expect(first.index).toBe(2);
    // Second key arrives before focus moved: currentIndex is still 0, but the
    // match continues from the session anchor (2) using prefix "sh".
    const second = typeaheadStep(first.session, "h", 1000 + TYPEAHEAD_TIMEOUT_MS - 1, labels, 0);
    expect(second.index).toBe(2);
    expect(second.session.buffer).toBe("sh");
  });
  it("single keystrokes search from the next item", () => {
    expect(typeaheadStep(null, "t", 0, labels, -1).index).toBe(1);
  });
  it("starts a new buffer after the timeout", () => {
    const first = typeaheadStep(null, "s", 0, labels, 0);
    expect(first.index).toBe(2);
    const second = typeaheadStep(first.session, "l", TYPEAHEAD_TIMEOUT_MS + 1, labels, 2);
    // "l" searches from after the focused Shutdown: Logout, then wraps to Change Log.
    expect(second.index).toBe(3);
    expect(second.session.buffer).toBe("l");
  });
  it("repeats one key to cycle same-initial matches", () => {
    const many = ["A1", "B1", "B2", "C1"];
    const first = typeaheadStep(null, "b", 0, many, 0);
    const second = typeaheadStep(first.session, "b", 100, many, first.index);
    expect(first.index).toBe(1);
    expect(second.index).toBe(2);
  });
  it("skips disabled matches", () => {
    const disabled = [false, false, true, false]; // Shutdown disabled
    const first = typeaheadStep(null, "s", 0, labels, 0, disabled);
    expect(first.index).toBe(0); // only Shutdown starts with "s", so no move
    const second = typeaheadStep(null, "t", 0, labels, 0, disabled);
    expect(second.index).toBe(1);
  });
});

describe("menuPosition", () => {
  const viewport = { width: 800, height: 600 };

  it("opens below the anchor with a gap", () => {
    const anchor = { top: 100, bottom: 140, left: 100, right: 144, width: 44, height: 40 };
    const pos = menuPosition(anchor, { width: 200, height: 150 }, "end", false, viewport);
    expect(pos.placement).toBe("bottom");
    expect(pos.top).toBe(144);
  });

  it("flips above when the panel would cover the trigger", () => {
    const anchor = { top: 500, bottom: 544, left: 100, right: 144, width: 44, height: 44 };
    const pos = menuPosition(anchor, { width: 200, height: 150 }, "end", false, viewport);
    expect(pos.placement).toBe("top");
    expect(pos.top + 150).toBeLessThan(anchor.top);
    expect(pos.top + 150).toBeLessThanOrEqual(anchor.top - 4);
  });

  it("stays below when it fits", () => {
    const anchor = { top: 300, bottom: 344, left: 100, right: 144, width: 44, height: 44 };
    const pos = menuPosition(anchor, { width: 200, height: 100 }, "end", false, viewport);
    expect(pos.placement).toBe("bottom");
  });

  it("never overlaps the anchor vertically", () => {
    const anchor = { top: 550, bottom: 590, left: 100, right: 144, width: 44, height: 40 };
    const panel = { width: 200, height: 200 };
    const pos = menuPosition(anchor, panel, "end", false, viewport);
    const panelBottom = pos.top + panel.height;
    const panelTop = pos.top;
    const overlaps = panelBottom > anchor.top && panelTop < anchor.bottom;
    expect(overlaps).toBe(false);
  });

  it("aligns end horizontally (start for rtl)", () => {
    const anchor = { top: 100, bottom: 140, left: 300, right: 344, width: 44, height: 40 };
    expect(menuPosition(anchor, { width: 200, height: 100 }, "end", false, viewport).left).toBe(
      144,
    );
    expect(menuPosition(anchor, { width: 200, height: 100 }, "end", true, viewport).left).toBe(300);
  });
});

describe("class maps", () => {
  it("resolves modal sizes and drawer widths, failing fast on typos", () => {
    expect(modalSizeClass("sm")).toBe("max-w-sm");
    expect(modalSizeClass("full")).toBe("max-w-4xl");
    expect(() => modalSizeClass("xxl")).toThrow();
    expect(drawerWidthClass("lg")).toBe("w-[600px] max-w-full");
    expect(drawerWidthClass("full")).toBe("w-full");
    expect(drawerWidthClass("nav")).toBe("w-[280px] max-w-[85vw]");
    expect(() => drawerWidthClass("huge")).toThrow();
  });

  it("uses logical properties for drawer sides", () => {
    expect(drawerSideClass("end")).toContain("end-0");
    expect(drawerSideClass("end")).toContain("border-s");
    expect(drawerSideClass("start")).toContain("start-0");
    expect(drawerSideClass("start")).toContain("border-e");
    expect(() => drawerSideClass("left")).toThrow();
  });

  it("maps legacy tooltip positions to logical sides and resolves variants", () => {
    expect(tooltipPositionClass("left")).toBe(tooltipPositionClass("start"));
    expect(tooltipPositionClass("right")).toBe(tooltipPositionClass("end"));
    expect(tooltipPositionClass("top")).toContain("bottom-full");
    expect(() => tooltipPositionClass("north")).toThrow();
    expect(tooltipVariantClass("err")).toBe("bg-err-bg text-err");
    expect(() => tooltipVariantClass("red")).toThrow();
  });
});

describe("trap stack", () => {
  it("exposes only the topmost trap (nested overlays trap inside-out)", () => {
    const outer = { id: "outer" };
    const inner = { id: "inner" };
    expect(trapStack.top()).toBeNull();
    trapStack.push(outer);
    trapStack.push(inner);
    expect(trapStack.top()).toBe(inner);
    trapStack.pop(inner);
    expect(trapStack.top()).toBe(outer);
    trapStack.pop(outer);
    expect(trapStack.top()).toBeNull();
  });
});

describe("isElementVisible", () => {
  it("needs layout boxes (getClientRects over offsetParent)", () => {
    const hidden = { getClientRects: () => [] };
    expect(isElementVisible(hidden)).toBe(false);
    expect(isElementVisible({})).toBe(false);
    expect(isElementVisible(null)).toBe(false);
  });
  it("uses checkVisibility when the browser has it", () => {
    const el = {
      getClientRects: () => [{}],
      checkVisibility: ({ visibilityProperty }) => visibilityProperty === true,
    };
    expect(isElementVisible(el)).toBe(true);
  });
  it("falls back to layout boxes without checkVisibility", () => {
    expect(isElementVisible({ getClientRects: () => [{}] })).toBe(true);
  });
});

describe("disabled-aware menu navigation", () => {
  it("roving skips disabled items in both directions", () => {
    const disabled = [true, false, true, false];
    expect(nextEnabledIndex(1, "ArrowRight", disabled, nextRovingIndex)).toBe(3);
    expect(nextEnabledIndex(3, "ArrowRight", disabled, nextRovingIndex)).toBe(1);
    expect(nextEnabledIndex(1, "ArrowLeft", disabled, nextRovingIndex)).toBe(3);
    expect(nextEnabledIndex(1, "Home", disabled, nextRovingIndex)).toBe(1);
    expect(nextEnabledIndex(1, "End", disabled, nextRovingIndex)).toBe(3);
  });
  it("keeps the index when every item is disabled", () => {
    expect(nextEnabledIndex(0, "ArrowRight", [true, true], nextRovingIndex)).toBe(0);
    expect(firstEnabledIndex([true, true])).toBe(-1);
  });
  it("finds the first enabled item from a start (forward or backward)", () => {
    expect(firstEnabledIndex([true, false, false], 0)).toBe(1);
    expect(firstEnabledIndex([false, true, true], 2, true)).toBe(0);
  });
  it("typeahead skips disabled matches", () => {
    const labels = ["Close", "Copy", "Cancel"];
    const disabled = [false, true, false];
    expect(matchMenuTypeahead(labels, "c", -1, disabled)).toBe(0); // not the disabled "Copy"
    expect(matchMenuTypeahead(labels, "co", -1, disabled)).toBe(-1); // only "Copy" matches, so no move
    expect(matchMenuTypeahead(labels, "ca", 0, disabled)).toBe(2);
  });
});

describe("floatingPosition", () => {
  const anchor = { top: 100, left: 200, right: 300, bottom: 130, width: 100, height: 30 };
  const panel = { width: 160, height: 80 };
  const viewport = { width: 1024, height: 768 };
  it("places bottom/top panels centered with a gap", () => {
    expect(floatingPosition(anchor, panel, "bottom", false, viewport)).toEqual({
      top: 136,
      left: 170,
    });
    expect(floatingPosition(anchor, panel, "top", false, viewport)).toEqual({ top: 14, left: 170 });
  });
  it("flips start/end under RTL and honors legacy left/right", () => {
    expect(floatingPosition(anchor, panel, "end", false, viewport).left).toBe(306);
    expect(floatingPosition(anchor, panel, "end", true, viewport).left).toBe(34);
    expect(floatingPosition(anchor, panel, "start", true, viewport).left).toBe(306);
    expect(floatingPosition(anchor, panel, "left", false, viewport).left).toBe(34);
    expect(floatingPosition(anchor, panel, "right", false, viewport).left).toBe(306);
  });
  it("clamps inside the viewport and rejects unknown placements", () => {
    const edge = { top: 700, left: 950, right: 1000, bottom: 740, width: 50, height: 40 };
    const pos = floatingPosition(edge, panel, "bottom", false, viewport);
    expect(pos.left).toBe(1024 - 160 - 8);
    expect(pos.top).toBeLessThanOrEqual(768 - 80 - 8);
    expect(() => floatingPosition(anchor, panel, "center", false, viewport)).toThrow();
  });
});

describe("reduced-motion CSS contract", () => {
  it("disables flow/pulse AND every overlay entry animation", () => {
    const css = readFileSync(resolve(TEST_DIR, "../../src/app/globals.css"), "utf8");
    const reduced = [];
    for (const match of css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g)) {
      let depth = 1;
      let i = match.index + match[0].length;
      for (; i < css.length && depth > 0; i += 1) {
        if (css[i] === "{") depth += 1;
        else if (css[i] === "}") depth -= 1;
      }
      reduced.push(css.slice(match.index, i));
    }
    const block = reduced.join("\n");
    for (const selector of [
      ".animate-flow",
      ".animate-pulse",
      ".signal-backdrop",
      ".signal-overlay",
      ".signal-overlay-drawer",
      ".signal-overlay-modal",
      ".signal-overlay-menu",
      ".signal-overlay-pop",
      ".signal-overlay-tip",
    ]) {
      expect(block, `missing ${selector}`).toContain(selector);
    }
    expect(block).toContain("animation: none");
  });

  it("reduced-motion block wins: it comes after the last overlay animation declaration", () => {
    const css = readFileSync(resolve(TEST_DIR, "../../src/app/globals.css"), "utf8");
    const mediaAt = [...css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)/g)].map(
      (m) => m.index,
    );
    expect(mediaAt.length, "no reduced-motion block").toBeGreaterThan(0);
    // Overlay rules that set a real animation (the reduced-motion ones set `none`).
    const animated = [
      ...css.matchAll(/\.(signal-backdrop|signal-overlay[-\w]*)\s*\{[^}]*animation:(?!\s*none)/g),
    ].map((m) => m.index);
    expect(animated.length, "no overlay animation rules").toBeGreaterThan(0);
    expect(Math.min(...mediaAt)).toBeGreaterThan(Math.max(...animated));
  });
});
