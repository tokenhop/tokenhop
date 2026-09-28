"use client";

import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";

const PADDINGS = { none: "", xs: "p-3", sm: "p-4", md: "p-6", lg: "p-8" };

/**
 * Signal card: panel, 1px line, radius 20, card shadow. `title`/`action`
 * render a Card.Header; compose `<Card.Header>` directly for custom headers.
 *
 * @param {object} props
 * @param {"none"|"xs"|"sm"|"md"|"lg"} [props.padding="md"]
 * @param {boolean} [props.hover] Coral border on hover (clickable cards).
 * @param {boolean} [props.elev] Accepted for existing call sites; ignored.
 *   Signal defines a single card elevation (design-system §4), so every card
 *   already uses `shadow-card`.
 */
export default function Card({
  children,
  title,
  subtitle,
  icon,
  action,
  as = "h2",
  padding = "md",
  hover = false,
  elev: _legacyElev = false,
  className,
  role,
  ...props
}) {
  if (PADDINGS[padding] === undefined) throw new Error(`Card: unknown padding "${padding}"`);
  const resolvedRole =
    role || (props["aria-label"] || props["aria-labelledby"] ? "region" : undefined);
  return (
    <div
      role={resolvedRole}
      className={cn(
        "rounded-2xl border border-line bg-panel shadow-card",
        hover && "cursor-pointer transition-colors duration-150 hover:border-coral/40",
        PADDINGS[padding],
        className,
      )}
      {...props}
    >
      {(title || action) && (
        <Card.Header
          title={title}
          subtitle={subtitle}
          icon={icon}
          actions={action}
          as={as}
          className="mb-4"
        />
      )}
      {children}
    </div>
  );
}

Card.propTypes = {
  children: PropTypes.node,
  title: PropTypes.node,
  subtitle: PropTypes.node,
  icon: PropTypes.string,
  action: PropTypes.node,
  as: PropTypes.oneOf(["h2", "h3", "h4"]),
  padding: PropTypes.oneOf(Object.keys(PADDINGS)),
  hover: PropTypes.bool,
  elev: PropTypes.bool,
  className: PropTypes.string,
  role: PropTypes.string,
};

/** Card header: display title (+ subtitle, optional icon tile) with an actions slot. */
Card.Header = function CardHeader({
  title,
  subtitle,
  icon,
  actions,
  as: Heading = "h2",
  className,
}) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3", className)}>
      <div className="flex min-w-0 items-center gap-3">
        {icon && (
          <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-coral-bg text-coral-ink">
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
              {icon}
            </span>
          </span>
        )}
        <div className="min-w-0">
          {title && <Heading className="font-display text-lg font-bold text-text">{title}</Heading>}
          {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
};

Card.Header.propTypes = {
  title: PropTypes.node,
  subtitle: PropTypes.node,
  icon: PropTypes.string,
  actions: PropTypes.node,
  as: PropTypes.oneOf(["h2", "h3", "h4"]),
  className: PropTypes.string,
};

Card.Section = function CardSection({ children, className, ...props }) {
  return (
    <div className={cn("rounded-xl border border-line bg-raised p-4", className)} {...props}>
      {children}
    </div>
  );
};

Card.Row = function CardRow({ children, className, ...props }) {
  return (
    <div
      className={cn(
        "-mx-3 border-b border-line p-3 px-3 transition-colors last:border-b-0 hover:bg-raised",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
};

Card.ListItem = function CardListItem({ children, actions, className, ...props }) {
  return (
    <div
      className={cn(
        "group -mx-3 flex items-center justify-between border-b border-line p-3 px-3 transition-colors last:border-b-0 hover:bg-raised",
        className,
      )}
      {...props}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {actions && (
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          {actions}
        </div>
      )}
    </div>
  );
};
