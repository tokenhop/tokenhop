"use client";

import PropTypes from "prop-types";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { formatTokens } from "./pxpipePresentation";

const CHART = {
  stroke: "var(--signal-ok)",
  fillFrom: "var(--signal-ok-bg)",
  grid: "var(--signal-line)",
  tick: "var(--signal-muted)",
  tooltipBg: "var(--signal-panel)",
  tooltipBorder: "var(--signal-line)",
  tooltipText: "var(--signal-text)",
};

/** Client-only chart of tokens saved per day, in Signal token colors. */
export default function PxpipeSavingsChart({ data }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="gradPxpipeSignal" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={CHART.stroke} stopOpacity={0.25} />
            <stop offset="95%" stopColor={CHART.stroke} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} strokeOpacity={0.6} />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11, fill: CHART.tick }}
          tickFormatter={(d) => String(d ?? "").slice(5)}
        />
        <YAxis
          tick={{ fontSize: 11, fill: CHART.tick }}
          tickFormatter={(d) => formatTokens(Number(d) || 0)}
          width={48}
        />
        <Tooltip
          formatter={(v) => [formatTokens(v), "Tokens saved"]}
          labelFormatter={(d) => d}
          contentStyle={{
            background: CHART.tooltipBg,
            border: `1px solid ${CHART.tooltipBorder}`,
            color: CHART.tooltipText,
          }}
        />
        <Area
          type="monotone"
          dataKey="tokensSavedEst"
          stroke={CHART.stroke}
          fill="url(#gradPxpipeSignal)"
          strokeWidth={2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

PxpipeSavingsChart.propTypes = {
  data: PropTypes.arrayOf(PropTypes.object).isRequired,
};
