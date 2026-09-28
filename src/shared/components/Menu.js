"use client";

import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import { isRovingKey, nextRovingIndex } from "./formPrimitives";
import {
  firstEnabledIndex,
  menuPosition,
  nextEnabledIndex,
  typeaheadStep,
} from "./overlayPrimitives";
import { Portal, useDismiss, useOverlayIds } from "@/shared/hooks/useOverlay";

// Layout effects position the panel before paint; on the server fall back to
// a passive effect to avoid the SSR useLayoutEffect warning.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const labelOf = (child) =>
  typeof child?.props?.label === "string" ? child.props.label : child?.props?.children;

/**
 * Signal menu button: `aria-haspopup="menu"`, `aria-expanded`, roving focus
 * with Arrow keys/Home/End, typeahead, Esc returns focus to the trigger,
 * click-outside closes. Portaled, logical `start`/`end` placement, RTL-safe.
 * Roving and typeahead skip disabled items.
 *
 * @param {object} props
 * @param {React.ReactNode} props.trigger Focusable element that forwards `ref`
 *   to its root (React 19 ref-as-prop; e.g. `Button`, `IconButton`). A plain
 *   node renders inside a Signal secondary button instead.
 * @param {React.ReactNode} [props.children] `<MenuItem>` children.
 * @param {boolean} [props.open] Controlled open state.
 * @param {(open: boolean) => void} [props.onOpenChange]
 * @param {"start"|"end"} [props.align="end"]
 * @param {string} [props.className]
 */
export default function Menu({
  trigger,
  children,
  open: controlledOpen,
  onOpenChange,
  align = "end",
  className,
}) {
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const itemRefs = useRef([]);
  const typeRef = useRef({ session: null });
  const { overlayId: menuId } = useOverlayIds("signal-menu");
  const [internalOpen, setInternalOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [panelStyle, setPanelStyle] = useState(null);
  // Portal mounts one commit after `open`; a callback ref re-runs positioning/focus once the panel exists.
  const [panelEl, setPanelEl] = useState(null);
  const setPanelNode = useCallback((el) => {
    panelRef.current = el;
    setPanelEl(el);
  }, []);

  const isControlled = typeof controlledOpen === "boolean";
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = useCallback(
    (next) => {
      if (isControlled) onOpenChange?.(next);
      else setInternalOpen(next);
      if (!next) {
        setActiveIndex(-1);
        // A new open starts a fresh typeahead session; a stale buffer would
        // glue the next session's keystrokes onto the previous one.
        typeRef.current.session = null;
      }
    },
    [isControlled, onOpenChange],
  );

  const refocus = useCallback(() => {
    const trigger = triggerRef.current;
    if (trigger && typeof trigger.focus === "function") trigger.focus();
  }, []);

  const close = useCallback(() => setOpen(false), [setOpen]);
  const closeAndRefocus = useCallback(() => {
    close();
    refocus();
  }, [close, refocus]);

  useEffect(() => {
    // Focus only once the panel is positioned (panelStyle set): focusing while
    // still visibility:hidden never lands in some browsers. Roving updates
    // re-run this too, harmlessly re-focusing the already-focused item.
    if (open && panelEl && panelStyle) itemRefs.current[Math.max(activeIndex, 0)]?.focus?.();
  }, [open, panelEl, panelStyle, activeIndex]);

  // Esc closes and returns focus to the trigger; outside press (below) does not.
  useDismiss({
    onClose: closeAndRefocus,
    containerRef: panelRef,
    enabled: open,
    closeOnOutside: false,
  });

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      // Ignore presses inside the panel or on the trigger: a click on the
      // trigger toggles via onClick; closing here on pointerdown would close
      // the menu under the click and reopen immediately (or close a sidebar's
      // drawer mid-navigation, cancelling the click). True outside presses
      // close on pointerup/click so a straydown doesn't kill the menu.
      if (panelRef.current?.contains(event.target)) return;
      if (triggerRef.current?.contains(event.target)) return;
      close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);

  const items = Children.toArray(children).filter(isValidElement);
  const labels = items.map(labelOf);
  const disabled = items.map((child) => Boolean(child.props.disabled));
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const openAndFocus = useCallback(
    (index = 0) => {
      setOpen(true);
      const first = firstEnabledIndex(disabledRef.current, index < 0 ? 0 : index);
      setActiveIndex(first < 0 ? index : first);
    },
    [setOpen],
  );

  // Position the panel under the trigger once the portaled panel has mounted,
  // synchronously before paint so the open focus below lands in a visible panel.
  useIsomorphicLayoutEffect(() => {
    if (!open || !panelEl) {
      setPanelStyle(null);
      return undefined;
    }
    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const anchor = trigger.getBoundingClientRect();
      const panel = { width: panelEl.offsetWidth, height: panelEl.offsetHeight };
      const rtl = getComputedStyle(trigger).direction === "rtl";
      const pos = menuPosition(anchor, panel, align, rtl);
      setPanelStyle({ top: pos.top, left: pos.left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, panelEl, align]);

  const onItemKeyDown = (event, index) => {
    if (event.key === "Tab") {
      close();
      return;
    }
    if (isRovingKey(event.key)) {
      event.preventDefault();
      const rtl = typeof document !== "undefined" && document.dir === "rtl";
      const next = nextEnabledIndex(index, event.key, disabled, nextRovingIndex, { rtl });
      setActiveIndex(next);
      itemRefs.current[next]?.focus?.();
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const type = typeRef.current;
      const { session, index: match } = typeaheadStep(
        type.session,
        event.key,
        event.timeStamp,
        labels.map((label) => String(label ?? "")),
        index,
        disabled,
      );
      type.session = session;
      if (match !== index) {
        setActiveIndex(match);
        itemRefs.current[match]?.focus?.();
      }
    }
  };

  const onTriggerKeyDown = (event) => {
    if (event.key === "Tab") {
      if (open) close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openAndFocus(0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      const last = firstEnabledIndex(disabled, items.length - 1, true);
      setActiveIndex(last < 0 ? items.length - 1 : last);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      // APG menu button: Enter/Space toggles; closing keeps focus on the trigger.
      if (open) close();
      else openAndFocus(0);
    }
  };

  // Screen readers announce the menu via the trigger's accessible name.
  const triggerAriaLabel = isValidElement(trigger)
    ? (trigger.props["aria-label"] ??
      trigger.props.label ??
      (typeof trigger.props.children === "string" ? trigger.props.children : undefined))
    : undefined;

  const triggerProps = {
    ref: triggerRef,
    "aria-haspopup": "menu",
    "aria-expanded": open,
    "aria-controls": open ? menuId : undefined,
    onClick: () => {
      if (open) close();
      else openAndFocus(0);
    },
    onKeyDown: onTriggerKeyDown,
  };

  return (
    <>
      {isValidElement(trigger) ? (
        cloneElement(trigger, {
          ...triggerProps,
          onClick: (event) => {
            trigger.props.onClick?.(event);
            if (!event.defaultPrevented) triggerProps.onClick(event);
          },
          onKeyDown: (event) => {
            trigger.props.onKeyDown?.(event);
            if (!event.defaultPrevented) onTriggerKeyDown(event);
          },
        })
      ) : (
        <button
          type="button"
          {...triggerProps}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-line bg-raised px-4 text-sm font-semibold text-text transition-colors duration-150 hover:bg-line/60 focus-visible:outline-none focus-visible:shadow-focus"
        >
          {trigger}
        </button>
      )}
      {open ? (
        <Portal>
          <div
            ref={setPanelNode}
            id={menuId}
            role="menu"
            aria-label={triggerAriaLabel}
            aria-orientation="vertical"
            style={panelStyle ?? { visibility: "hidden" }}
            className={cn(
              "signal-overlay-menu fixed z-50 w-60 overflow-hidden rounded-xl border border-line bg-panel py-1 text-text shadow-card",
              className,
            )}
          >
            {items.map((child, index) =>
              cloneElement(child, {
                key: child.key ?? index,
                ref: (el) => {
                  itemRefs.current[index] = el;
                },
                tabIndex: index === Math.max(activeIndex, 0) ? 0 : -1,
                "data-active": index === Math.max(activeIndex, 0),
                onKeyDown: (event) => onItemKeyDown(event, index),
                onSelect: () => {
                  child.props.onSelect?.();
                  closeAndRefocus();
                },
              }),
            )}
          </div>
        </Portal>
      ) : null}
    </>
  );
}

Menu.propTypes = {
  trigger: PropTypes.node.isRequired,
  children: PropTypes.node,
  open: PropTypes.bool,
  onOpenChange: PropTypes.func,
  align: PropTypes.oneOf(["start", "end"]),
  className: PropTypes.string,
};

/**
 * Menu option: `role="menuitem"`, 44px hit area, coral `aria-current` style
 * for the selected row. Closes the menu after `onSelect`.
 *
 * @param {object} props
 * @param {string} [props.icon] Leading Material Symbols glyph.
 * @param {string} [props.label] Typeahead key (defaults to the children text).
 * @param {React.ReactNode} props.children
 * @param {React.ReactNode} [props.trailing]
 * @param {boolean} [props.danger=false] Error-tinted row for destructive actions.
 * @param {boolean} [props.selected=false]
 * @param {boolean} [props.disabled=false]
 * @param {() => void} [props.onSelect]
 */
export const MenuItem = function MenuItem({
  icon,
  label,
  children,
  trailing,
  danger = false,
  selected = false,
  disabled = false,
  onSelect,
  ...props
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-current={selected || undefined}
      disabled={disabled}
      onClick={(event) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        onSelect?.(event);
      }}
      className={cn(
        "flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-sm transition-colors duration-150",
        "focus-visible:outline-none focus-visible:shadow-focus",
        "disabled:cursor-not-allowed disabled:opacity-50",
        danger ? "text-err hover:bg-err-bg" : "text-text hover:bg-raised",
        selected && "bg-coral-bg font-semibold text-coral-ink",
      )}
      {...props}
    >
      {icon ? (
        <span className="material-symbols-outlined text-[20px] text-muted" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 text-start">{children ?? label}</span>
      {selected ? (
        <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
          check
        </span>
      ) : null}
      {trailing ? <span className="shrink-0 text-sm text-muted">{trailing}</span> : null}
    </button>
  );
};

MenuItem.propTypes = {
  icon: PropTypes.string,
  label: PropTypes.string,
  children: PropTypes.node,
  trailing: PropTypes.node,
  danger: PropTypes.bool,
  selected: PropTypes.bool,
  disabled: PropTypes.bool,
  onSelect: PropTypes.func,
};
