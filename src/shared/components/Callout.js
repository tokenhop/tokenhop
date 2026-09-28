"use client";

import PropTypes from "prop-types";

const VARIANTS = {
  info: { classes: "bg-sky-bg text-sky-ink", icon: "info" },
  warn: { classes: "bg-warn-bg text-warn", icon: "warning" },
  err: { classes: "bg-err-bg text-err", icon: "error" },
  ok: { classes: "bg-ok-bg text-ok", icon: "check_circle" },
};

/** Tinted callout with a leading Material Symbols icon. */
export default function Callout({ variant = "info", title, children, icon, className }) {
  const style = VARIANTS[variant];
  if (!style) throw new Error(`Callout: unknown variant "${variant}"`);
  return (
    <div
      role={variant === "err" ? "alert" : "status"}
      className={`flex gap-3 rounded-xl p-4 text-sm ${style.classes}${className ? ` ${className}` : ""}`}
    >
      <span className="material-symbols-outlined shrink-0 text-[20px]" aria-hidden="true">
        {icon ?? style.icon}
      </span>
      <div className="min-w-0 text-text">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="text-muted">{children}</div>}
      </div>
    </div>
  );
}

Callout.propTypes = {
  variant: PropTypes.oneOf(Object.keys(VARIANTS)),
  title: PropTypes.node,
  children: PropTypes.node,
  icon: PropTypes.string,
  className: PropTypes.string,
};
