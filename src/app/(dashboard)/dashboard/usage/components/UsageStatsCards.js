"use client";

import PropTypes from "prop-types";
import StatTile from "@/shared/components/StatTile";
import { Skeleton } from "@/shared/components/Loading";
import { bucketSeries, NO_PRIOR, PRIOR_LABELS, trendDelta } from "../lib/tileTrends";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtShort = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n || 0);
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;

// Sparkline stroke inherits currentColor, so a tile's className text color
// doubles as the sparkline color (mirrors the value accents).
const SPARKLINE_TONE = {
  requests: "text-muted",
  input: "text-sky",
  cached: "text-lime-ink",
  output: "text-coral-ink",
  cost: "text-muted",
};

/**
 * Trend line: signed percentage vs the previous equal window plus the
 * period caption, or muted "No prior data" without a usable baseline.
 * Percentage and caption are separate spans — no concatenated sentence.
 * @param {object} props
 * @param {number} current
 * @param {number} previous
 * @param {string} period
 * @returns {React.ReactNode}
 */
function TrendLine({ current, previous, period }) {
  const delta = trendDelta(current, previous);
  if (delta.kind === "none") {
    return <span className="text-muted">{NO_PRIOR.caption}</span>;
  }
  const tone = delta.kind === "up" ? "text-ok" : delta.kind === "down" ? "text-err" : "text-muted";
  const caption = (PRIOR_LABELS[period] || PRIOR_LABELS.default).caption;
  return (
    <span>
      <span className={`font-semibold ${tone}`}>
        {delta.pct > 0 ? "+" : ""}
        {delta.pct}%
      </span>{" "}
      <span className="text-muted">{caption}</span>
    </span>
  );
}

TrendLine.propTypes = {
  current: PropTypes.number,
  previous: PropTypes.number,
  period: PropTypes.string,
};

/**
 * 5 Signal tiles: Requests, Input (sky), Cached (lime-ink + share of input),
 * Output (coral-ink + avg per request), Est. cost ("List prices, not your
 * bill"). Each keeps its context line (`delta`) and adds a trend line and a
 * period sparkline. The percentage compares the previous-window totals —
 * both sides come from getUsageTotals via /api/usage/stats?compare=previous,
 * so they share one source; the headline numbers keep using `stats`.
 *
 * The page owns the empty state: a period with no requests never reaches
 * these tiles (the page renders the shared QuietPeriod instead), so this
 * component only handles loading and filled snapshots.
 *
 * @param {object} props
 * @param {object|null} props.stats stats shape from /api/usage/stats
 * @param {boolean} [props.loading]
 * @param {object|null} [props.previous] previous-window totals (same source as currentTotals)
 * @param {object|null} [props.currentTotals] current-window totals from getUsageTotals
 * @param {Array|null} [props.buckets] chart buckets shaped by shapeChartSeries (sparklines)
 * @param {string} [props.period] selected period (trend caption)
 */
export default function UsageStatsCards({
  stats,
  loading = false,
  previous = null,
  currentTotals = null,
  buckets = null,
  period = "",
}) {
  if (loading || !stats) {
    return (
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 md:grid-cols-3 lg:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-[104px] rounded-2xl" />
        ))}
      </div>
    );
  }
  const input = stats.totalPromptTokens || 0;
  const cached = stats.totalCachedTokens || 0;
  const output = stats.totalCompletionTokens || 0;
  const requests = stats.totalRequests || 0;
  const cachedShare = input > 0 ? Math.round((cached / input) * 100) : 0;
  const avgOut = requests > 0 ? Math.round(output / requests) : 0;

  const tiles = [
    {
      eyebrow: "Requests",
      value: fmt(requests),
      delta: "In this period",
      field: "requests",
      current: currentTotals?.requests,
      prev: previous?.requests,
    },
    {
      eyebrow: "Input tokens",
      value: <span className="text-sky">{fmtShort(input)}</span>,
      delta: "After token saver",
      field: "input",
      current: currentTotals?.promptTokens,
      prev: previous?.promptTokens,
    },
    {
      eyebrow: "Cached",
      value: <span className="text-lime-ink">{fmtShort(cached)}</span>,
      delta: `${cachedShare}% of input`,
      field: "cached",
      current: currentTotals?.cachedTokens,
      prev: previous?.cachedTokens,
    },
    {
      eyebrow: "Output tokens",
      value: <span className="text-coral-ink">{fmtShort(output)}</span>,
      delta: `Avg ${fmt(avgOut)} per request`,
      field: "output",
      current: currentTotals?.completionTokens,
      prev: previous?.completionTokens,
    },
    {
      eyebrow: "Est. cost",
      value: fmtCost(stats.totalCost),
      delta: "List prices, not your bill",
      field: "cost",
      current: currentTotals?.cost,
      prev: previous?.cost,
    },
  ];

  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 md:grid-cols-3 lg:grid-cols-5">
      {tiles.map((tile) => (
        <StatTile
          key={tile.eyebrow}
          eyebrow={tile.eyebrow}
          value={tile.value}
          delta={tile.delta}
          trend={<TrendLine current={tile.current} previous={tile.prev} period={period} />}
          sparkline={bucketSeries(buckets, tile.field)}
          className={`min-w-0 ${SPARKLINE_TONE[tile.field]}`}
        />
      ))}
    </div>
  );
}

UsageStatsCards.propTypes = {
  stats: PropTypes.object,
  loading: PropTypes.bool,
  previous: PropTypes.object,
  currentTotals: PropTypes.object,
  buckets: PropTypes.array,
  period: PropTypes.string,
};
