"use client";

import { memo } from "react";
import PropTypes from "prop-types";
import dynamic from "next/dynamic";

const UsageTokensChartInner = dynamic(() => import("./UsageTokensChartInner"), { ssr: false });

// Shaped chart bucket (shapeChartSeries output). Every field is optional —
// the same shape flows through UsageTokensChartInner below.
const BUCKETS_PROP = PropTypes.arrayOf(
  PropTypes.shape({
    label: PropTypes.string,
    input: PropTypes.number,
    cached: PropTypes.number,
    output: PropTypes.number,
    tokens: PropTypes.number,
    cost: PropTypes.number,
    requests: PropTypes.number,
  }),
);

/**
 * Tokens-over-time chart (client-only recharts). Keeps recharts out of SSR.
 * Data comes from the page's shared chart fetch (useChartBuckets) — the
 * chart no longer fetches on its own. Memoized: the page re-renders on live
 * frames while these props stay referentially stable.
 *
 * @param {object} props
 * @param {Array<object>} [props.buckets] shaped chart buckets
 * @param {boolean} [props.loading]
 * @param {string|null} [props.error]
 * @param {() => void} [props.onRetry]
 */
function UsageTokensChart({ buckets, loading, error, onRetry }) {
  return (
    <UsageTokensChartInner buckets={buckets} loading={loading} error={error} onRetry={onRetry} />
  );
}

export default memo(UsageTokensChart);

UsageTokensChart.propTypes = {
  buckets: BUCKETS_PROP,
  loading: PropTypes.bool,
  error: PropTypes.string,
  onRetry: PropTypes.func,
};
