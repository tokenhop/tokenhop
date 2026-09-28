"use client";

import PropTypes from "prop-types";
import { useId, useRef, useState } from "react";
import { cn } from "@/shared/utils/cn";
import { hasPanelContent, nextRovingIndex } from "./formPrimitives";

// Horizontal tablist: Up/Down stay free for page scrolling (APG).
const TAB_KEYS = ["ArrowLeft", "ArrowRight", "Home", "End"];

/**
 * Signal tabs for view switching (WAI-ARIA tabs, automatic activation):
 * tablist/tab/tabpanel wiring, roving tabindex, Left/Right (mirrored in RTL),
 * Home/End. Controlled with `value`, or uncontrolled with `defaultValue`.
 * Inactive panels stay mounted but `hidden` so every `aria-controls` resolves.
 */
export default function Tabs({
  tabs = [],
  value,
  defaultValue,
  onChange,
  className,
  id,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  ...props
}) {
  const generatedId = useId();
  const baseId = id || generatedId;
  const refs = useRef([]);
  const [internal, setInternal] = useState(defaultValue ?? tabs[0]?.value);
  const selected = value !== undefined ? value : internal;
  const active = Math.max(
    0,
    tabs.findIndex((tab) => tab.value === selected),
  );

  const select = (next) => {
    if (value === undefined) setInternal(next);
    onChange?.(next);
  };

  const onKeyDown = (event, index) => {
    if (!TAB_KEYS.includes(event.key) || tabs.length === 0) return;
    event.preventDefault();
    const next = nextRovingIndex(index, event.key, {
      length: tabs.length,
      rtl: event.currentTarget.closest("[dir]")?.getAttribute("dir") === "rtl",
    });
    refs.current[next]?.focus();
    select(tabs[next].value);
  };

  return (
    <div {...props} className={cn("flex flex-col", className)}>
      <div
        role="tablist"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-orientation="horizontal"
        className="flex items-center gap-1 border-b border-line overflow-x-auto"
      >
        {tabs.map((tab, index) => {
          const isActive = index === active;
          return (
            <button
              key={tab.value}
              ref={(element) => {
                refs.current[index] = element;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${tab.value}`}
              aria-selected={isActive}
              aria-controls={`${baseId}-panel-${tab.value}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => select(tab.value)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                "relative inline-flex h-11 shrink-0 items-center px-3 text-sm font-semibold transition-colors focus-visible:shadow-focus",
                isActive ? "text-text" : "text-muted hover:text-text",
              )}
            >
              {tab.label}
              {tab.count != null && (
                <span className="ms-1.5 font-mono text-xs text-muted">{tab.count}</span>
              )}
              <span
                aria-hidden="true"
                className={cn(
                  "absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-coral transition-opacity",
                  isActive ? "opacity-100" : "opacity-0",
                )}
              />
            </button>
          );
        })}
      </div>
      {tabs.map((tab, index) => (
        <div
          key={tab.value}
          role="tabpanel"
          id={`${baseId}-panel-${tab.value}`}
          aria-labelledby={`${baseId}-tab-${tab.value}`}
          hidden={index !== active}
          // APG: a panel is a tab stop only when it has content to reach; an
          // empty panel (tabs used as a view switcher) must not add a focus stop.
          // biome-ignore lint/a11y/noNoninteractiveTabindex: APG tabpanel is focusable so keyboard users can reach non-interactive panel content.
          tabIndex={hasPanelContent(tab.content) ? 0 : undefined}
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}

/** Requires an accessible name for the tablist. */
function nameRequired(props, _propName, componentName) {
  if (!props["aria-label"] && !props["aria-labelledby"]) {
    return new Error(`${componentName}: provide "aria-label" or "aria-labelledby".`);
  }
  return null;
}

Tabs.propTypes = {
  tabs: PropTypes.arrayOf(
    PropTypes.shape({
      value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
      label: PropTypes.node.isRequired,
      count: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
      content: PropTypes.node,
    }),
  ),
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  defaultValue: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  onChange: PropTypes.func,
  className: PropTypes.string,
  id: PropTypes.string,
  "aria-label": nameRequired,
  "aria-labelledby": PropTypes.string,
};
