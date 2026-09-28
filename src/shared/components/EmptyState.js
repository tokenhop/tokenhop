"use client";

import PropTypes from "prop-types";

/** Empty state: icon, title, body and an optional call-to-action slot. */
export default function EmptyState({
  icon = "inbox",
  title,
  body,
  action,
  className,
  as: Heading = "h2",
}) {
  return (
    <div
      className={`flex flex-col items-center gap-3 px-6 py-12 text-center${className ? ` ${className}` : ""}`}
    >
      <span className="flex size-12 items-center justify-center rounded-xl bg-raised text-muted">
        <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
          {icon}
        </span>
      </span>
      <Heading className="font-display text-lg font-bold text-text">{title}</Heading>
      {body && <p className="max-w-[48ch] text-sm text-muted">{body}</p>}
      {action}
    </div>
  );
}

EmptyState.propTypes = {
  icon: PropTypes.string,
  title: PropTypes.node.isRequired,
  body: PropTypes.node,
  action: PropTypes.node,
  className: PropTypes.string,
  as: PropTypes.oneOf(["h1", "h2", "h3", "h4", "p", "div"]),
};
