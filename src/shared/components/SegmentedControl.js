"use client";

import PropTypes from "prop-types";
import { useRef } from "react";
import { cn } from "@/shared/utils/cn";
import { isRovingKey, nextRovingIndex, SEGMENTED_SIZES } from "./formPrimitives";

/** Signal radio group: selected item is inverted, arrow/Home/End keys move focus and selection. */
export default function SegmentedControl({
  options = [],
  value,
  onChange,
  size = "md",
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  ...props
}) {
  const refs = useRef([]);
  const selected = options.findIndex((option) => option.value === value);
  const active = selected < 0 ? 0 : selected;
  const height = SEGMENTED_SIZES[size];
  if (!height) throw new Error(`SegmentedControl: unknown size "${size}"`);

  const onKeyDown = (event, index) => {
    if (!isRovingKey(event.key) || options.length === 0) return;
    event.preventDefault();
    const next = nextRovingIndex(index, event.key, {
      length: options.length,
      rtl: event.currentTarget.closest("[dir]")?.getAttribute("dir") === "rtl",
    });
    refs.current[next]?.focus();
    onChange?.(options[next].value);
  };

  return (
    <div
      {...props}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg border border-line bg-raised p-1 overflow-x-auto",
        className,
      )}
    >
      {options.map((option, index) => (
        // biome-ignore lint/a11y/useSemanticElements: APG radio group; native radios cannot carry the inverted-pill + roving tabindex contract.
        <button
          key={option.value}
          ref={(element) => {
            refs.current[index] = element;
          }}
          type="button"
          role="radio"
          aria-checked={index === selected}
          tabIndex={index === active ? 0 : -1}
          onKeyDown={(event) => onKeyDown(event, index)}
          onClick={() => onChange?.(option.value)}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 font-semibold transition-colors duration-200 focus-visible:shadow-focus motion-reduce:transition-none",
            height,
            index === selected ? "bg-text text-bg" : "text-muted hover:text-text",
          )}
        >
          {option.icon && (
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
              {option.icon}
            </span>
          )}
          {option.label}
          {option.count != null && (
            <span className={cn("font-mono", index === selected ? "text-bg/80" : "text-muted")}>
              {option.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

SegmentedControl.propTypes = {
  options: PropTypes.arrayOf(
    PropTypes.shape({
      value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
      label: PropTypes.node.isRequired,
      icon: PropTypes.string,
      count: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    }),
  ),
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  onChange: PropTypes.func,
  size: PropTypes.oneOf(Object.keys(SEGMENTED_SIZES)),
  className: PropTypes.string,
  "aria-label": nameRequired,
  "aria-labelledby": PropTypes.string,
};

function nameRequired(props, _propName, componentName) {
  if (!props["aria-label"] && !props["aria-labelledby"]) {
    return new Error(`${componentName}: provide "aria-label" or "aria-labelledby".`);
  }
  return null;
}
