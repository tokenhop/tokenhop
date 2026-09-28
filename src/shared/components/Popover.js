"use client";

import { cloneElement, isValidElement, useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import { floatingPosition } from "./overlayPrimitives";
import { Portal, useDismiss, useOverlayIds } from "@/shared/hooks/useOverlay";

/** Re-exported so Tooltip (and tests) keep one import path. Panels pass the viewport implicitly. */
export { floatingPosition };

/** Track `anchorRef`/`panelRef` and return a fixed-position style while `open`. SSR safe (hidden style until measured). */
export function useFloatingStyle(anchorRef, panelRef, open, placement) {
  const [style, setStyle] = useState({ top: 0, left: 0, visibility: "hidden" });
  useEffect(() => {
    if (!open || typeof window === "undefined" || typeof document === "undefined") {
      return undefined;
    }
    let frame = 0;
    const place = () => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) {
        frame = requestAnimationFrame(place);
        return;
      }
      const rtl = getComputedStyle(anchor).direction === "rtl";
      const pos = floatingPosition(
        anchor.getBoundingClientRect(),
        { width: panel.offsetWidth, height: panel.offsetHeight },
        placement,
        rtl,
      );
      setStyle({ top: pos.top, left: pos.left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchorRef, panelRef, open, placement]);
  return style;
}

/**
 * Signal popover: non-modal floating panel. Trigger gets `aria-haspopup`,
 * `aria-expanded`, `aria-controls`. Esc closes and returns focus to the
 * trigger; outside press closes.
 *
 * @param {object} props
 * @param {React.ReactElement} props.trigger Focusable element that forwards `ref`
 *   to its root (React 19 ref-as-prop; e.g. `Button`).
 * @param {React.ReactNode} props.children Panel content.
 * @param {boolean} [props.open] Controlled state.
 * @param {(open: boolean) => void} [props.onOpenChange]
 * @param {"top"|"bottom"|"start"|"end"} [props.placement="bottom"]
 * @param {string} [props.aria-label] Panel name (role="dialog").
 * @param {string} [props.className] Panel classes.
 */
export default function Popover({
  trigger,
  children,
  open: controlledOpen,
  onOpenChange,
  placement = "bottom",
  "aria-label": ariaLabel,
  className,
}) {
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const { overlayId } = useOverlayIds("signal-popover");
  const [internalOpen, setInternalOpen] = useState(false);
  const controlled = typeof controlledOpen === "boolean";
  const open = controlled ? controlledOpen : internalOpen;
  const setOpen = useCallback(
    (next) => (controlled ? onOpenChange?.(next) : setInternalOpen(next)),
    [controlled, onOpenChange],
  );
  const style = useFloatingStyle(triggerRef, panelRef, open, placement);

  const close = useCallback(() => {
    // Refocus the trigger only when focus lives inside the panel; a click
    // outside keeps focus where the user moved it.
    const focusInside = panelRef.current?.contains(document.activeElement) ?? false;
    setOpen(false);
    if (focusInside) triggerRef.current?.focus?.();
  }, [setOpen]);

  useDismiss({ onClose: close, containerRef: panelRef, enabled: open, closeOnOutside: false });

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (panelRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, setOpen]);

  if (!isValidElement(trigger)) throw new Error("Popover: `trigger` must be a React element");

  return (
    <>
      {cloneElement(trigger, {
        ref: triggerRef,
        "aria-haspopup": "dialog",
        "aria-expanded": open,
        "aria-controls": open ? overlayId : undefined,
        onClick: (event) => {
          trigger.props.onClick?.(event);
          if (!event.defaultPrevented) setOpen(!open);
        },
      })}
      {open ? (
        <Portal>
          <div
            ref={panelRef}
            id={overlayId}
            role="dialog"
            aria-label={ariaLabel}
            style={style}
            className={cn(
              "signal-overlay-pop fixed z-50 min-w-48 max-w-[min(24rem,calc(100vw-16px))] rounded-xl border border-line bg-panel p-4 text-text shadow-card",
              className,
            )}
          >
            {children}
          </div>
        </Portal>
      ) : null}
    </>
  );
}

Popover.propTypes = {
  trigger: PropTypes.element.isRequired,
  children: PropTypes.node,
  open: PropTypes.bool,
  onOpenChange: PropTypes.func,
  placement: PropTypes.oneOf(["top", "bottom", "start", "end"]),
  "aria-label": PropTypes.string,
  className: PropTypes.string,
};
