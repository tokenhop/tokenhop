"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import Meter from "@/shared/components/Meter";
import ProviderTile from "@/shared/components/ProviderTile";
import { pickLowestQuotaAccounts } from "@/shared/utils/commandCenter";
import { formatReset } from "./format";
import { WidgetEmpty, WidgetError, WidgetSkeleton } from "./WidgetStates";

/**
 * Quota watch: 3 lowest cached accounts (no upstream probes). Each shows
 * provider tile, remaining meter and reset time. Unlimited/credits kind is
 * labeled without an invented percentage.
 *
 * @param {object} props
 * @param {Array<object>} props.accounts cached quota snapshot accounts
 * @param {boolean} props.loading
 * @param {string|null} props.error
 * @param {() => void} props.onRetry
 */
export default function QuotaWatch({ accounts, loading, error, onRetry }) {
  if (loading) return <WidgetSkeleton lines={3} label="Loading quota watch" />;
  if (error) return <WidgetError message={error} onRetry={onRetry} />;
  if (accounts.length === 0) {
    return (
      <WidgetEmpty
        icon="data_usage"
        title="No quota snapshots yet"
        body="Connect a provider and use its account; quotas appear when a provider reports them."
        actionLabel="Connect your first provider"
        actionHref="/dashboard/providers"
      />
    );
  }

  const lowest = pickLowestQuotaAccounts(accounts);
  return (
    <ul className="flex min-w-0 flex-col gap-4" aria-label="Accounts with lowest quota">
      {lowest.map((account) => {
        const remaining = Number.isFinite(account.remaining) ? account.remaining : null;
        const label = account.name || account.provider || "Account";
        const kind =
          account.kind === "unlimited" || account.kind === "credits" ? account.kind : undefined;
        const leftText =
          kind === "unlimited"
            ? "Unlimited"
            : remaining === null
              ? "Unknown"
              : `${Math.round(remaining)}% left`;
        const reset = formatReset(account.resetsAt);
        return (
          <li key={account.id} className="flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 items-center gap-2.5">
              <ProviderTile providerId={account.provider || "unknown"} size="sm" />
              <span
                className="min-w-0 flex-1 truncate text-sm font-semibold text-text"
                title={label}
              >
                {label}
              </span>
              <span
                className={`shrink-0 font-mono text-[13px] font-semibold ${
                  remaining === null
                    ? "text-muted"
                    : remaining <= 20
                      ? "text-err"
                      : remaining <= 45
                        ? "text-warn"
                        : "text-ok"
                }`}
              >
                {leftText}
              </span>
            </div>
            <Meter
              value={remaining === null ? 0 : remaining}
              kind={kind}
              label={`${label} remaining quota`}
              valueText={leftText}
            />
            <span className="text-xs text-muted">{reset || "Reset time unknown"}</span>
          </li>
        );
      })}
    </ul>
  );
}

QuotaWatch.propTypes = {
  accounts: PropTypes.arrayOf(PropTypes.object),
  loading: PropTypes.bool,
  error: PropTypes.string,
  onRetry: PropTypes.func.isRequired,
};

/** Card wrapper so the page grid stays dumb. */
export function QuotaWatchCard(props) {
  return (
    <Card
      className="min-w-0"
      title="Quota watch"
      action={
        <a
          href="/dashboard/quota"
          className="text-[13px] font-semibold text-coral-ink hover:text-coral"
        >
          All quotas →
        </a>
      }
    >
      <QuotaWatch {...props} />
    </Card>
  );
}
