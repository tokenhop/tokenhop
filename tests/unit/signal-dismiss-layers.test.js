// Dismiss layers, tooltip Esc and later-portal presses on the shared fake DOM
// (split from signal-overlay-focus.test.js to keep both files under 500 lines).
import { describe, expect, it } from "vitest";
import { createDismissStack } from "../../src/shared/components/overlayPrimitives.js";
import {
  createDismissLayer,
  createEscapeGuard,
  isLaterPortalPress,
  mountPortalNode,
} from "../../src/shared/hooks/useOverlay.js";
import { createDom, mountDialog } from "../helpers/signalFocusFakeDom.js";

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
