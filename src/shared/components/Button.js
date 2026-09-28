"use client";

import Link from "next/link";
import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import { BUTTON_SIZES, BUTTON_VARIANTS, buttonClasses } from "./formPrimitives";

const isExternalHref = (href) => /^(https?:|mailto:|tel:|#)/.test(href);

/**
 * Signal button. Primary is the lime fill (one per view); secondary/ghost/danger
 * cover the rest. Renders a `next/link` (or `<a>` for external URLs) when `href`
 * is given. Supports a leading/trailing Material Symbols icon, a loading state
 * (spinner + `aria-busy`, forces disabled) and disabled state.
 *
 * @param {object} props
 * @param {React.ReactNode} [props.children]
 * @param {"primary"|"secondary"|"outline"|"ghost"|"danger"|"success"} [props.variant="primary"]
 * @param {"sm"|"md"|"lg"} [props.size="md"] md = 44px, sm = 40px.
 * @param {string} [props.icon] Leading Material Symbols icon name.
 * @param {string} [props.iconRight] Trailing Material Symbols icon name.
 * @param {string} [props.href] When set (and not disabled/loading), renders a link instead of a button.
 * @param {boolean} [props.disabled]
 * @param {boolean} [props.loading] Shows a spinner, sets `aria-busy` and disables interaction.
 * @param {boolean} [props.fullWidth]
 * @param {string} [props.className]
 */
export default function Button({
  children,
  variant = "primary",
  size = "md",
  icon,
  iconRight,
  href,
  disabled = false,
  loading = false,
  fullWidth = false,
  className,
  ...props
}) {
  const classes = cn(
    "inline-flex items-center justify-center gap-2 font-semibold transition-all duration-150 ease-out cursor-pointer",
    "active:scale-[0.97] focus-visible:outline-none focus-visible:shadow-focus",
    "disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100",
    "aria-disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:active:scale-100",
    buttonClasses(variant, size),
    fullWidth && "w-full",
    className,
  );

  const content = (
    <>
      {loading ? (
        <span className="material-symbols-outlined animate-spin text-[18px]" aria-hidden="true">
          progress_activity
        </span>
      ) : icon ? (
        <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
      {iconRight && !loading && (
        <span className="material-symbols-outlined text-[18px] rtl:-scale-x-100" aria-hidden="true">
          {iconRight}
        </span>
      )}
    </>
  );

  // Links can't be disabled natively (middle-click/context menu still navigate),
  // so a disabled/loading href renders the disabled <button> below instead.
  // Trailing directional icons (e.g. arrow_forward) mirror in RTL via
  // rtl:-scale-x-100 on the iconRight span.
  if (href && !(disabled || loading)) {
    const { type: _type, ...linkProps } = props;
    linkProps.className = classes;
    return isExternalHref(href) ? (
      <a href={href} {...linkProps}>
        {content}
      </a>
    ) : (
      <Link href={href} {...linkProps}>
        {content}
      </Link>
    );
  }

  return (
    <button
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {content}
    </button>
  );
}

Button.propTypes = {
  children: PropTypes.node,
  variant: PropTypes.oneOf(Object.keys(BUTTON_VARIANTS)),
  size: PropTypes.oneOf(Object.keys(BUTTON_SIZES)),
  icon: PropTypes.string,
  iconRight: PropTypes.string,
  href: PropTypes.string,
  disabled: PropTypes.bool,
  loading: PropTypes.bool,
  fullWidth: PropTypes.bool,
  className: PropTypes.string,
};
