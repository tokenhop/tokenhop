// useDismiss across a busy → idle transition (YAN-2452). React commits the DOM
// and runs layout effects synchronously, but runs passive effects in a later
// task; an Esc in between must already see the idle phase. A tiny hooks
// harness stands in for React so the test can stop between those two steps.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDom } from "../helpers/signalFocusFakeDom.js";

const harness = vi.hoisted(() => {
  // The hook module picks useLayoutEffect only when `window` exists.
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

function setup() {
  const dom = createDom();
  globalThis.document = dom.doc;
  const panel = dom.el("div");
  dom.doc.body.appendChild(panel);
  const closed = [];
  const props = (busy) => ({
    onClose: () => closed.push("modal"),
    containerRef: { current: panel },
    closeOnEscape: !busy,
    closeOnOutside: !busy,
  });
  return { dom, closed, props };
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
    const { dom, closed, props } = setup();
    harness.commit(useDismiss, props(false));
    harness.flushPassive();
    const listeners = dom.listenerCount();

    harness.commit(useDismiss, props(true));
    dom.key("Escape");
    expect(closed).toEqual([]);
    harness.flushPassive();
    expect(dom.listenerCount()).toBe(listeners);

    harness.unmount();
    expect(dom.listenerCount()).toBe(0);
  });
});
