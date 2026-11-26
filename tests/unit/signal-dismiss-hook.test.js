// useDismiss across a busy → idle transition (YAN-2452). React commits the DOM
// and runs layout effects synchronously, but runs passive effects in a later
// task; an Esc in between must already see the idle phase. A tiny hooks
// harness stands in for React so the test can stop between those two steps.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDom } from "../helpers/signalFocusFakeDom.js";

const harness = vi.hoisted(() => {
  // The hook module picks useLayoutEffect only when `window` exists.
  const hadWindow = "window" in globalThis;
  globalThis.window ??= {};
  const slots = [];
  const queues = { layout: [], passive: [] };
  let index = 0;
  const slotAt = (i, init) => {
    if (!slots[i]) slots[i] = init;
    return slots[i];
  };
  const changed = (prev, next) =>
    !prev || !next || prev.length !== next.length || prev.some((v, i) => !Object.is(v, next[i]));
  const effect = (kind) => (fn, deps) => {
    const i = index++;
    const slot = slotAt(i, { kind, deps: undefined, cleanup: undefined });
    if (changed(slot.deps, deps)) queues[kind].push({ slot, fn, deps });
  };
  const flush = (kind) => {
    for (const { slot, fn, deps } of queues[kind].splice(0)) {
      slot.cleanup?.();
      slot.cleanup = fn() ?? undefined;
      slot.deps = deps;
    }
  };
  return {
    react: {
      useRef: (init) => {
        const i = index++;
        return slotAt(i, { current: init });
      },
      useCallback: (fn) => fn,
      useId: () => "id",
      useState: (init) => [init, () => {}],
      useEffect: effect("passive"),
      useLayoutEffect: effect("layout"),
    },
    /** Render + commit: layout effects run, passive effects stay queued. */
    commit(hook, props) {
      index = 0;
      hook(props);
      flush("layout");
    },
    flushPassive: () => flush("passive"),
    restoreWindow() {
      if (!hadWindow) delete globalThis.window;
    },
    unmount() {
      for (const slot of slots) if (typeof slot.cleanup === "function") slot.cleanup();
      slots.length = 0;
      queues.layout.length = 0;
      queues.passive.length = 0;
    },
  };
});

vi.mock("react", () => harness.react);
vi.mock("react-dom", () => ({ createPortal: () => null }));

let useDismiss;
beforeAll(async () => {
  ({ useDismiss } = await import("../../src/shared/hooks/useOverlay.js"));
});

afterEach(() => {
  harness.unmount();
  delete globalThis.document;
});
afterAll(() => harness.restoreWindow());

function setup() {
  const dom = createDom();
  globalThis.document = dom.doc;
  const panel = dom.el("div");
  dom.doc.body.appendChild(panel);
  // Callers pass a stable useRef object; a fresh one per render would itself
  // re-register the layer and hide the behavior under test.
  const containerRef = { current: panel };
  const added = [];
  const add = dom.doc.addEventListener.bind(dom.doc);
  dom.doc.addEventListener = (type, fn, capture) => {
    added.push(type);
    add(type, fn, capture);
  };
  const closed = [];
  const props = (busy) => ({
    onClose: () => closed.push("modal"),
    containerRef,
    closeOnEscape: !busy,
    closeOnOutside: !busy,
  });
  return { dom, closed, props, added };
}

describe("useDismiss busy → idle", () => {
  it("Esc closes once the idle phase commits, before passive effects run", () => {
    const { dom, closed, props } = setup();
    harness.commit(useDismiss, props(true));
    harness.flushPassive();
    dom.key("Escape");
    expect(closed).toEqual([]);

    harness.commit(useDismiss, props(false)); // preview settled; effects not yet flushed
    dom.key("Escape");
    expect(closed).toEqual(["modal"]);
  });

  it("outside press follows the same committed phase", () => {
    const { dom, closed, props } = setup();
    harness.commit(useDismiss, props(true));
    harness.flushPassive();
    dom.doc.dispatch({ type: "pointerdown", target: dom.doc.body });
    expect(closed).toEqual([]);

    harness.commit(useDismiss, props(false));
    dom.doc.dispatch({ type: "pointerdown", target: dom.doc.body });
    expect(closed).toEqual(["modal"]);
  });

  it("idle → busy blocks Esc as soon as it commits, and the layer never re-registers", () => {
    const { dom, closed, props, added } = setup();
    harness.commit(useDismiss, props(false));
    harness.flushPassive();
    expect(added).toEqual(["keydown", "pointerdown"]);

    harness.commit(useDismiss, props(true));
    dom.key("Escape");
    expect(closed).toEqual([]);
    harness.flushPassive();
    harness.commit(useDismiss, props(false));
    harness.flushPassive();
    expect(added).toEqual(["keydown", "pointerdown"]);

    harness.unmount();
    expect(dom.listenerCount()).toBe(0);
  });
});

// YAN-2462: the layer itself must register in the commit that opens the
// overlay, not in a later passive-effect task, or an Esc in that gap is dropped.
describe("useDismiss open → immediate dismiss", () => {
  const open = (props, enabled) => ({ ...props(false), enabled });

  it("Esc closes in the commit that opens the overlay, before passive effects run", () => {
    const { dom, closed, props } = setup();
    harness.commit(useDismiss, open(props, false));
    harness.flushPassive();
    dom.key("Escape");
    expect(closed).toEqual([]);

    harness.commit(useDismiss, open(props, true)); // panel committed; effects not yet flushed
    dom.key("Escape");
    expect(closed).toEqual(["modal"]);
  });

  it("outside press closes in the opening commit too", () => {
    const { dom, closed, props } = setup();
    harness.commit(useDismiss, open(props, true));
    dom.doc.dispatch({ type: "pointerdown", target: dom.doc.body });
    expect(closed).toEqual(["modal"]);
  });

  it("closing unregisters in the commit, so a stale layer never sees Esc", () => {
    const { dom, closed, props } = setup();
    harness.commit(useDismiss, open(props, true));
    harness.commit(useDismiss, open(props, false));
    dom.key("Escape");
    expect(closed).toEqual([]);
    expect(dom.listenerCount()).toBe(0);
  });

  it("the Esc whose handler opens the overlay does not also close it", () => {
    const { dom, closed, props } = setup();
    harness.commit(useDismiss, open(props, false));
    harness.flushPassive();
    // Stand-in for a React keydown handler that opens a dialog on Esc and
    // commits before the event reaches the document listeners.
    dom.win.addEventListener("keydown", () => harness.commit(useDismiss, open(props, true)), true);
    dom.key("Escape");
    expect(closed).toEqual([]);
    expect(dom.win.event).toBeUndefined();
  });

  it("a nested overlay opened over a settled one takes Esc first, before passive effects", () => {
    const { dom, props } = setup();
    const closed = [];
    const layer = (name, enabled) => ({
      ...props(false),
      onClose: () => closed.push(name),
      enabled,
    });
    // React runs a child's effects before its parent's; mirror that order.
    const nested = ({ outer, inner }) => {
      useDismiss(layer("inner", inner));
      useDismiss(layer("outer", outer));
    };
    harness.commit(nested, { outer: true, inner: false });
    harness.flushPassive();

    harness.commit(nested, { outer: true, inner: true }); // inner's trap still pending
    dom.key("Escape");
    expect(closed).toEqual(["inner"]);
  });
});
