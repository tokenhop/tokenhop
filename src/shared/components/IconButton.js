"use client";

import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";

/**
 * Signal icon-only button: 40px square, line border, muted icon that turns
 * text-colored on hover. An accessible name (`label`, `aria-label` or
 * `aria-labelledby`) is required. An optional decorative `suffix` (e.g. a
 * locale code chip) widens it; pass `aria-hidden` content only.
 */
export default function IconButton({
  icon,
  label,
  "aria-label": ariaLabel,
  loading = false,
  disabled = false,
  className,
  suffix,
  ...props
}) {
  const accessibleLabel = label ?? ariaLabel;
  return (
    <button
      {...props}
      type={props.type || "button"}
      aria-label={accessibleLabel}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center rounded-lg border border-line bg-raised text-muted",
        "transition-colors duration-150 hover:bg-line/60 hover:text-text",
        "focus-visible:outline-none focus-visible:shadow-focus",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      <span
        className={cn("material-symbols-outlined text-[20px]", loading && "animate-spin")}
        aria-hidden="true"
      >
        {loading ? "progress_activity" : icon}
      </span>
      {suffix}
    </button>
  );
}

function labelRequired(props, _propName, componentName) {
  if (!props.label && !props["aria-label"] && !props["aria-labelledby"]) {
    return new Error(`${componentName}: provide "label", "aria-label" or "aria-labelledby".`);
  }
  return null;
}

IconButton.propTypes = {
  icon: PropTypes.string.isRequired,
  label: labelRequired,
  "aria-label": PropTypes.string,
  "aria-labelledby": PropTypes.string,
  loading: PropTypes.bool,
  disabled: PropTypes.bool,
  className: PropTypes.string,
  suffix: PropTypes.node,
};
