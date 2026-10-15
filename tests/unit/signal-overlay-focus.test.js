// Overlay focus/dismiss behavior on a tiny in-test fake DOM (node env, no DOM
// dependency). Exercises the same controllers Modal, Drawer and Tooltip mount:
// createFocusTrap, createDismissLayer, createEscapeGuard, mountPortalNode.
import { describe, expect, it } from "vitest";
import {
  createDismissStack,
  tooltipVisible,
} from "../../src/shared/components/overlayPrimitives.js";
import {
  createFocusTrap,
  mountPortalNode,
  restoreFocus,
} from "../../src/shared/hooks/useOverlay.js";
import { createDom, mountDialog, name } from "../helpers/signalFocusFakeDom.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- tests ------------------------------------------------------------------
describe("Modal/Drawer focus trap", () => {
  const setup = () => {
    const dom = createDom();
    const opener = dom.el("button", { "data-t": "opener" });
    const outside = dom.el("button", { "data-t": "outside" });
    dom.doc.body.append(opener, outside);
    opener.focus();
    const stack = createDismissStack();
    return { dom, opener, outside, stack };
  };

  it("mounts into a body-level portal and focuses the panel", () => {
    const { dom, stack } = setup();
    const { host, panel } = mountDialog(dom, dom.el("button", { "data-t": "a" }));
    expect(host.parent).toBe(dom.doc.body);
    expect(host.hasAttribute("data-signal-portal")).toBe(true);
    createFocusTrap({ doc: dom.doc, container: panel, stack });
    expect(dom.doc.activeElement).toBe(panel);
  });

  it("honors initialFocusRef", () => {
    const { dom, stack } = setup();
    const b = dom.el("button", { "data-t": "b" });
    const { panel } = mountDialog(dom, dom.el("button", { "data-t": "a" }), b);
    createFocusTrap({ doc: dom.doc, container: panel, getInitialFocus: () => b, stack });
    expect(name(dom)).toBe("b");
  });

  it("Tab and Shift+Tab cycle inside, skipping hidden and disabled items", () => {
    const { dom, stack } = setup();
    const hidden = dom.el("button", { "data-t": "hidden" });
    hidden.hidden = true;
    const { panel } = mountDialog(
      dom,
      dom.el("button", { "data-t": "a" }),
      hidden,
      dom.el("button", { "data-t": "off", disabled: "" }),
      dom.el("button", { "data-t": "c" }),
    );
    createFocusTrap({ doc: dom.doc, container: panel, stack });
    expect(dom.key("Tab").prevented).toBe(true);
    expect(name(dom)).toBe("a");
    dom.key("Tab");
    expect(name(dom)).toBe("c");
    dom.key("Tab");
    expect(name(dom)).toBe("a");
    dom.key("Tab", true);
    expect(name(dom)).toBe("c");
    expect(dom.key("Enter").prevented).toBe(false);
  });

  it("pulls focus that escapes to the page back to the last focused item", () => {
    const { dom, outside, stack } = setup();
    const { panel } = mountDialog(
      dom,
      dom.el("button", { "data-t": "a" }),
      dom.el("button", { "data-t": "b" }),
    );
    createFocusTrap({ doc: dom.doc, container: panel, stack });
    dom.key("Tab");
    dom.key("Tab");
    outside.focus();
    expect(name(dom)).toBe("b");
  });

  it("falls back to the panel when nothing inside was focused yet", () => {
    const { dom, outside, stack } = setup();
    const { panel } = mountDialog(dom, dom.el("button", { "data-t": "a" }));
    createFocusTrap({ doc: dom.doc, container: panel, stack });
    outside.focus();
    expect(dom.doc.activeElement).toBe(panel);
  });

  it("lets focus move into overlays portaled after it (menu from a dialog)", () => {
    const { dom, stack } = setup();
    const { panel } = mountDialog(dom, dom.el("button", { "data-t": "a" }));
    createFocusTrap({ doc: dom.doc, container: panel, stack });
    const menuHost = mountPortalNode(dom.doc);
    const item = menuHost.appendChild(dom.el("button", { "data-t": "menu-item" }));
    item.focus();
    expect(name(dom)).toBe("menu-item");
  });

  it("Tab inside a later-portaled popover stays with the popover", () => {
    const { dom, stack } = setup();
    const { panel } = mountDialog(dom, dom.el("button", { "data-t": "a" }));
    createFocusTrap({ doc: dom.doc, container: panel, stack });
    const popHost = mountPortalNode(dom.doc);
    const field = popHost.appendChild(dom.el("input", { "data-t": "pop-field" }));
    field.focus();
    expect(dom.key("Tab").prevented).toBe(false); // browser moves focus natively
    expect(name(dom)).toBe("pop-field");
  });

  it("keeps an autoFocus target and returns to the real opener (returnFocusTo)", async () => {
    const { dom, stack } = setup();
    const auto = dom.el("input", { "data-t": "auto" });
    const { panel, host } = mountDialog(dom, dom.el("button", { "data-t": "a" }), auto);
    auto.focus(); // React autoFocus runs before the trap attaches
    const trap = createFocusTrap({
      doc: dom.doc,
      container: panel,
      returnFocusTo: dom.doc.body.children[0],
      stack,
    });
    expect(name(dom)).toBe("auto");
    trap.release();
    host.remove();
    await tick();
    expect(name(dom)).toBe("opener");
  });

  it("moves focus back to the panel when the focused step unmounts", async () => {
    const { dom, stack } = setup();
    const step = dom.el("button", { "data-t": "next" });
    const { panel } = mountDialog(dom, step);
    createFocusTrap({ doc: dom.doc, container: panel, stack });
    step.focus();
    step.remove();
    expect(dom.doc.activeElement).toBe(dom.doc.body);
    await tick();
    expect(dom.doc.activeElement).toBe(panel);
  });

  it("returns focus to the opener and removes every listener on release", async () => {
    const { dom, stack } = setup();
    const before = dom.listenerCount();
    const step = dom.el("button", { "data-t": "a" });
    const { panel, host } = mountDialog(dom, step);
    const trap = createFocusTrap({ doc: dom.doc, container: panel, stack });
    trap.release();
    host.remove();
    await tick();
    expect(name(dom)).toBe("opener");
    expect(dom.listenerCount()).toBe(before);
    expect(stack.top()).toBeNull();
    trap.release(); // idempotent
    expect(name(dom)).toBe("opener");
  });

  it("inner dialog whose opener unmounted returns focus to the outer trap's last item", async () => {
    const { dom, stack } = setup();
    const outerA = dom.el("button", { "data-t": "outer-a" });
    const openInner = dom.el("button", { "data-t": "open-inner" });
    const outer = mountDialog(dom, outerA, openInner);
    createFocusTrap({ doc: dom.doc, container: outer.panel, stack });
    outerA.focus(); // last focused item in the outer dialog
    openInner.focus();
    const inner = mountDialog(dom, dom.el("button", { "data-t": "inner-a" }));
    const innerTrap = createFocusTrap({
      doc: dom.doc,
      container: inner.panel,
      returnFocusTo: openInner,
      stack,
    });
    openInner.remove(); // e.g. "delete row": the trigger goes with the confirm
    innerTrap.release();
    inner.host.remove();
    await tick();
    // openInner was the outer's lastInside and is gone, so the outer panel takes focus.
    expect(dom.doc.activeElement).toBe(outer.panel);
  });

  it("inner dialog with a live opener outside the remaining trap refocuses that trap", async () => {
    const { dom, outside, stack } = setup();
    const outerA = dom.el("button", { "data-t": "outer-a" });
    const outer = mountDialog(dom, outerA);
    createFocusTrap({ doc: dom.doc, container: outer.panel, stack });
    outerA.focus();
    const inner = mountDialog(dom, dom.el("button", { "data-t": "inner-a" }));
    // Opened from the page, not from the outer dialog: still behind the outer trap.
    const innerTrap = createFocusTrap({
      doc: dom.doc,
      container: inner.panel,
      returnFocusTo: outside,
      stack,
    });
    innerTrap.release();
    inner.host.remove();
    await tick();
    expect(name(dom)).toBe("outer-a");
  });

  it("nested dialogs closing in one commit return focus to the outer opener", async () => {
    const { dom, stack } = setup();
    const openInner = dom.el("button", { "data-t": "open-inner" });
    const outer = mountDialog(dom, dom.el("button", { "data-t": "outer-a" }), openInner);
    const outerTrap = createFocusTrap({ doc: dom.doc, container: outer.panel, stack });
    openInner.focus();
    const inner = mountDialog(dom, dom.el("button", { "data-t": "inner-a" }));
    const innerTrap = createFocusTrap({ doc: dom.doc, container: inner.panel, stack });
    // ConfirmDialog whose confirm closes its parent too: React tears both down
    // in one commit (outer effects first), then the portals go.
    outerTrap.release();
    innerTrap.release();
    inner.host.remove();
    outer.host.remove();
    await tick();
    expect(name(dom)).toBe("opener");
    expect(stack.top()).toBeNull();
  });

  it("reads the preferred return target at release, overriding a connected opener without scrolling", async () => {
    const { dom, stack } = setup();
    const heading = dom.el("h2", { tabindex: "-1" });
    dom.doc.body.append(heading);
    let options;
    const focus = heading.focus.bind(heading);
    heading.focus = (value) => {
      options = value;
      focus();
    };
    const preferred = { current: null };
    const { panel, host } = mountDialog(dom);
    const trap = createFocusTrap({
      doc: dom.doc,
      container: panel,
      stack,
      getReturnFocus: () => preferred.current,
    });
    preferred.current = heading;
    trap.release();
    host.remove();
    await tick();
    expect(dom.doc.activeElement).toBe(heading);
    expect(options).toEqual({ preventScroll: true });
  });

  it("falls back to the original opener when the preferred target disconnected", async () => {
    const { dom, opener, stack } = setup();
    const { panel, host } = mountDialog(dom);
    const trap = createFocusTrap({
      doc: dom.doc,
      container: panel,
      stack,
      getReturnFocus: () => dom.el("h2"),
    });
    trap.release();
    host.remove();
    await tick();
    expect(dom.doc.activeElement).toBe(opener);
  });

  it("contains preferred restoration inside the remaining top trap", async () => {
    const { dom, outside, stack } = setup();
    const outer = mountDialog(dom, dom.el("button", { "data-t": "outer-item" }));
    createFocusTrap({ doc: dom.doc, container: outer.panel, stack });
    outer.panel.children[0].focus();
    const inner = mountDialog(dom);
    const trap = createFocusTrap({
      doc: dom.doc,
      container: inner.panel,
      stack,
      getReturnFocus: () => outside,
    });
    trap.release();
    inner.host.remove();
    await tick();
    expect(name(dom)).toBe("outer-item");
  });

  it("restores a preferred heading inside the remaining top trap", async () => {
    const { dom, stack } = setup();
    const heading = dom.el("h2", { tabindex: "-1" });
    const outer = mountDialog(dom, heading);
    createFocusTrap({ doc: dom.doc, container: outer.panel, stack });
    const inner = mountDialog(dom);
    const trap = createFocusTrap({
      doc: dom.doc,
      container: inner.panel,
      stack,
      getReturnFocus: () => heading,
    });
    trap.release();
    inner.host.remove();
    await tick();
    expect(dom.doc.activeElement).toBe(heading);
  });

  it("restoreFocus with no trap and a disconnected opener leaves focus alone, no throw", () => {
    const { dom, stack } = setup();
    const gone = dom.el("button", { "data-t": "gone" });
    expect(() => restoreFocus(stack, gone)).not.toThrow();
    expect(() => restoreFocus(stack, null)).not.toThrow();
    expect(name(dom)).toBe("opener");
  });

  it("nested dialogs: inner trap wins, outer resumes after the inner closes", async () => {
    const { dom, outside, stack } = setup();
    const openInner = dom.el("button", { "data-t": "open-inner" });
    const outer = mountDialog(dom, dom.el("button", { "data-t": "outer-a" }), openInner);
    const outerTrap = createFocusTrap({ doc: dom.doc, container: outer.panel, stack });
    openInner.focus();

    const inner = mountDialog(dom, dom.el("button", { "data-t": "inner-a" }));
    const innerTrap = createFocusTrap({ doc: dom.doc, container: inner.panel, stack });
    expect(dom.doc.activeElement).toBe(inner.panel);
    dom.key("Tab");
    expect(name(dom)).toBe("inner-a");
    outer.panel.children[0].focus(); // click into the outer dialog behind
    expect(name(dom)).toBe("inner-a");
    outside.focus();
    expect(name(dom)).toBe("inner-a");

    innerTrap.release();
    inner.host.remove();
    await tick();
    expect(name(dom)).toBe("open-inner");
    dom.key("Tab");
    expect(name(dom)).toBe("outer-a");
    outside.focus();
    expect(name(dom)).toBe("outer-a");

    outerTrap.release();
    outer.host.remove();
    await tick();
    expect(name(dom)).toBe("opener");
    expect(stack.top()).toBeNull();
    outside.focus();
    expect(name(dom)).toBe("outside"); // no trap left behind
  });
});

describe("tooltipVisible", () => {
  it("hides when disabled or the text is empty while open", () => {
    expect(tooltipVisible(true, false, "hi")).toBe(true);
    expect(tooltipVisible(true, true, "hi")).toBe(false);
    expect(tooltipVisible(true, false, "")).toBe(false);
    expect(tooltipVisible(true, false, null)).toBe(false);
    expect(tooltipVisible(true, false, undefined)).toBe(false);
    expect(tooltipVisible(true, false, false)).toBe(false);
    expect(tooltipVisible(false, false, "hi")).toBe(false);
    expect(tooltipVisible(true, false, 0)).toBe(true); // a real node/number still shows
  });
});
