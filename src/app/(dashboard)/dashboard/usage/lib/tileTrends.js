// Pure tile-trend helpers for the YAN-407 Usage redesign: previous-period
// deltas and chart-bucket sparkline series. No fetch/DB — plain input → output
// so node tests can import this module directly.

import { periodDelta } from "@/shared/utils/commandCenter";

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
  "90d": { caption: "vs prior 90d" },
  // Custom date range: compared with the same number of days just before it.
  custom: { caption: "vs prior range" },
  default: { caption: "vs prior period" },
};

/**
 * Neutral caption for the `all` period: there is no previous window to
 * compare against, so tiles say what the number covers instead.
 */
export const ALL_TIME_NOTE = { caption: "All recorded usage" };

/**
 * Muted caption shown instead of a percentage when no usable baseline exists.
 */
export const NO_PRIOR = { caption: "No prior data" };

/**
 * Percentage change of a current total against its previous-window total.
 * `none` when either side is non-finite or the baseline is ≤ 0 (nothing to
 * compare against — missing history and a genuine zero look the same here).
 * The subtraction reuses shared `periodDelta` (single source for the
 * current-vs-previous math); the `{kind, pct}` return shape and the
 * rounded-integer pct stay local to this module.
 * @param {number} current value from currentTotals
 * @param {number} previous value from previous
 * @returns {{ kind: "none" } | { kind: "up"|"down"|"flat", pct: number }} pct is a signed rounded integer; flat means pct === 0
 */
export function trendDelta(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) {
    return { kind: "none" };
  }
  const { delta } = periodDelta(current, previous);
  const pct = Math.round((delta / previous) * 100);
  return { kind: pct > 0 ? "up" : pct < 0 ? "down" : "flat", pct };
}

/**
 * Trend inputs for the saved-tokens tile from a /api/usage/savings payload
 * fetched with `compare=previous`. Sides are undefined when the compare
 * fields are missing, so `trendDelta` reports "none".
 * @param {object|null|undefined} savings
 * @returns {{ current: number|undefined, previous: number|undefined }}
 */
export function savingsTrendInput(savings) {
  return {
    current: savings?.currentTotals?.tokensSavedEst,
    previous: savings?.previous?.tokensSavedEst,
  };
}

/**
 * Largest allowed absolute difference between the two windows' priced shares
 * (pricedRequests / requestsWithSavings) for the Token saver cost trend:
 * 0.2 = 20 percentage points (YAN-1788). Beyond it the dollar totals price
 * different slices of the requests (2 of 100 vs 50 of 50 priced), so their
 * percentage change would mostly measure pricing coverage, not savings.
 */
export const PRICED_SHARE_TOLERANCE = 0.2;

/**
 * Share of a window's requests with savings whose model pricing resolved,
 * free ($0) models included (YAN-1812).
 * @param {{pricedRequests?: number, requestsWithSavings?: number}|null|undefined} totals
 * @returns {number|undefined} undefined when either count is not finite or there are no requests
 */
export function pricedShare(totals) {
  const priced = totals?.pricedRequests;
  const requests = totals?.requestsWithSavings;
  if (!Number.isFinite(priced) || !Number.isFinite(requests) || requests <= 0) return undefined;
  return priced / requests;
}

/**
 * Trend inputs for the Token saver hero's $ line from a /api/usage/savings
 * payload fetched with `compare=previous`. `costSavedEst` is null when the
 * window has no positive priced dollars (unpriced, or only free models); a side
 * is undefined unless it is a finite number (null is never coerced to 0), so an
 * unpriced or all-free side makes `trendDelta` "none".
 * Both sides are undefined (trend hidden) when either window's pricedShare is
 * unknown or the shares differ by more than PRICED_SHARE_TOLERANCE.
 * @param {object|null|undefined} savings
 * @returns {{ current: number|undefined, previous: number|undefined }}
 */
export function savingsCostTrendInput(savings) {
  const finite = (value) => (Number.isFinite(value) ? value : undefined);
  const cur = pricedShare(savings?.currentTotals);
  const prev = pricedShare(savings?.previous);
  // The epsilon keeps an exact 20-point gap (0.9 - 0.7 = 0.20000000000000007) comparable.
  if (
    cur === undefined ||
    prev === undefined ||
    Math.abs(cur - prev) > PRICED_SHARE_TOLERANCE + Number.EPSILON * 4
  ) {
    return { current: undefined, previous: undefined };
  }
  return {
    current: finite(savings?.currentTotals?.costSavedEst),
    previous: finite(savings?.previous?.costSavedEst),
  };
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
