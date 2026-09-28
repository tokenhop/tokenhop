"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import StatTile from "@/shared/components/StatTile";
import { periodDelta } from "@/shared/utils/commandCenter";
import { cachedShare, formatCompact, formatInt, formatMoney } from "./format";
import { WidgetEmpty, WidgetError, WidgetSkeleton } from "./WidgetStates";

/** Human names for recorded token-saver methods. */
const METHOD_LABELS = { rtk: "RTK", headroom: "Headroom", pxpipe: "PXPIPE" };

/**
 * Requests sparkline from per-minute request buckets (last 10 minutes).
 * Chart buckets hold tokens/cost, not request counts, so they drive the cost line instead.
 * @param {Array<{ requests?: number }>|null|undefined} last10Minutes
 * @returns {Array<number>|undefined}
 */
export function requestsSparkline(last10Minutes) {
  if (!Array.isArray(last10Minutes) || last10Minutes.length < 2) return undefined;
  return last10Minutes.map((bucket) => Number(bucket?.requests) || 0);
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
 * est. cost, saved-by-token-saver lime hero. Driven by Today/7d/30d.
 *
 * @param {object} props
 * @param {object|null} props.current usage stats for the period
 * @param {number|null} [props.previousRequests] previous-period request count from /api/home/summary
 * @param {Array|null} props.buckets /api/usage/chart buckets (cost sparkline)
 * @param {object|null} props.savings /api/usage/savings aggregation
 * @param {boolean} [props.savingsUnavailable] savings endpoint failed
 * @param {boolean} props.loading
 * @param {string|null} props.error
 * @param {() => void} props.onRetry
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
      <Card className="min-w-0 sm:col-span-2 lg:col-span-4">
        <WidgetEmpty
          icon="bar_chart"
          title="No traffic in this period"
          body="Send your first request through the endpoint above, then watch the numbers land here."
          actionLabel="View Usage"
          actionHref="/dashboard/usage"
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

  let savingsValue = "0 tokens";
  let savingsLine = "Nothing saved yet in this period";
  if (saved) {
    savingsValue = `${formatCompact(saved.tokensSavedEst)} tokens`;
    savingsLine = `${Math.round(saved.percentage)}% lighter${methods.length ? ` · ${methods.join(" + ")}` : ""}`;
  } else if (savingsUnavailable) {
    savingsValue = "—";
    savingsLine = "Savings data unavailable";
  }

  return (
    <>
      <StatTile
        eyebrow="Requests"
        value={formatInt(requests)}
        delta={deltaLine(requests, previousRequests)}
        sparkline={requestsSparkline(current.last10Minutes)}
        className="min-w-0 text-sky"
      />
      <StatTile
        eyebrow="Tokens in / out"
        value={
          <span>
            {formatCompact(prompt)}
            <span className="text-[22px] text-muted"> / {formatCompact(completion)}</span>
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
        value={formatMoney(current.totalCost)}
        delta={<span className="text-muted">Estimate at list prices, not your bill</span>}
        sparkline={costSparkline(buckets)}
        className="min-w-0 text-coral-ink"
      />
      <StatTile
        hero
        eyebrow="Saved by token saver"
        value={savingsValue}
        delta={
          <span>
            {savingsLine}
            {" · "}
            <a href="/dashboard/token-saver" className="font-semibold underline">
              Tune
            </a>
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
};
