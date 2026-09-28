"use client";

import { cloneElement, isValidElement, useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import { TOOLTIP_VARIANTS, tooltipVariantClass, tooltipVisible } from "./overlayPrimitives";
import { useFloatingStyle } from "./Popover";
import { Portal, createEscapeGuard, useOverlayIds } from "@/shared/hooks/useOverlay";

const OPEN_DELAY_MS = 150;
const CLOSE_DELAY_MS = 100;

/**
 * Signal tooltip: token variants, shows on hover AND focus,
 * `aria-describedby`, Esc dismiss. Colors come from token `variant`s only.
 *
 * @param {object} props
 * @param {React.ReactNode} props.text Tooltip content.
 * @param {React.ReactNode} props.children Anchor element.
 * @param {"top"|"bottom"|"start"|"end"|"left"|"right"} [props.position="top"]
 * @param {"neutral"|"err"|"warn"|"info"} [props.variant="neutral"]
 * @param {boolean} [props.disabled=false] Never show.
 * @param {string} [props.className] Panel classes.
 */
export default function Tooltip({
  text,
  children,
  position = "top",
  variant = "neutral",
  disabled = false,
  className,
}) {
  const anchorRef = useRef(null);
  const panelRef = useRef(null);
  const openTimer = useRef(null);
  const closeTimer = useRef(null);
  const { overlayId } = useOverlayIds("signal-tooltip");
  const [openState, setOpen] = useState(false);
  // Hides at once when the tip turns disabled or its text empties while open.
  const open = tooltipVisible(openState, disabled, text);
  const style = useFloatingStyle(anchorRef, panelRef, open, position);

  useEffect(
    () => () => {
      clearTimeout(openTimer.current);
      clearTimeout(closeTimer.current);
    },
    [],
  );

  // Drop stale state and pending timers too, so re-enabling does not re-show it.
  useEffect(() => {
    if (open || !openState) return;
    clearTimeout(openTimer.current);
    setOpen(false);
  }, [open, openState]);

  // Esc closes only the tip (anchor keeps focus, APG tooltip); a parent modal
  // or menu stays open until the next Esc.
  useEffect(() => (open ? createEscapeGuard(window, () => setOpen(false)) : undefined), [open]);

  const show = useCallback(() => {
    if (!tooltipVisible(true, disabled, text)) return;
    clearTimeout(closeTimer.current);
    clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS);
  }, [disabled, text]);

  const hide = useCallback(() => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }, []);

  // Native listeners on the wrapper: it owns hover/focus so disabled buttons
  // (no pointer events) still show the tip, without a static-element handler.
  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return undefined;
    anchor.addEventListener("mouseenter", show);
    anchor.addEventListener("mouseleave", hide);
    anchor.addEventListener("focusin", show);
    anchor.addEventListener("focusout", hide);
    return () => {
      anchor.removeEventListener("mouseenter", show);
      anchor.removeEventListener("mouseleave", hide);
      anchor.removeEventListener("focusin", show);
      anchor.removeEventListener("focusout", hide);
    };
  }, [show, hide]);

  if (!isValidElement(children)) throw new Error("Tooltip: `children` must be a React element");

  const isDomChild = typeof children.type === "string";
  const nonInteractive =
    isDomChild &&
    !["button", "a", "input", "select", "textarea"].includes(children.type) &&
    children.props.tabIndex === undefined;
  // Every element child gets aria-describedby while open (React 19 ref-as-prop
  // means element children also accept plain props like this).
  const anchorChild = cloneElement(children, {
    "aria-describedby": open ? overlayId : children.props["aria-describedby"],
    tabIndex: !isDomChild || !nonInteractive ? children.props.tabIndex : 0,
  });

  return (
    <span ref={anchorRef} className="inline-flex">
      {anchorChild}
      {open ? (
        <Portal>
          <div
            ref={panelRef}
            id={overlayId}
            role="tooltip"
            style={style}
            className={cn(
              "signal-overlay-tip pointer-events-none fixed z-50 w-max max-w-56 whitespace-normal rounded-lg px-2 py-1 text-[11px] leading-snug",
              tooltipVariantClass(variant),
              className,
            )}
          >
            {text}
          </div>
        </Portal>
      ) : null}
    </span>
  );
}

Tooltip.propTypes = {
  text: PropTypes.node,
  children: PropTypes.element.isRequired,
  position: PropTypes.oneOf(["top", "bottom", "start", "end", "left", "right"]),
  variant: PropTypes.oneOf(Object.keys(TOOLTIP_VARIANTS)),
  disabled: PropTypes.bool,
  className: PropTypes.string,
};
