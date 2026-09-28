// Overlay focus/dismiss behavior on a tiny in-test fake DOM (node env, no DOM
// dependency). Exercises the same controllers Modal, Drawer and Tooltip mount:
// createFocusTrap, createDismissLayer, createEscapeGuard, mountPortalNode.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createDismissStack,
  tooltipVisible,
} from "../../src/shared/components/overlayPrimitives.js";
import {
  FOCUSABLE,
  createDismissLayer,
  createEscapeGuard,
  createFocusTrap,
  isLaterPortalPress,
  mountPortalNode,
  restoreFocus,
} from "../../src/shared/hooks/useOverlay.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- fake DOM: only what the controllers touch ------------------------------
class Target {
  listeners = [];
  addEventListener(type, fn, capture = false) {
    this.listeners.push({ type, fn, capture: Boolean(capture) });
  }
  removeEventListener(type, fn, capture = false) {
    const i = this.listeners.findIndex(
      (l) => l.type === type && l.fn === fn && l.capture === Boolean(capture),
    );
    if (i >= 0) this.listeners.splice(i, 1);
  }
  fire(event, capture) {
    for (const l of [...this.listeners]) {
      if (l.type === event.type && l.capture === capture) l.fn(event);
    }
  }
}

class El {
  constructor(doc, tag, attrs = {}) {
    this.doc = doc;
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parent = null;
    this.hidden = false;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  hasAttribute(k) {
    return k in this.attrs;
  }
  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    this.doc.mutated(this);
    return child;
  }
  append(...kids) {
    for (const kid of kids) this.appendChild(kid);
    return this;
  }
  removeChild(child) {
    child.remove();
    return child;
  }
  remove() {
    const parent = this.parent;
    if (!parent) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parent = null;
    // Browsers move focus to <body> silently when the focused node goes away.
    if (this.contains(this.doc.activeElement)) this.doc.activeElement = this.doc.body;
    this.doc.mutated(parent);
  }
  get isConnected() {
    let n = this;
    while (n.parent) n = n.parent;
    return n === this.doc.root;
  }
  contains(other) {
    for (let n = other; n; n = n.parent) if (n === this) return true;
    return false;
  }
  closest(selector) {
    const attr = selector.match(/^\[([\w-]+)\]$/)?.[1];
    if (!attr) throw new Error(`fake closest: unsupported ${selector}`);
    for (let n = this; n; n = n.parent) if (n.hasAttribute(attr)) return n;
    return null;
  }
  get focusable() {
    const tab = this.getAttribute("tabindex");
    if (["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(this.tagName)) {
      return !this.hasAttribute("disabled");
    }
    if (this.tagName === "A" && this.hasAttribute("href")) return true;
    return tab !== null && tab !== "-1";
  }
  descendants() {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }
  querySelectorAll(selector) {
    if (selector !== FOCUSABLE) throw new Error("fake querySelectorAll: FOCUSABLE only");
    return this.descendants().filter((e) => e.focusable);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  getClientRects() {
    return this.hidden ? [] : [{}];
  }
  compareDocumentPosition(other) {
    const order = this.doc.root.descendants();
    return order.indexOf(other) > order.indexOf(this) ? 4 : 2;
  }
  focus() {
    if (!this.isConnected) return;
    this.doc.activeElement = this;
    this.doc.dispatch({ type: "focusin", target: this });
  }
}

function createDom() {
  const win = new Target();
  const doc = new Target();
  const observers = new Set();
  doc.defaultView = win;
  doc.mutated = (node) => {
    for (const o of observers) {
      if (o.target.contains(node) && !o.pending) {
        o.pending = true;
        queueMicrotask(() => {
          o.pending = false;
          if (observers.has(o)) o.cb([]);
        });
      }
    }
  };
  win.MutationObserver = class {
    constructor(cb) {
      this.cb = cb;
    }
    observe(target) {
      this.target = target;
      observers.add(this);
    }
    disconnect() {
      observers.delete(this);
    }
  };
  doc.root = new El(doc, "html");
  doc.body = new El(doc, "body");
  doc.root.appendChild(doc.body);
  doc.activeElement = doc.body;
  doc.createElement = (tag) => new El(doc, tag);
  // window capture -> document capture -> document bubble; stopPropagation
  // skips the remaining targets, like the real event path.
  doc.dispatch = (init) => {
    let stopped = false;
    let prevented = Boolean(init.defaultPrevented);
    const event = {
      ...init,
      get defaultPrevented() {
        return prevented;
      },
      stopPropagation: () => {
        stopped = true;
      },
      preventDefault: () => {
        prevented = true;
      },
    };
    for (const [target, capture] of [
      [win, true],
      [doc, true],
      [doc, false],
    ]) {
      if (stopped) break;
      target.fire(event, capture);
    }
    return { prevented, stopped };
  };
  const el = (tag, attrs, ...kids) => new El(doc, tag, attrs).append(...kids);
  const key = (k, shiftKey = false) =>
    doc.dispatch({ type: "keydown", key: k, shiftKey, target: doc.activeElement });
  const listenerCount = () => doc.listeners.length + win.listeners.length;
  return { doc, win, el, key, listenerCount };
}

/** Mount what Modal/Drawer render: a portal host with a tabindex=-1 dialog panel. */
function mountDialog(dom, ...kids) {
  const host = mountPortalNode(dom.doc);
  const panel = dom.el("div", { role: "dialog", "aria-modal": "true", tabindex: "-1" }, ...kids);
  host.appendChild(panel);
  return { host, panel };
}

const name = (dom) =>
  dom.doc.activeElement?.getAttribute("data-t") ?? dom.doc.activeElement?.tagName;

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

describe("dismiss layers and tooltip Esc", () => {
  it("Esc reaching the document bubble lets the topmost bubble-layer close", () => {
    const dom = createDom();
    const stack = createDismissStack();
    const closed = [];
    const outerEl = dom.el("div", { "data-t": "outer" });
    const innerEl = dom.el("div", { "data-t": "inner" });
    dom.doc.body.append(outerEl, innerEl);
    createDismissLayer({
      doc: dom.doc,
      stack,
      onClose: () => closed.push("outer"),
      getContainer: () => outerEl,
    });
    createDismissLayer({
      doc: dom.doc,
      stack,
      onClose: () => closed.push("inner"),
      getContainer: () => innerEl,
    });
    dom.key("Escape");
    expect(closed).toEqual(["inner"]);
  });

  it("an inline editor's preventDefault keeps its dialog open", () => {
    const dom = createDom();
    const stack = createDismissStack();
    const closed = [];
    const panel = dom.el("div");
    const field = dom.el("input", { "data-t": "field" });
    panel.appendChild(field);
    dom.doc.body.append(panel);
    createDismissLayer({ doc: dom.doc, stack, onClose: () => closed.push("modal") });
    // React root listener (target phase) runs first, cancels the editor's Esc.
    field.focus();
    dom.doc.dispatch({ type: "keydown", key: "Escape", target: field, defaultPrevented: true });
    expect(closed).toEqual([]);
  });

  it("nested layers: Esc and outside press close only the topmost", () => {
    const dom = createDom();
    const stack = createDismissStack();
    const closed = [];
    const outer = dom.el("div");
    const inner = dom.el("div");
    dom.doc.body.append(outer, inner);
    const offOuter = createDismissLayer({
      doc: dom.doc,
      stack,
      onClose: () => closed.push("outer"),
      getContainer: () => outer,
    });
    const offInner = createDismissLayer({
      doc: dom.doc,
      stack,
      onClose: () => closed.push("inner"),
      getContainer: () => inner,
    });
    dom.key("Escape");
    expect(closed).toEqual(["inner"]);
    dom.doc.dispatch({ type: "pointerdown", target: dom.doc.body });
    expect(closed).toEqual(["inner", "inner"]);
    offInner();
    dom.key("Escape");
    expect(closed).toEqual(["inner", "inner", "outer"]);
    offOuter();
    expect(dom.listenerCount()).toBe(0);
  });

  it("Esc with a tooltip open inside a modal closes the tooltip first, the modal next", () => {
    const dom = createDom();
    const stack = createDismissStack();
    const closed = [];
    const offModal = createDismissLayer({
      doc: dom.doc,
      stack,
      onClose: () => closed.push("modal"),
    });
    const offTip = createEscapeGuard(dom.win, () => closed.push("tip"));
    dom.key("Escape");
    expect(closed).toEqual(["tip"]);
    offTip();
    dom.key("Escape");
    expect(closed).toEqual(["tip", "modal"]);
    offModal();
    expect(dom.listenerCount()).toBe(0);
  });

  it("an open tooltip does not block the modal's outside-press close", () => {
    const dom = createDom();
    const stack = createDismissStack();
    const panel = dom.doc.body.appendChild(dom.el("div"));
    const closed = [];
    createDismissLayer({
      doc: dom.doc,
      stack,
      onClose: () => closed.push("modal"),
      getContainer: () => panel,
    });
    createEscapeGuard(dom.win, () => closed.push("tip"));
    dom.doc.dispatch({ type: "pointerdown", target: dom.doc.body });
    expect(closed).toEqual(["modal"]);
  });

  it("a press inside a menu portaled after the dialog does not close the parent", () => {
    const dom = createDom();
    const stack = createDismissStack();
    const closed = [];
    const { panel } = mountDialog(
      dom,
      dom.el("button", { "data-t": "a" }),
      dom.el("button", { "data-t": "b" }),
    );
    createDismissLayer({
      doc: dom.doc,
      stack,
      onClose: () => closed.push("dialog"),
      getContainer: () => panel,
    });
    // Menu/popover opened from within the dialog: portaled after it.
    const menuHost = mountPortalNode(dom.doc);
    const item = menuHost.appendChild(dom.el("button", { "data-t": "menu-item" }));
    dom.doc.dispatch({ type: "pointerdown", target: item });
    expect(closed).toEqual([]);
  });

  it("a press on the page behind the dialog still closes it", () => {
    const dom = createDom();
    const stack = createDismissStack();
    const closed = [];
    const { panel } = mountDialog(dom, dom.el("button", { "data-t": "a" }));
    createDismissLayer({
      doc: dom.doc,
      stack,
      onClose: () => closed.push("dialog"),
      getContainer: () => panel,
    });
    const behind = dom.el("button", { "data-t": "behind" });
    dom.doc.body.appendChild(behind);
    dom.doc.dispatch({ type: "pointerdown", target: behind });
    expect(closed).toEqual(["dialog"]);
  });

  it("isLaterPortalPress matches the focus trap's later-portal rule", () => {
    const dom = createDom();
    const { panel } = mountDialog(dom, dom.el("button", { "data-t": "a" }));
    const laterHost = mountPortalNode(dom.doc);
    const laterItem = laterHost.appendChild(dom.el("button", { "data-t": "later" }));
    const earlierHost = dom.doc.body.children[0]; // body content before the dialog portal
    expect(isLaterPortalPress(panel, laterItem)).toBe(true);
    expect(isLaterPortalPress(panel, panel.children[0])).toBe(false);
    expect(isLaterPortalPress(panel, dom.doc.body)).toBe(false);
    expect(isLaterPortalPress(panel, null)).toBe(false);
    expect(isLaterPortalPress(null, laterItem)).toBe(false);
    expect(earlierHost).toBeDefined();
  });
});

describe("component wiring", () => {
  for (const file of ["Modal.js", "Drawer.js"]) {
    it(`${file} portals a tabindex=-1 modal dialog wired to the trap and dismiss hooks`, () => {
      const src = readFileSync(resolve(SRC, "shared/components", file), "utf8");
      for (const needle of [
        "<Portal>",
        'role="dialog"',
        'aria-modal="true"',
        "tabIndex={-1}",
        "useFocusTrap({ container: panel, active: open, initialFocusRef })",
        "ref={setPanelNode}",
        "useDismiss({",
        "useScrollLock(open)",
      ]) {
        expect(src, `${file} missing ${needle}`).toContain(needle);
      }
    });
  }

  it("Tooltip uses the Esc guard and hides via tooltipVisible", () => {
    const src = readFileSync(resolve(SRC, "shared/components/Tooltip.js"), "utf8");
    expect(src).toContain("createEscapeGuard(window");
    expect(src).toContain("tooltipVisible(openState, disabled, text)");
    expect(src).not.toMatch(/document\.addEventListener\("keydown"/);
  });

  it("useFocusTrap has no frame-retry attach (panel node drives it)", () => {
    const src = readFileSync(resolve(SRC, "shared/hooks/useOverlay.js"), "utf8");
    expect(src).not.toContain("requestAnimationFrame");
    expect(src).not.toContain("MOUNT_RETRY_FRAMES");
  });

  for (const [file, needle] of [
    ["shared/components/ComboFormModal.js", 'if (e.key === "Escape") {\n      e.preventDefault();'],
    [
      "shared/components/combos/ComboEditor.js",
      'if (e.key === "Escape") {\n                    // Claim Esc for the inline rename',
    ],
    [
      "app/(dashboard)/dashboard/providers/components/ConnectionsCard.js",
      'else if (e.key === "Escape") {\n                      e.preventDefault();',
    ],
  ]) {
    it(`${file}: inline editor claims Esc so the parent dialog stays open`, () => {
      expect(readFileSync(resolve(SRC, file), "utf8")).toContain(needle);
    });
  }
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
