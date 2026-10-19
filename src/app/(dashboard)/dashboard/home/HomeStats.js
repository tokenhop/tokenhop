"use client";

import Link from "next/link";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import CountUp from "@/shared/components/CountUp";
import QuietPeriod from "@/shared/components/QuietPeriod";
import StatTile from "@/shared/components/StatTile";
import { HISTORY_PERIOD_VALUES } from "@/shared/utils/period";
import TrendLine, { PairTrendLine } from "../usage/components/TrendLine";
import { savingsTrendInput } from "../usage/lib/tileTrends";
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
 * Four StatTiles: requests (+delta +sparkline), tokens in/out (cached %),
 * est. cost, saved-by-token-saver lime hero. Driven by the shared period control.
 * Every tile carries a trend vs the previous equal window: `current.currentTotals`/
 * `current.previous` (stats compare) and `savings.currentTotals`/`savings.previous`.
 * A quiet period collapses to one compact QuietPeriod row that names the
 * real last-request time and can jump to the smallest period with data.
 *
 * @param {object} props
 * @param {object|null} props.current usage stats for the period (+ currentTotals/previous from compare=previous)
 * @param {Array|null} props.buckets /api/usage/chart buckets (requests + cost sparklines)
 * @param {object|null} props.savings /api/usage/savings aggregation (+ currentTotals/previous)
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
          allowed={HISTORY_PERIOD_VALUES}
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

  const totals = current.currentTotals;
  const prev = current.previous;
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
        trend={<TrendLine current={totals?.requests} previous={prev?.requests} period={period} />}
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
        trend={
          <PairTrendLine
            period={period}
            parts={[
              { label: "In", current: totals?.promptTokens, previous: prev?.promptTokens },
              { label: "Out", current: totals?.completionTokens, previous: prev?.completionTokens },
            ]}
          />
        }
        className="min-w-0"
      />
      <StatTile
        eyebrow="Est. cost"
        value={<CountUp value={current.totalCost} format={formatMoney} />}
        delta={<span className="text-muted">Estimate at list prices, not your bill</span>}
        trend={<TrendLine current={totals?.cost} previous={prev?.cost} period={period} />}
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
        trend={
          savingsUnavailable ? undefined : (
            <TrendLine hero {...savingsTrendInput(savings)} period={period} />
          )
        }
        className="min-w-0"
      />
    </>
  );
}

HomeStats.propTypes = {
  current: PropTypes.object,
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
  period: PropTypes.oneOf(HISTORY_PERIOD_VALUES),
  lastRequestAt: PropTypes.string,
  lastActivityLoading: PropTypes.bool,
  lastActivityError: PropTypes.string,
  onRetryLastActivity: PropTypes.func,
  onSelectPeriod: PropTypes.func,
};
