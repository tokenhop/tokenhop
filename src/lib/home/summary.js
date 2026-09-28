import { aggregateSavings, resolvePeriodRange } from "./savings.js";
import { periodDelta } from "@/shared/utils/commandCenter.js";

/**
 * Aggregate stored usage rows into a Home summary.
 * History rows carry promptTokens/completionTokens/cost columns plus
 * meta.savings (see saveRequestUsage) and meta.comboName.
 *
 * Pure function, no IO — unit testable without a DB.
 *
 * @param {object} options
 * @param {Array<object>} [options.history] rows from getUsageHistory.
 * @param {Array<object>} [options.combos] rows from getCombos.
 * @param {object} [options.comboStrategies] settings.comboStrategies map.
 * @param {string} [options.period="7d"] "today" | "7d" | "30d".
 * @param {number} [options.now] epoch ms.
 * @returns {{ period: string, currentRequests: number, previousRequests: number,
 *   requestsDelta: { delta: number, pct: number|null }, savings: object, topCombos: Array<object> }}
 */
export function computeHomeSummary({
  history = [],
  combos = [],
  comboStrategies = {},
  period = "7d",
  now = Date.now(),
} = {}) {
  const { startMs, endMs, prevStartMs, prevEndMs } = resolvePeriodRange(period, now);

  const inRange = (ts, start, end) => {
    if (!ts) return false;
    const t = new Date(ts).getTime();
    return !Number.isNaN(t) && t >= start && t <= end;
  };

  const currentRows = (history || []).filter((row) => inRange(row?.timestamp, startMs, endMs));
  const previousRows = (history || []).filter((row) =>
    inRange(row?.timestamp, prevStartMs, prevEndMs),
  );

  const savings = aggregateSavings(currentRows, period, now);

  // Top 2 combos: count requests in current window by meta.comboName.
  const counts = new Map();
  for (const row of currentRows) {
    if (row?.comboName) counts.set(row.comboName, (counts.get(row.comboName) || 0) + 1);
  }

  const comboMap = new Map((combos || []).map((c) => [c?.name, c]));
  const topCombos = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name, requests]) => {
      const combo = comboMap.get(name) || {};
      return {
        name,
        requests,
        // Strategy from settings.comboStrategies map (same `fallbackStrategy`
        // key the combos page writes); default is fallback.
        strategy: comboStrategies?.[name]?.fallbackStrategy || "fallback",
        models: Array.isArray(combo.models) ? combo.models : [],
      };
    });

  return {
    period,
    currentRequests: currentRows.length,
    previousRequests: previousRows.length,
    requestsDelta: periodDelta(currentRows.length, previousRows.length),
    savings,
    topCombos,
  };
}
