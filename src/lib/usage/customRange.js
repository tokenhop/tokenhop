// Pure chart bucketing for custom usage date ranges (YAN-426). No DB access.
import { buildAllTimeBuckets } from "./allTimeBuckets.js";
import { daysBetweenDateKeys, shiftDateKey } from "@/shared/utils/period";

const DAILY_CUSTOM_BUCKET_DAYS = 92;
const emptyDayBucket = (label, start) => ({
  label,
  grain: "day",
  start,
  input: 0,
  cached: 0,
  output: 0,
  tokens: 0,
  cost: 0,
  requests: 0,
});

/**
 * Custom-range chart buckets (YAN-426): one per day up to 92 days, else
 * week/month/year buckets.
 * @param {Array} rows per-day rollup rows (readRollupDaily) within from..to
 * @param {{from: string, to: string}} range inclusive local day keys
 */
export function customChartBuckets(rows, { from, to }) {
  const days = daysBetweenDateKeys(from, to) + 1;
  if (days > DAILY_CUSTOM_BUCKET_DAYS) {
    const [ty, tm, td] = to.split("-").map(Number);
    return buildAllTimeBuckets(rows, new Date(ty, tm - 1, td), { from, to });
  }
  const byDay = new Map(rows.map((r) => [r.dateKey, r]));
  return Array.from({ length: days }, (_, i) => {
    const key = shiftDateKey(from, i);
    const [y, m, d] = key.split("-").map(Number);
    const bucket = emptyDayBucket(
      new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      key,
    );
    const day = byDay.get(key);
    if (!day) return bucket;
    const input = Math.max(day.tokensIn || 0, day.tokensCached || 0);
    bucket.input = input;
    bucket.cached = day.tokensCached || 0;
    bucket.output = day.tokensOut || 0;
    bucket.tokens = input + bucket.output;
    bucket.cost = day.cost || 0;
    bucket.requests = day.requests || 0;
    return bucket;
  });
}
