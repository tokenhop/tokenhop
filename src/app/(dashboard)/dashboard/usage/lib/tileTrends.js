// Pure tile-trend helpers for the YAN-407 Usage redesign: previous-period
// deltas and chart-bucket sparkline series. No fetch/DB — plain input → output
// so node tests can import this module directly.

/**
 * Caption shown next to a tile's delta percentage, keyed by period. Nested
 * under `caption` so the i18n literal extractor sees the copy; "24h/7d/30d/60d"
 * stay untranslated tokens. `default` backs any future period value.
 */
export const PRIOR_LABELS = {
  today: { caption: "vs same time yesterday" },
  "24h": { caption: "vs prior 24h" },
  "7d": { caption: "vs prior 7d" },
  "30d": { caption: "vs prior 30d" },
  "60d": { caption: "vs prior 60d" },
  default: { caption: "vs prior period" },
};

/**
 * Muted caption shown instead of a percentage when no usable baseline exists.
 */
export const NO_PRIOR = { caption: "No prior data" };

/**
 * Percentage change of a current total against its previous-window total.
 * `none` when either side is non-finite or the baseline is ≤ 0 (nothing to
 * compare against — missing history and a genuine zero look the same here).
 * @param {number} current value from currentTotals
 * @param {number} previous value from previous
 * @returns {{ kind: "none" } | { kind: "up"|"down"|"flat", pct: number }} pct is a signed rounded integer; flat means pct === 0
 */
export function trendDelta(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) {
    return { kind: "none" };
  }
  const pct = Math.round(((current - previous) / previous) * 100);
  return { kind: pct > 0 ? "up" : pct < 0 ? "down" : "flat", pct };
}

/**
 * Values of one field across shaped chart buckets, for a StatTile sparkline.
 * @param {Array<object>|null|undefined} buckets shaped by shapeChartSeries
 * @param {"requests"|"input"|"cached"|"output"|"cost"} field
 * @returns {number[]|undefined} undefined when fewer than 2 buckets (no line)
 */
export function bucketSeries(buckets, field) {
  if (!Array.isArray(buckets) || buckets.length < 2) return undefined;
  return buckets.map((bucket) => Number(bucket?.[field]) || 0);
}
