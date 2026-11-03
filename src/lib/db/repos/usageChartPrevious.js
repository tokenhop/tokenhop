// Previous-period totals for the day-range usage chart (YAN-1235 overlay,
// YAN-1787 today clip). Split out of usageStatsRepo.js. Pure alignment math
// lives in src/lib/usage/previousBuckets.js; this module owns the reads.
import { localTodayKey, shiftDateKey } from "@/shared/utils/period";
import {
  historyCoversRollup,
  previousDayRange,
  previousDaySeries,
  previousDaySlice,
  sliceTotals,
} from "@/lib/usage/previousBuckets.js";
import { readRollupDaily, scopeSql, whereAll } from "./usageRollupRepo.js";

// Per-row measures derived exactly like the rollup write path
// (saveRequestUsageUnscoped / rebuildRollupFromHistoryUnscoped): tokensIn =
// promptTokens, tokensOut = completionTokens, tokensCached = the JSON
// `cached_tokens || cache_read_input_tokens || 0` (NULLIF mirrors JS `||`
// skipping 0; json_valid keeps malformed JSON out of json_extract), cost.
const CACHED_SQL = `CASE WHEN json_valid(tokens) THEN COALESCE(
    NULLIF(json_extract(tokens, '$.cached_tokens'), 0),
    json_extract(tokens, '$.cache_read_input_tokens'),
    0) ELSE 0 END`;

/**
 * One scoped aggregate over the whole previous day `[dayStart, dayEnd)`: the
 * day's request count (retention guard) and the sums of the elapsed slice
 * `[dayStart, sliceEnd)`. No rows reach JS.
 * @param {object} db adapter
 * @param {{sql: string, params: Array}} scope scopeSql result
 * @param {{start: number, end: number, dayEnd: number}} slice previousDaySlice result
 * @returns {{dayN: number, requests: number, prompt: number, cached: number, output: number, cost: number}}
 */
function readPreviousDay(db, scope, slice) {
  const row = db.get(
    `SELECT COUNT(*) AS dayN, COALESCE(SUM(inSlice), 0) AS requests,
       COALESCE(SUM(inSlice * prompt), 0) AS prompt, COALESCE(SUM(inSlice * cached), 0) AS cached,
       COALESCE(SUM(inSlice * output), 0) AS output, COALESCE(SUM(inSlice * cost), 0) AS cost
     FROM (SELECT CASE WHEN timestamp < ? THEN 1 ELSE 0 END AS inSlice,
             COALESCE(promptTokens, 0) AS prompt, ${CACHED_SQL} AS cached,
             COALESCE(completionTokens, 0) AS output, COALESCE(cost, 0) AS cost
           FROM usageHistory ${whereAll(scope.sql, "timestamp >= ?", "timestamp < ?")})`,
    [
      new Date(slice.end).toISOString(),
      ...scope.params,
      new Date(slice.start).toISOString(),
      new Date(slice.dayEnd).toISOString(),
    ],
  );
  const n = (key) => Number(row?.[key]) || 0;
  return {
    dayN: n("dayN"),
    requests: n("requests"),
    prompt: n("prompt"),
    cached: n("cached"),
    output: n("output"),
    cost: n("cost"),
  };
}

/**
 * Previous-window totals for day-range buckets (named 7d–90d and custom
 * ranges). Today's day bucket holds only the elapsed hours, so its
 * `previous` is clipped to the same elapsed slice of the matching previous
 * day, read from usageHistory (YAN-1787; decision: clip rather than flag it
 * in the tooltip, so the dashed line never dips at today's point) and
 * normalized like a rollup day (sliceTotals). Today is found by day key, not
 * position: a custom range may end on the server's tomorrow
 * (futureToleranceDays). This is the one bounded history read on otherwise
 * rollup-only periods: a single aggregate within that one previous day.
 * When that day's history holds fewer requests than its rollup (incomplete,
 * e.g. pruned by history retention) the slice cannot be read, and a whole
 * day would overstate the baseline, so it is null. Week/month/year grains
 * keep whole-day previous totals.
 * @param {object|null} ctx usage scope
 * @param {object} db adapter
 * @param {Array<object>} buckets current chart buckets of `range`
 * @param {{from: string, to: string}} range current inclusive day range
 * @param {number} now ms instant the buckets were built for
 * @returns {Array<object|null>} previous totals per bucket
 */
export function previousDayBuckets(ctx, db, buckets, range, now) {
  const prev = previousDayRange(range);
  const rows = readRollupDaily(ctx, db, prev.from, prev.to);
  const series = previousDaySeries(rows, range);
  const todayKey = localTodayKey(now);
  const index = buckets.findIndex((b) => b.grain === "day" && b.start === todayKey);
  if (index < 0) return series;
  const dayKey = shiftDateKey(todayKey, -prev.shiftDays);
  const day = readPreviousDay(db, scopeSql(ctx), previousDaySlice(dayKey, now));
  const rollupRequests = rows
    .filter((r) => r.dateKey === dayKey)
    .reduce((sum, r) => sum + (Number(r.requests) || 0), 0);
  const clipped = historyCoversRollup({ historyRequests: day.dayN, rollupRequests })
    ? sliceTotals(day)
    : null;
  return series.map((s, i) => (i === index ? clipped : s));
}
