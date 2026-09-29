"use client";

import PropTypes from "prop-types";
import { formatResetTime } from "@/app/(dashboard)/dashboard/quota/lib/quotaUtils.js";
import Card from "@/shared/components/Card";
import CountUp from "@/shared/components/CountUp";
import IconButton from "@/shared/components/IconButton";
import Popover from "@/shared/components/Popover";
import QuotaForecastLine from "@/shared/components/QuotaForecastLine";

// Quota counts are plain integers; rounding keeps mid-animation floats (the
// value eases between counts) at integer display, and a stable formatter keeps
// CountUp from restarting when the page re-renders for countdown ticks (YAN-398).
const COUNT_FORMAT = (value) => String(Math.round(Number(value) || 0));

/**
 * Signal Quota runway summary card:
 * Displays Healthy, Running low, Empty counts in status colors,
 * a stacked status bar with proportional widths, the next-reset line,
 * the worst at-risk forecast, and a "How forecasts work" popover.
 *
 * @param {object} props
 * @param {{healthy: number, low: number, empty: number, total: number}} props.summary
 * @param {{connectionId: string, label: string, resetAt: string}|null} props.nextReset
 * @param {{label: string, forecast: object}|null} [props.forecast] Most urgent known forecast.
 * @param {boolean} [props.hasForecasts] True when any visible row has a known forecast.
 * @param {boolean} [props.loading]
 */
export default function QuotaSummaryCard({
  summary,
  nextReset,
  forecast,
  hasForecasts = false,
  loading = false,
}) {
  const { healthy = 0, low = 0, empty = 0, total = 0 } = summary || {};
  const hasAccounts = total > 0;

  const resetCountdown = nextReset?.resetAt ? formatResetTime(nextReset.resetAt) : null;
  const resetText =
    nextReset && resetCountdown && resetCountdown !== "-"
      ? `Next reset: ${nextReset.label} in ${resetCountdown}. Empty accounts are skipped automatically.`
      : "Empty accounts are skipped automatically.";
  const worstState = forecast?.forecast?.state;
  const worstAtRisk = worstState === "will-run-out" || worstState === "tight";

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
              {loading ? "-" : <CountUp value={healthy} format={COUNT_FORMAT} />}
            </span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
              Running low
            </span>
            <span className="font-display text-3xl lg:text-4xl font-bold leading-none text-warn tabular-nums">
              {loading ? "-" : <CountUp value={low} format={COUNT_FORMAT} />}
            </span>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
              Empty
            </span>
            <span className="font-display text-3xl lg:text-4xl font-bold leading-none text-err tabular-nums">
              {loading ? "-" : <CountUp value={empty} format={COUNT_FORMAT} />}
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

          <div className="flex min-w-0 items-center gap-2">
            {!loading && hasForecasts && (
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                {worstAtRisk ? (
                  <>
                    <span className="truncate text-xs font-medium text-text" title={forecast.label}>
                      {forecast.label}
                    </span>
                    <QuotaForecastLine forecast={forecast.forecast} showReset />
                  </>
                ) : (
                  <span className="text-xs text-muted">Every forecast is on track</span>
                )}
              </div>
            )}
            <Popover
              placement="top"
              aria-label="How forecasts work"
              trigger={<IconButton icon="info" aria-label="How forecasts work" />}
            >
              <p className="text-sm font-semibold text-text">How forecasts work</p>
              <div className="mt-2 flex flex-col gap-1.5 text-xs text-muted">
                <p>Forecasts use how fast each quota dropped over the last two hours.</p>
                <p>
                  We need at least 3 readings over 10 minutes. Until then, no forecast is shown.
                </p>
                <p>
                  Readings come from quota checks that already run. Nothing extra is sent to
                  providers.
                </p>
              </div>
            </Popover>
          </div>
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
  forecast: PropTypes.shape({ label: PropTypes.string, forecast: PropTypes.object }),
  hasForecasts: PropTypes.bool,
  loading: PropTypes.bool,
};
