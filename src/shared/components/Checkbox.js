"use client";

import PropTypes from "prop-types";
import { useEffect, useId, useRef } from "react";
import { cn } from "@/shared/utils/cn";

/**
 * Signal checkbox: native input, coral check, 22px box in a 44px hit area.
 * The native input stays focusable and drives the visual box through `peer`
 * (no generated data-URI images); the check is a Material Symbols overlay.
 * `indeterminate` renders a minus glyph and maps to the DOM property.
 */
export default function Checkbox({
  checked = false,
  indeterminate = false,
  onChange,
  label,
  description,
  disabled = false,
  className,
  id,
  ...props
}) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const inputRef = useRef(null);

  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <div className={cn("flex items-start gap-3", disabled && "opacity-50", className)}>
      <span className="relative inline-flex size-11 shrink-0 items-center justify-center -ms-2.5">
        <input
          {...props}
          ref={inputRef}
          id={inputId}
          type="checkbox"
          checked={checked}
          aria-checked={indeterminate ? "mixed" : checked}
          onChange={(event) => onChange?.(event.target.checked)}
          disabled={disabled}
          className="peer absolute inset-0 m-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        />
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none flex size-[22px] items-center justify-center rounded-xs border border-line bg-raised",
            "text-transparent transition-colors duration-150",
            "peer-checked:border-transparent peer-checked:bg-coral peer-checked:text-on-coral",
            "peer-focus-visible:shadow-focus peer-disabled:cursor-not-allowed",
            indeterminate && "border-transparent bg-coral text-on-coral",
          )}
        >
          <span className="material-symbols-outlined text-[16px] font-bold">
            {indeterminate ? "remove" : "check"}
          </span>
        </span>
      </span>
      {(label || description) && (
        <label htmlFor={inputId} className="flex cursor-pointer flex-col pt-2">
          {label && <span className="text-sm font-medium text-text">{label}</span>}
          {description && <span className="text-xs text-muted">{description}</span>}
        </label>
      )}
    </div>
  );
}

Checkbox.propTypes = {
  checked: PropTypes.bool,
  indeterminate: PropTypes.bool,
  onChange: PropTypes.func,
  label: PropTypes.node,
  description: PropTypes.node,
  disabled: PropTypes.bool,
  className: PropTypes.string,
  id: PropTypes.string,
};
