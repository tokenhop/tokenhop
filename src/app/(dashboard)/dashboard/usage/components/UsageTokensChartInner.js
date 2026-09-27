"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import Card from "@/shared/components/Card";
import SegmentedControl from "@/shared/components/SegmentedControl";
import EmptyState from "@/shared/components/EmptyState";
import { shapeChartSeries } from "../lib/usageShapes";
import { useReducedMotion } from "@/shared/hooks/useOverlay";

const fmtTokens = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n || 0);
const fmtCost = (n) => `$${(n || 0).toFixed(4)}`;

function cssVar(name, fallback) {
  if (typeof window === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * Chart body: recharts AreaChart with input (sky solid), cached (lime
 * dashed), output (coral solid). Colors read from CSS vars at runtime so
 * both themes work. Accessible <table> fallback inside <details>.
 *
 * @param {object} props
 * @param {string} [props.period="7d"]
 */
export default function UsageTokensChartInner({ period = "7d" }) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState("tokens");
  const reducedMotion = useReducedMotion();

  const [fetchError, setFetchError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    fetch(`/api/usage/chart?period=${encodeURIComponent(period)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`chart ${r.status}`))))
      .then((json) => {
        if (!cancelled && json) setData(shapeChartSeries(json));
      })
      .catch((e) => {
        if (!cancelled) setFetchError(e);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period]);

  const hasData = data.some((d) => (d.tokens || 0) > 0 || (d.cost || 0) > 0);
  const sky = cssVar("--signal-sky", "#72b7ff");
  const lime = cssVar("--signal-lime-ink", "#d5f84b");
  const coral = cssVar("--signal-coral-ink", "#ff8b70");

  return (
    <Card
      title="Tokens over time"
      action={
        <SegmentedControl
          aria-label="Chart metric"
          size="sm"
          value={viewMode}
          onChange={setViewMode}
          options={[
            { value: "tokens", label: "Tokens" },
            { value: "cost", label: "Cost" },
          ]}
        />
      }
    >
      {loading ? (
        <div className="flex h-48 items-center justify-center text-sm text-muted">Loading…</div>
      ) : fetchError ? (
        <EmptyState
          icon="error"
          title="Couldn't load chart data"
          body="Try switching period or reloading the page."
        />
      ) : !hasData ? (
        <EmptyState icon="show_chart" title="No data for this period" />
      ) : (
        <>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="usageSky" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={sky} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={sky} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="usageLime" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={lime} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={lime} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="usageCoral" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={coral} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={coral} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={viewMode === "tokens" ? fmtTokens : fmtCost}
                width={50}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--signal-bg)",
                  border: "1px solid var(--signal-line)",
                  borderRadius: "8px",
                  fontSize: "12px",
                }}
                formatter={(value, name) => {
                  if (name === "Input") return [fmtTokens(value), "Input"];
                  if (name === "Cached") return [fmtTokens(value), "Cached"];
                  if (name === "Output") return [fmtTokens(value), "Output"];
                  return [fmtCost(value), "Cost"];
                }}
              />
              <Legend />
              {viewMode === "tokens" ? (
                <>
                  <Area
                    type="monotone"
                    dataKey="input"
                    name="Input"
                    stroke={sky}
                    strokeWidth={2}
                    fill="url(#usageSky)"
                    dot={false}
                    activeDot={{ r: 4 }}
                    isAnimationActive={!reducedMotion}
                  />
                  <Area
                    type="monotone"
                    dataKey="cached"
                    name="Cached"
                    stroke={lime}
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    fill="url(#usageLime)"
                    dot={false}
                    activeDot={{ r: 4 }}
                    isAnimationActive={!reducedMotion}
                  />
                  <Area
                    type="monotone"
                    dataKey="output"
                    name="Output"
                    stroke={coral}
                    strokeWidth={2}
                    fill="url(#usageCoral)"
                    dot={false}
                    activeDot={{ r: 4 }}
                    isAnimationActive={!reducedMotion}
                  />
                </>
              ) : (
                <Area
                  type="monotone"
                  dataKey="cost"
                  name="Cost"
                  stroke={coral}
                  strokeWidth={2}
                  fill="url(#usageCoral)"
                  dot={false}
                  activeDot={{ r: 4 }}
                  isAnimationActive={!reducedMotion}
                />
              )}
            </AreaChart>
          </ResponsiveContainer>
          <details className="mt-2 text-sm text-muted">
            <summary className="cursor-pointer font-semibold">Data table</summary>
            <div className="mt-2 overflow-x-auto">
              <table>
                <caption className="sr-only">Token and cost totals per bucket</caption>
                <thead>
                  <tr>
                    <th scope="col">Period</th>
                    <th scope="col">Input</th>
                    <th scope="col">Cached</th>
                    <th scope="col">Output</th>
                    <th scope="col">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((d) => (
                    <tr key={d.label}>
                      <th scope="row">{d.label}</th>
                      <td>{fmtTokens(d.input)}</td>
                      <td>{fmtTokens(d.cached)}</td>
                      <td>{fmtTokens(d.output)}</td>
                      <td>{fmtCost(d.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </Card>
  );
}

UsageTokensChartInner.propTypes = {
  period: PropTypes.string,
};
