"use client";

import { useRef } from "react";
import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import { DRAWER_WIDTHS, drawerSideClass, drawerWidthClass } from "./overlayPrimitives";
import {
  Portal,
  useDismiss,
  useFocusTrap,
  useNodeRef,
  useOverlayIds,
  useScrollLock,
} from "@/shared/hooks/useOverlay";
import IconButton from "./IconButton";

/**
 * Signal drawer: full-height panel on the inline-end side by default
 * (`side="start"` for RTL-safe mobile nav), focus-trapped with Esc close,
 * scrubbed scroll lock and transform/opacity entry.
 *
 * @param {object} props
 * @param {boolean} props.isOpen
 * @param {() => void} [props.onClose]
 * @param {React.ReactNode} [props.title]
 * @param {React.ReactNode} [props.children]
 * @param {"sm"|"md"|"lg"|"xl"|"full"|"nav"} [props.width="md"] Kept for call-site compatibility.
 * @param {string} [props.size] Alias of `width` (wins when both are set).
 * @param {"start"|"end"} [props.side="end"]
 * @param {boolean} [props.closeOnOverlay=true]
 * @param {boolean} [props.closeOnEscape=true]
 * @param {React.RefObject<HTMLElement>} [props.initialFocusRef]
 * @param {string} [props.className]
 * @param {string} [props.id] DOM id for the dialog panel (defaults to the
 *   generated overlay id).
 * @param {boolean} [props.bare=false] Skip the drawer's header and body padding
 *   (full-bleed content like the mobile sidebar). A string `title` becomes
 *   the dialog's `aria-label`.
 */
export default function Drawer({
  isOpen,
  onClose,
  title,
  children,
  width = "md",
  size,
  side = "end",
  closeOnOverlay = true,
  closeOnEscape = true,
  initialFocusRef,
  className,
  id,
  bare = false,
}) {
  const panelRef = useRef(null);
  const [panel, setPanelNode] = useNodeRef(panelRef);
  const { overlayId, titleId } = useOverlayIds("signal-drawer");
  const open = Boolean(isOpen);
  useScrollLock(open);
  useFocusTrap({ container: panel, active: open, initialFocusRef });
  useDismiss({
    onClose,
    containerRef: panelRef,
    enabled: open,
    closeOnEscape,
    closeOnOutside: closeOnOverlay,
  });
  if (!open) return null;
  const labelled = !bare && title;
  return (
    <Portal>
      <div className="fixed inset-0 z-50">
        <div className="signal-backdrop absolute inset-0" aria-hidden="true" />
        <div
          ref={setPanelNode}
          id={id || overlayId}
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelled ? titleId : undefined}
          aria-label={bare && typeof title === "string" ? title : undefined}
          tabIndex={-1}
          className={cn(
            "signal-overlay-drawer absolute inset-y-0 flex max-w-full flex-col bg-panel text-text shadow-card outline-none",
            drawerSideClass(side),
            drawerWidthClass(size ?? width),
            className,
          )}
        >
          {bare ? (
            children
          ) : (
            <>
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-6 py-4">
                {title ? (
                  <h2 id={titleId} className="min-w-0 font-display text-lg font-bold">
                    {title}
                  </h2>
                ) : (
                  <span />
                )}
                {onClose ? <IconButton icon="close" label="Close" onClick={onClose} /> : null}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-6 custom-scrollbar">{children}</div>
            </>
          )}
        </div>
      </div>
    </Portal>
  );
}

Drawer.propTypes = {
  isOpen: PropTypes.bool,
  onClose: PropTypes.func,
  title: PropTypes.node,
  children: PropTypes.node,
  width: PropTypes.oneOf(Object.keys(DRAWER_WIDTHS)),
  size: PropTypes.oneOf(Object.keys(DRAWER_WIDTHS)),
  side: PropTypes.oneOf(["start", "end"]),
  closeOnOverlay: PropTypes.bool,
  closeOnEscape: PropTypes.bool,
  initialFocusRef: PropTypes.shape({ current: PropTypes.any }),
  className: PropTypes.string,
  id: PropTypes.string,
  bare: PropTypes.bool,
};
