"use client";

import PropTypes from "prop-types";

/**
 * Empty state: icon, title, body and an optional call-to-action slot.
 * `compact` renders a horizontal row (inline heading and body, action at the
 * end) for widget rows; the default is the centered card.
 */
export default function EmptyState({
  icon = "inbox",
  title,
  body,
  action,
  className,
  as: Heading = "h2",
  compact = false,
}) {
  if (compact) {
    return (
      <div
        className={`flex flex-row items-center gap-3 px-4 py-3 text-start${className ? ` ${className}` : ""}`}
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-raised text-muted">
          <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
            {icon}
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <Heading className="inline text-sm font-semibold text-text">{title}</Heading>
          {body && <span className="text-sm text-muted"> {body}</span>}
        </div>
        {action && <div className="ms-auto">{action}</div>}
      </div>
    );
  }
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
  compact: PropTypes.bool,
};
