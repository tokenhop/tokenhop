"use client";

import PropTypes from "prop-types";
import StatusPill from "./StatusPill";

/**
 * Badge — StatusPill with an optional leading Material Symbols icon.
 * Accepts Signal variants (ok/warn/err/info/brand/live/neutral) and the legacy
 * names (default/primary/success/warning/error).
 */
export default function Badge({
  children,
  variant = "default",
  size = "md",
  dot = false,
  icon,
  className,
}) {
  return (
    <StatusPill variant={variant} size={size} dot={dot} className={className}>
      {icon && (
        <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
          {icon}
        </span>
      )}
      {children}
    </StatusPill>
  );
}

Badge.propTypes = {
  children: PropTypes.node,
  variant: StatusPill.propTypes.variant,
  size: StatusPill.propTypes.size,
  dot: PropTypes.bool,
  icon: PropTypes.string,
  className: PropTypes.string,
};
