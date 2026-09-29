"use client";

import PropTypes from "prop-types";
import dynamic from "next/dynamic";

const UsageTokensChartInner = dynamic(() => import("./UsageTokensChartInner"), { ssr: false });

/**
 * Tokens-over-time chart (client-only recharts). Keeps recharts out of SSR.
 * Data comes from the page's shared chart fetch (useChartBuckets) — the
 * chart no longer fetches on its own.
 *
 * @param {object} props
 * @param {Array<object>} props.buckets shaped chart buckets
 * @param {boolean} props.loading
 * @param {string|null} props.error
 * @param {() => void} [props.onRetry]
 */
export default function UsageTokensChart({ buckets, loading, error, onRetry }) {
  return (
    <UsageTokensChartInner buckets={buckets} loading={loading} error={error} onRetry={onRetry} />
  );
}

UsageTokensChart.propTypes = {
  buckets: PropTypes.array,
  loading: PropTypes.bool,
  error: PropTypes.string,
  onRetry: PropTypes.func,
};
