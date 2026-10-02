"use client";

import Link from "next/link";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import CountUp from "@/shared/components/CountUp";
import QuietPeriod from "@/shared/components/QuietPeriod";
import StatTile from "@/shared/components/StatTile";
import { periodDelta } from "@/shared/utils/commandCenter";
import { PERIOD_VALUES } from "@/shared/utils/period";
import { cachedShare, formatCompact, formatInt, formatMoney } from "./format";
import { WidgetError, WidgetSkeleton } from "./WidgetStates";

/** Human names for recorded token-saver methods. */
const METHOD_LABELS = { rtk: "RTK", headroom: "Headroom", pxpipe: "PXPIPE" };

/**
 * Requests sparkline from /api/usage/chart buckets: the same window as the
 * cost sparkline, so the line follows the selected period instead of the
 * old fixed last-10-minutes window.
 * @param {Array<{ requests?: number }>|null|undefined} buckets
 * @returns {Array<number>|undefined}
 */
export function requestsSparkline(buckets) {
  if (!Array.isArray(buckets) || buckets.length < 2) return undefined;
  return buckets.map((bucket) => Number(bucket?.requests) || 0);
}

/**
 * Cost sparkline from /api/usage/chart buckets.
 * @param {Array<{ cost?: number }>|null|undefined} buckets
 * @returns {Array<number>|undefined}
 */
export function costSparkline(buckets) {
  if (!Array.isArray(buckets) || buckets.length < 2) return undefined;
  return buckets.map((bucket) => Number(bucket?.cost) || 0);
}

/**
 * Signed delta line: "+12% vs previous period"; "No previous data" when the
 * backend could not supply a previous-period count or it was zero.
 * @param {number} current
 * @param {number|null|undefined} previous
 * @returns {React.ReactNode}
 */
export function deltaLine(current, previous) {
  if (!Number.isFinite(previous)) return <span className="text-muted">Delta unavailable</span>;
  const { delta, pct } = periodDelta(current, previous);
  if (pct === null) return <span className="text-muted">No previous data</span>;
  const sign = delta > 0 ? "+" : "";
  return (
    <span>
      <span className={`font-semibold ${delta >= 0 ? "text-ok" : "text-err"}`}>
        {sign}
        {pct}%
      </span>{" "}
      <span className="text-muted">vs previous period</span>
    </span>
  );
}

/**
 * Four StatTiles: requests (+delta +sparkline), tokens in/out (cached %),
 * est. cost, saved-by-token-saver lime hero. Driven by the shared period control.
 * A quiet period collapses to one compact QuietPeriod row that names the
 * real last-request time and can jump to the smallest period with data.
 *
 * @param {object} props
 * @param {object|null} props.current usage stats for the period
 * @param {number|null} [props.previousRequests] previous-period request count from /api/home/summary
 * @param {Array|null} props.buckets /api/usage/chart buckets (requests + cost sparklines)
 * @param {object|null} props.savings /api/usage/savings aggregation
 * @param {boolean} [props.savingsUnavailable] savings endpoint failed
 * @param {boolean} props.loading
 * @param {string|null} props.error
 * @param {() => void} props.onRetry
 * @param {"today"|"24h"|"7d"|"30d"|"60d"|null} props.period selected period for the quiet state
 * @param {string|null|undefined} props.lastRequestAt ISO time of the last request (undefined until loaded)
 * @param {boolean} [props.lastActivityLoading] true while last-activity loads
 * @param {string|null} [props.lastActivityError] last-activity fetch error
 * @param {() => void} [props.onRetryLastActivity] re-read last activity
 * @param {(period: string) => void} props.onSelectPeriod jump to a period with data
 */
export default function HomeStats({
  current,
  previousRequests,
  buckets,
  savings,
  savingsUnavailable = false,
  loading,
  error,
  onRetry,
  period,
  lastRequestAt,
  lastActivityLoading = false,
  lastActivityError = null,
  onRetryLastActivity,
  onSelectPeriod,
}) {
  if (loading) {
    return [0, 1, 2, 3].map((index) => (
      <Card key={`home-stat-skel-${index}`}>
        <WidgetSkeleton lines={2} label="Loading stats" />
      </Card>
    ));
  }
  if (error) {
    return (
      <Card className="min-w-0 sm:col-span-2 lg:col-span-4">
        <WidgetError message={error} onRetry={onRetry} />
      </Card>
    );
  }
  if (!current?.totalRequests) {
    return (
      <Card className="min-w-0 sm:col-span-2 lg:col-span-4" padding="none">
        <QuietPeriod
          compact
          period={period}
          lastRequestAt={lastRequestAt}
          loading={lastActivityLoading}
          error={lastActivityError}
          onRetry={onRetryLastActivity}
          onSelectPeriod={onSelectPeriod}
          headingAs="h2"
        />
      </Card>
    );
  }

  const requests = current.totalRequests;
  const prompt = current.totalPromptTokens || 0;
  const completion = current.totalCompletionTokens || 0;
  const share = cachedShare(current.totalCachedTokens, prompt);
  const saved = savings && savings.tokensSavedEst > 0 ? savings : null;
  const methods = saved ? saved.methods.map((method) => METHOD_LABELS[method] || method) : [];

  let savingsLine = "Nothing saved yet in this period";
  if (saved) {
    savingsLine = `${Math.round(saved.percentage)}% lighter${methods.length ? ` · ${methods.join(" + ")}` : ""}`;
  } else if (savingsUnavailable) {
    savingsLine = "Savings data unavailable";
  }

  return (
    <>
      <StatTile
        eyebrow="Requests"
        value={<CountUp value={requests} format={formatInt} />}
        delta={deltaLine(requests, previousRequests)}
        sparkline={requestsSparkline(buckets)}
        className="min-w-0 text-sky"
      />
      <StatTile
        eyebrow="Tokens in / out"
        value={
          <span>
            <CountUp value={prompt} format={formatCompact} />
            <span className="text-[22px] text-muted">
              {" "}
              / <CountUp value={completion} format={formatCompact} />
            </span>
          </span>
        }
        delta={
          share === null ? (
            <span className="text-muted">No prompt tokens yet</span>
          ) : (
            <span>
              <span className="font-semibold text-ok">{share}% cached</span>{" "}
              <span className="text-muted">· prompt cache hits</span>
            </span>
          )
        }
        className="min-w-0"
      />
      <StatTile
        eyebrow="Est. cost"
        value={<CountUp value={current.totalCost} format={formatMoney} />}
        delta={<span className="text-muted">Estimate at list prices, not your bill</span>}
        sparkline={costSparkline(buckets)}
        className="min-w-0 text-coral-ink"
      />
      <StatTile
        hero
        eyebrow="Saved by token saver"
        value={
          saved ? (
            <CountUp value={saved.tokensSavedEst} format={formatCompact} suffix=" tokens" />
          ) : savingsUnavailable ? (
            "—"
          ) : (
            "0 tokens"
          )
        }
        delta={
          <span>
            {savingsLine}
            {" · "}
            <Link href="/dashboard/token-saver" className="font-semibold underline">
              Tune
            </Link>
          </span>
        }
        className="min-w-0"
      />
    </>
  );
}

HomeStats.propTypes = {
  current: PropTypes.object,
  previousRequests: PropTypes.number,
  buckets: PropTypes.array,
  savings: PropTypes.shape({
    tokensSavedEst: PropTypes.number,
    percentage: PropTypes.number,
    methods: PropTypes.arrayOf(PropTypes.string),
  }),
  savingsUnavailable: PropTypes.bool,
  loading: PropTypes.bool,
  error: PropTypes.string,
  onRetry: PropTypes.func.isRequired,
  period: PropTypes.oneOf(PERIOD_VALUES),
  lastRequestAt: PropTypes.string,
  lastActivityLoading: PropTypes.bool,
  lastActivityError: PropTypes.string,
  onRetryLastActivity: PropTypes.func,
  onSelectPeriod: PropTypes.func,
};
