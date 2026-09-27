"use client";

import PropTypes from "prop-types";
import { formatResetTime } from "@/app/(dashboard)/dashboard/quota/lib/quotaUtils.js";
import Card from "@/shared/components/Card";

/**
 * Signal Quota runway summary card:
 * Displays Healthy, Running low, Empty counts in status colors,
 * a stacked status bar with proportional widths, and the next-reset line.
 *
 * @param {object} props
 * @param {{healthy: number, low: number, empty: number, total: number}} props.summary
 * @param {{connectionId: string, label: string, resetAt: string}|null} props.nextReset
 * @param {boolean} [props.loading]
 */
export default function QuotaSummaryCard({ summary, nextReset, loading = false }) {
  const { healthy = 0, low = 0, empty = 0, total = 0 } = summary || {};
  const hasAccounts = total > 0;

  const resetCountdown = nextReset?.resetAt ? formatResetTime(nextReset.resetAt) : null;
  const resetText =
    nextReset && resetCountdown && resetCountdown !== "-"
      ? `Next reset: ${nextReset.label} in ${resetCountdown}. Empty accounts are skipped automatically.`
      : "Empty accounts are skipped automatically.";

  return (
    <Card
      padding="none"
      className="p-5 lg:p-6"
      data-testid="quota-summary-card"
      role="region"
      aria-label="Quota summary"
    >
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:gap-8">
        {/* Count blocks */}
        <div className="flex items-center gap-6 sm:gap-8">
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
              Healthy
            </span>
            <span className="font-display text-3xl lg:text-4xl font-bold leading-none text-ok tabular-nums">
              {loading ? "-" : healthy}
            </span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
              Running low
            </span>
            <span className="font-display text-3xl lg:text-4xl font-bold leading-none text-warn tabular-nums">
              {loading ? "-" : low}
            </span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
              Empty
            </span>
            <span className="font-display text-3xl lg:text-4xl font-bold leading-none text-err tabular-nums">
              {loading ? "-" : empty}
            </span>
          </div>
        </div>

        {/* Stacked bar and next-reset note */}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div
            role="progressbar"
            aria-label="Fleet quota runway"
            aria-valuemin={0}
            aria-valuemax={total || 1}
            aria-valuenow={healthy}
            aria-valuetext={`${healthy} healthy, ${low} running low, ${empty} empty`}
            className="flex h-3.5 w-full gap-1 overflow-hidden rounded-pill bg-raised p-0.5 shadow-[inset_0_0_0_1px_var(--signal-line)]"
          >
            {hasAccounts ? (
              <>
                {healthy > 0 && (
                  <span
                    className="h-full rounded-pill bg-ok transition-all duration-300"
                    style={{ flexGrow: healthy }}
                    title={`${healthy} healthy accounts`}
                  />
                )}
                {low > 0 && (
                  <span
                    className="h-full rounded-pill bg-warn transition-all duration-300"
                    style={{ flexGrow: low }}
                    title={`${low} running low accounts`}
                  />
                )}
                {empty > 0 && (
                  <span
                    className="h-full rounded-pill bg-err transition-all duration-300"
                    style={{ flexGrow: empty }}
                    title={`${empty} empty accounts`}
                  />
                )}
              </>
            ) : (
              <span className="h-full w-full rounded-pill bg-line/60" />
            )}
          </div>

          <p className="text-xs text-muted leading-relaxed">{resetText}</p>
        </div>
      </div>
    </Card>
  );
}

QuotaSummaryCard.propTypes = {
  summary: PropTypes.shape({
    healthy: PropTypes.number,
    low: PropTypes.number,
    empty: PropTypes.number,
    total: PropTypes.number,
  }),
  nextReset: PropTypes.shape({
    connectionId: PropTypes.string,
    label: PropTypes.string,
    resetAt: PropTypes.string,
  }),
  loading: PropTypes.bool,
};
