"use client";

import PropTypes from "prop-types";
import { useId } from "react";
import { cn } from "@/shared/utils/cn";

const tracks = { sm: "h-[26px] w-11", md: "h-[26px] w-11", lg: "h-7 w-12" };

/** Signal switch: boolean onChange, native button keyboard, associated label and description. */
export default function Toggle({
  checked = false,
  onChange,
  label,
  description,
  disabled = false,
  size = "md",
  className,
  id,
  ...props
}) {
  const generatedId = useId();
  const switchId = id || generatedId;
  const labelId = `${switchId}-label`;
  const descId = `${switchId}-description`;
  if (!tracks[size]) throw new Error(`Toggle: unknown size "${size}"`);

  return (
    <div className={cn("flex items-center gap-3", disabled && "opacity-50", className)}>
      <button
        {...props}
        id={switchId}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={label ? labelId : props["aria-labelledby"]}
        aria-describedby={description ? descId : props["aria-describedby"]}
        aria-label={label ? undefined : props["aria-label"] || props.title}
        disabled={disabled}
        onClick={() => onChange?.(!checked)}
        className={cn(
          "relative inline-flex shrink-0 rounded-full border border-line transition-colors duration-200",
          "focus-visible:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed",
          "motion-reduce:transition-none",
          checked ? "bg-toggle-on" : "bg-line",
          tracks[size],
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute top-0.5 size-5 rounded-full shadow-sm transition-transform duration-200 motion-reduce:transition-none",
            // Off knob is muted (not the Kit's white) so it keeps >= 3:1 on the line track in light.
            checked
              ? "bg-toggle-knob-on translate-x-5 rtl:-translate-x-5"
              : "bg-muted translate-x-0.5 rtl:-translate-x-0.5",
            "start-0",
          )}
        />
      </button>
      {(label || description) && (
        <div className="flex flex-col">
          {label && (
            <label
              id={labelId}
              htmlFor={switchId}
              className="text-sm font-medium text-text cursor-pointer"
            >
              {label}
            </label>
          )}
          {description && (
            <span id={descId} className="text-xs text-muted">
              {description}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

Toggle.propTypes = {
  checked: PropTypes.bool,
  onChange: PropTypes.func,
  label: PropTypes.node,
  description: PropTypes.node,
  disabled: PropTypes.bool,
  size: PropTypes.oneOf(Object.keys(tracks)),
  className: PropTypes.string,
  id: PropTypes.string,
  title: PropTypes.string,
  "aria-label": PropTypes.string,
};
