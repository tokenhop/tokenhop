"use client";

import PropTypes from "prop-types";
import StatTile from "@/shared/components/StatTile";
import EmptyState from "@/shared/components/EmptyState";
import { Skeleton } from "@/shared/components/Loading";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtShort = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n || 0);
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;

/**
 * 5 Signal tiles: Requests, Input (sky), Cached (lime-ink + share of input),
 * Output (coral-ink + avg per request), Est. cost ("List prices, not your
 * bill"). No period-over-period delta: there is no previous-window endpoint
 * and calendar windows like "today" have no clean baseline, so tiles show
 * in-period context instead (see useUsageStats).
 *
 * @param {object} props
 * @param {object|null} props.stats stats shape from /api/usage/stats
 * @param {boolean} [props.loading]
 */
export default function UsageStatsCards({ stats, loading = false }) {
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
  if (input === 0 && output === 0 && requests === 0) {
    return (
      <EmptyState
        icon="bar_chart"
        title="No usage in this period"
        body="Make a request through the gateway and it will show up here."
      />
    );
  }
  const cachedShare = input > 0 ? Math.round((cached / input) * 100) : 0;
  const avgOut = requests > 0 ? Math.round(output / requests) : 0;
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 md:grid-cols-3 lg:grid-cols-5">
      <StatTile eyebrow="Requests" value={fmt(requests)} delta="In this period" />
      <StatTile
        eyebrow="Input tokens"
        value={<span className="text-sky">{fmtShort(input)}</span>}
        delta="After token saver"
      />
      <StatTile
        eyebrow="Cached"
        value={<span className="text-lime-ink">{fmtShort(cached)}</span>}
        delta={`${cachedShare}% of input`}
      />
      <StatTile
        eyebrow="Output tokens"
        value={<span className="text-coral-ink">{fmtShort(output)}</span>}
        delta={`Avg ${fmt(avgOut)} per request`}
      />
      <StatTile
        eyebrow="Est. cost"
        value={fmtCost(stats.totalCost)}
        delta="List prices, not your bill"
      />
    </div>
  );
}

UsageStatsCards.propTypes = {
  stats: PropTypes.object,
  loading: PropTypes.bool,
};
