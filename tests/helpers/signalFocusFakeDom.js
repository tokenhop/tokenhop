// Fake DOM shared by the overlay focus tests (split from unit/signal-overlay-focus.test.js).
import { FOCUSABLE, mountPortalNode } from "../../src/shared/hooks/useOverlay.js";
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

export { createDom, mountDialog, name };
