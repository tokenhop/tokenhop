"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import {
  cycleTabFocus,
  dismissStack,
  isElementVisible,
  scrollLock,
  trapStack,
} from "../components/overlayPrimitives";

export const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const PORTAL_ATTR = "data-signal-portal";
// Node.DOCUMENT_POSITION_FOLLOWING, inlined so this module also loads outside a browser.
const DOCUMENT_POSITION_FOLLOWING = 4;

/** Append a portal host to `doc.body`. Returns it; the caller removes it. */
export function mountPortalNode(doc) {
  const el = doc.createElement("div");
  el.setAttribute(PORTAL_ATTR, "");
  doc.body.appendChild(el);
  return el;
}

/**
 * Renders `children` into `document.body`. SSR safe: renders nothing until mounted.
 * @param {object} props
 * @param {React.ReactNode} props.children
 */
export function Portal({ children }) {
  const [mount, setMount] = useState(null);
  useEffect(() => {
    const el = mountPortalNode(document);
    setMount(el);
    return () => {
      el.remove();
      setMount(null);
    };
  }, []);
  return mount ? createPortal(children, mount) : null;
}

/**
 * Focus-trap controller (DOM only, no React). While this trap is the topmost:
 * Tab/Shift+Tab cycle inside `container`; focus that lands outside (click,
 * script) is pulled back, except into overlays portaled after this one
 * (menus, popovers opened from the dialog); focus lost to <body> because the
 * focused node unmounted (e.g. a step change) moves back to the panel.
 * `release()` returns focus to `returnFocusTo`, else the element focused at creation.
 * @param {object} options
 * @param {Document} options.doc
 * @param {HTMLElement} options.container
 * @param {() => (HTMLElement|null)} [options.getInitialFocus]
 * @param {HTMLElement|null} [options.returnFocusTo] Captured before the panel mounts, so autoFocus inside it is not recorded as the trigger.
 * @param {ReturnType<import("../components/overlayPrimitives").createDismissStack>} [options.stack]
 * @returns {{ release: () => void }}
 */
export function createFocusTrap({
  doc,
  container,
  getInitialFocus,
  returnFocusTo,
  stack = trapStack,
}) {
  if (!doc || !container) throw new Error("createFocusTrap: doc and container required");
  const trigger = returnFocusTo ?? doc.activeElement;
  let lastInside = null;
  let released = false;
  // Stack entry. Other traps call `refocus` when they release and their own
  // opener is gone (nested dialogs closing together, an unmounted trigger).
  const handler = {
    container,
    refocus: () => {
      if (lastInside?.isConnected && container.contains(lastInside)) lastInside.focus();
      else container.focus?.();
    },
  };
  const isTop = () => !released && stack.top() === handler;
  // A menu/popover portaled after this dialog may take focus; Tab must stay there.
  const inLaterPortal = (node) => {
    const ownPortal = container.closest(`[${PORTAL_ATTR}]`);
    const targetPortal = node?.closest?.(`[${PORTAL_ATTR}]`);
    return Boolean(
      ownPortal &&
        targetPortal &&
        ownPortal !== targetPortal &&
        ownPortal.compareDocumentPosition(targetPortal) & DOCUMENT_POSITION_FOLLOWING,
    );
  };
  const focusPanel = () => {
    const initial = getInitialFocus?.();
    if (initial?.isConnected && container.contains(initial)) {
      initial.focus();
      return;
    }
    // autoFocus (or a click) already placed focus inside: don't steal it.
    const active = doc.activeElement;
    if (active && active !== container && container.contains(active)) {
      lastInside = active;
      return;
    }
    if (container.hasAttribute("tabindex")) container.focus();
    else container.querySelector(FOCUSABLE)?.focus?.();
  };
  const isLost = () => {
    const active = doc.activeElement;
    return !active || active === doc.body || !active.isConnected;
  };
  const onFocusIn = (event) => {
    if (!isTop()) return;
    const target = event.target;
    if (container.contains(target)) {
      lastInside = target;
      return;
    }
    if (inLaterPortal(target)) return;
    if (lastInside?.isConnected && container.contains(lastInside)) lastInside.focus();
    else focusPanel();
  };
  const onKeyDown = (event) => {
    if (event.key !== "Tab" || !isTop() || inLaterPortal(doc.activeElement)) return;
    const items = [...container.querySelectorAll(FOCUSABLE)].filter(isElementVisible);
    event.preventDefault();
    if (items.length === 0) {
      if (container.hasAttribute("tabindex")) container.focus();
      return;
    }
    // -1 (focus on the panel itself): Tab enters the first item, Shift+Tab the last.
    items[cycleTabFocus(items.indexOf(doc.activeElement), items.length, event.shiftKey)].focus();
  };
  // Removing the focused node moves focus to <body> with no focus event.
  const onMutation = () => {
    if (isTop() && isLost()) container.focus?.();
  };
  const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  const observer = Observer ? new Observer(onMutation) : null;
  observer?.observe(container, { childList: true, subtree: true });

  // Push before focusing so an outer trap's focusin check already sees us on top.
  stack.push(handler);
  doc.addEventListener("focusin", onFocusIn);
  doc.addEventListener("keydown", onKeyDown);
  focusPanel();

  return {
    release() {
      if (released) return;
      released = true;
      observer?.disconnect();
      stack.pop(handler);
      doc.removeEventListener("focusin", onFocusIn);
      doc.removeEventListener("keydown", onKeyDown);
      // Deferred: when nested dialogs close in one commit, every trap has
      // released (and portals are gone) before anyone picks a focus target.
      queueMicrotask(() => restoreFocus(stack, trigger));
    },
  };
}

/**
 * Focus after a trap releases: the opener if it still exists and the remaining
 * top trap (if any) contains it; else the remaining top trap's last focused
 * item or panel; else nothing (focus stays on <body>, never throws).
 */
export function restoreFocus(stack, trigger) {
  const top = stack.top();
  const triggerOk = Boolean(trigger?.isConnected);
  if (top && !(triggerOk && top.container?.contains(trigger))) {
    top.refocus?.();
    return;
  }
  if (triggerOk) trigger.focus?.();
}

/**
 * True when `target` sits in a portal mounted after `container`'s own portal:
 * a menu/popover opened from within a dialog. Such presses count as inside,
 * never as an outside dismiss. Same rule as the focus trap's `inLaterPortal`.
 * @param {HTMLElement} container the panel this layer guards
 * @param {EventTarget|null} target the press target
 */
export function isLaterPortalPress(container, target) {
  const ownPortal = container?.closest?.(`[${PORTAL_ATTR}]`);
  const targetPortal = target?.closest?.(`[${PORTAL_ATTR}]`);
  return Boolean(
    ownPortal &&
      targetPortal &&
      ownPortal !== targetPortal &&
      ownPortal.compareDocumentPosition(targetPortal) & DOCUMENT_POSITION_FOLLOWING,
  );
}

/**
 * Esc/outside-press controller (DOM only). Only the topmost layer in `stack`
 * reacts, so nested overlays close inside-out.
 * @returns {() => void} cleanup
 */
export function createDismissLayer({
  doc,
  onClose,
  getContainer,
  closeOnEscape = true,
  closeOnOutside = true,
  stack = dismissStack,
}) {
  const handler = () => onClose?.();
  const onKeyDown = (event) => {
    // Bubble phase runs after the target/React listeners, so an inline editor
    // inside the dialog can cancel its own Esc first (preventDefault or
    // stopPropagation). Honor that: only an unterminated Esc is a dismiss.
    if (
      event.key === "Escape" &&
      closeOnEscape &&
      stack.top() === handler &&
      !event.defaultPrevented
    ) {
      // preventDefault marks it handled for the other layers' listeners on
      // this same document (stopPropagation cannot stop same-target ones).
      event.preventDefault();
      event.stopPropagation();
      handler();
    }
  };
  const onPointerDown = (event) => {
    const container = getContainer?.();
    if (
      closeOnOutside &&
      stack.top() === handler &&
      container &&
      !container.contains(event.target) &&
      !isLaterPortalPress(container, event.target)
    ) {
      handler();
    }
  };
  stack.push(handler);
  doc.addEventListener("keydown", onKeyDown);
  doc.addEventListener("pointerdown", onPointerDown);
  return () => {
    stack.pop(handler);
    doc.removeEventListener("keydown", onKeyDown);
    doc.removeEventListener("pointerdown", onPointerDown);
  };
}

/**
 * Esc for passive layers (tooltips). Listens in the window capture phase, which
 * runs before every `createDismissLayer` document-capture listener, and stops
 * the event, so a parent modal/menu does not also close. Kept off the dismiss
 * stack so an open tooltip never blocks the parent's outside-press close.
 * @returns {() => void} cleanup
 */
export function createEscapeGuard(win, onEscape) {
  const onKeyDown = (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onEscape();
  };
  win.addEventListener("keydown", onKeyDown, true);
  return () => win.removeEventListener("keydown", onKeyDown, true);
}

Portal.propTypes = {
  children: PropTypes.node,
};

/**
 * Trap focus inside `container` while `active` (see `createFocusTrap`).
 * `container` is the panel node itself (callback-ref state), so the trap
 * attaches whenever the portaled panel mounts, however late. Returns focus to
 * the element that opened the overlay; an autoFocus inside the panel keeps
 * focus. `initialFocusRef` forces a target when given.
 * @param {object} options
 * @param {HTMLElement|null} options.container
 * @param {boolean} [options.active=true]
 * @param {React.RefObject<HTMLElement>} [options.initialFocusRef]
 */
export function useFocusTrap({ container, active = true, initialFocusRef } = {}) {
  const openerRef = useRef(null);
  // Runs in the commit that opens the overlay, before the portal content
  // (and any autoFocus inside it) mounts: that is the real opener.
  useEffect(() => {
    if (active && typeof document !== "undefined") openerRef.current = document.activeElement;
  }, [active]);
  useEffect(() => {
    if (!active || !container || typeof document === "undefined") return undefined;
    const trap = createFocusTrap({
      doc: document,
      container,
      getInitialFocus: () => initialFocusRef?.current,
      returnFocusTo: openerRef.current,
    });
    return () => trap.release();
  }, [active, container, initialFocusRef]);
}

/** `[node, callbackRef]`: callback ref that also keeps `ref.current` in sync. */
export function useNodeRef(ref) {
  const [node, setNode] = useState(null);
  const callbackRef = useCallback(
    (el) => {
      if (ref) ref.current = el;
      setNode(el);
    },
    [ref],
  );
  return [node, callbackRef];
}

/** Ref-counted body scroll lock while `active` (nested overlays share one lock). */
export function useScrollLock(active = true) {
  useEffect(() => {
    if (!active || typeof document === "undefined") return undefined;
    scrollLock.lock(document);
    return () => {
      scrollLock.unlock(document);
    };
  }, [active]);
}

/**
 * Close on Escape and outside pointer press while `active`. Registers in the
 * shared dismiss stack so nested overlays close inside-out. Disabled items
 * never fire `onClose`.
 * @param {object} options
 * @param {() => void} options.onClose
 * @param {React.RefObject<HTMLElement>} [options.containerRef]
 * @param {boolean} [options.enabled=true]
 * @param {boolean} [options.closeOnEscape=true]
 * @param {boolean} [options.closeOnOutside=true]
 */
export function useDismiss({
  onClose,
  containerRef,
  enabled = true,
  closeOnEscape = true,
  closeOnOutside = true,
} = {}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return undefined;
    return createDismissLayer({
      doc: document,
      onClose: () => closeRef.current?.(),
      getContainer: () => containerRef?.current,
      closeOnEscape,
      closeOnOutside,
    });
  }, [enabled, closeOnEscape, closeOnOutside, containerRef]);
}

/** True when the OS asks for reduced motion. Reactive to live OS changes. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (event) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** Stable `overlayId-titleId-descriptionId` ids for aria-labelledby/describedby wiring. */
export function useOverlayIds(prefix = "signal-overlay") {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  return {
    overlayId: `${prefix}-${id}`,
    titleId: `${prefix}-title-${id}`,
    descriptionId: `${prefix}-description-${id}`,
  };
}
