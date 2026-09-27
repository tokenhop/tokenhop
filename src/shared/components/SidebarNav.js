"use client";

import PropTypes from "prop-types";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  badgeAriaLabel,
  formatBadge,
  isActive,
  visibleGroups,
} from "@/shared/constants/navigation";
import { badgeTint } from "@/shared/utils/shell";
import { cn } from "@/shared/utils/cn";

/**
 * Grouped sidebar navigation per the Signal board: group headers (11px
 * uppercase), coral active style with FILL 1 icon, badge chips with
 * reserved space (no layout shift).
 *
 * @param {object} props
 * @param {boolean} props.enableTranslator Show the Debug translator item.
 * @param {Record<string, number|null>} [props.badges] Badge counts by badgeKey.
 * @param {{ count: number, status: "warn"|"err"|null }} [props.providerAttention]
 *   Worst needs-attention status for the Providers badge tint.
 * @param {() => void} [props.onNavigate] Called after any navigation (closes drawer).
 */

export default function SidebarNav({
  enableTranslator,
  badges = {},
  providerAttention = { count: 0, status: null },
  onNavigate,
}) {
  const pathname = usePathname() || "";
  const groups = visibleGroups({ enableTranslator }).filter((group) => group.items.length > 0);

  return (
    <nav
      aria-label="Main"
      className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto custom-scrollbar"
    >
      {groups.map((group) => (
        <div key={group.id} className="flex flex-col gap-0.5">
          <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-subtle">
            {group.label}
          </p>
          {group.items.map((item) => {
            const active = isActive(pathname, item);
            const rawCount =
              item.badgeKey && badges[item.badgeKey] != null ? badges[item.badgeKey] : null;
            const badge = rawCount != null ? formatBadge(rawCount) : null;
            const attention =
              item.badgeKey === "providers" ? providerAttention : { count: 0, status: null };
            const badgeLabel = badge
              ? badgeAriaLabel(item.badgeKey, rawCount, attention.count)
              : null;
            const tint = badge ? badgeTint(item.badgeKey, rawCount, attention.status) : null;
            return (
              <Link
                key={item.id}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                aria-label={badgeLabel ? `${item.label}, ${badgeLabel}` : undefined}
                className={cn(
                  "flex h-9 items-center gap-3 rounded-[10px] px-3 text-sm font-medium transition-colors",
                  active
                    ? "bg-coral-bg font-semibold text-coral-ink"
                    : "text-muted hover:text-text hover:bg-raised",
                )}
              >
                <span
                  className={cn("material-symbols-outlined text-[18px]", active && "fill-1")}
                  aria-hidden="true"
                >
                  {item.icon}
                </span>
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {/* Badge space always reserved (no layout shift) */}
                <span
                  aria-hidden="true"
                  className={cn(
                    "min-w-[28px] shrink-0 rounded-full px-[7px] py-px text-center font-mono text-[11px]",
                    // Invisible reserves badge space so the nav never shifts.
                    !badge && "invisible bg-raised text-muted",
                    badge && tint === "warn" && "bg-warn-bg text-warn",
                    badge && tint === "err" && "bg-err-bg text-err",
                    badge && tint === "neutral" && active && "bg-coral text-on-coral",
                    badge && tint === "neutral" && !active && "bg-raised text-muted",
                  )}
                >
                  {badge}
                </span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

SidebarNav.propTypes = {
  enableTranslator: PropTypes.bool,
  badges: PropTypes.shape({
    providers: PropTypes.number,
    combos: PropTypes.number,
    quota: PropTypes.number,
  }),
  providerAttention: PropTypes.shape({
    count: PropTypes.number,
    status: PropTypes.oneOf(["warn", "err"]),
  }),
  onNavigate: PropTypes.func,
};
