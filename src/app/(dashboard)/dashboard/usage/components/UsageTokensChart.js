"use client";

import PropTypes from "prop-types";
import dynamic from "next/dynamic";

const UsageTokensChartInner = dynamic(() => import("./UsageTokensChartInner"), { ssr: false });

/**
 * Tokens-over-time chart (client-only recharts). Keeps recharts out of SSR.
 *
 * @param {object} props
 * @param {string} [props.period="7d"]
 */
export default function UsageTokensChart({ period = "7d" }) {
  return <UsageTokensChartInner period={period} />;
}

UsageTokensChart.propTypes = {
  period: PropTypes.string,
};
