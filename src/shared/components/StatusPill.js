"use client";

import PropTypes from "prop-types";
import { PILL_SIZES, PILL_VARIANT_NAMES, pillClasses } from "./displayPrimitives";

/**
 * Signal status pill. Height 24 (20 compact), tinted bg + colored text.
 * Status is never color-only: always pass a text label as `children`.
 *
 * @param {object} props
 * @param {React.ReactNode} props.children Visible label.
 * @param {"ok"|"warn"|"err"|"info"|"brand"|"live"|"neutral"} [props.variant="neutral"] Legacy names also accepted.
 * @param {"sm"|"md"|"lg"} [props.size="md"] `sm` = 20 compact, `md` = 24.
 * @param {boolean} [props.dot] Optional leading status dot.
 * @param {string} [props.className]
 */
export default function StatusPill({
  children,
  variant = "neutral",
  size = "md",
  dot = false,
  className,
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-semibold whitespace-nowrap ${pillClasses(variant, size)}${className ? ` ${className}` : ""}`}
    >
      {dot && <span aria-hidden="true" className="size-2 rounded-full bg-current" />}
      {children}
    </span>
  );
}

StatusPill.propTypes = {
  children: PropTypes.node,
  variant: PropTypes.oneOf(PILL_VARIANT_NAMES),
  size: PropTypes.oneOf(Object.keys(PILL_SIZES)),
  dot: PropTypes.bool,
  className: PropTypes.string,
};
