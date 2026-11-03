// Previous-period overlay for the usage tokens chart (YAN-1235). Pure date
// math and folding, no DB access. One alignment rule for every period: read
// the equal-length window right before the current one, shift it forward by
// the window length and fold it into the CURRENT bucket skeleton, so each
// bucket's `previous` covers exactly the same relative slice of its window.
// Exception (YAN-1787): today's partial day bucket compares with the same
// elapsed slice of the matching previous day (previousDaySlice), not a whole day.
import { customChartBuckets } from "./customRange.js";
import { daysBetweenDateKeys, previousPeriodRange, shiftDateKey } from "@/shared/utils/period";

const HOUR_MS = 3600000;
const HOUR_BUCKETS = 24;

const zeroTotals = () => ({ input: 0, cached: 0, output: 0, tokens: 0, cost: 0, requests: 0 });

/**
 * Totals carried in a bucket's `previous` field (same normalization as the bucket).
 * @param {{input?:number,cached?:number,output?:number,tokens?:number,cost?:number,requests?:number}} b
 * @returns {{input:number,cached:number,output:number,tokens:number,cost:number,requests:number}}
 */
export function bucketTotals(b) {
  return {
    input: b.input || 0,
    cached: b.cached || 0,
    output: b.output || 0,
    tokens: b.tokens || 0,
    cost: b.cost || 0,
    requests: b.requests || 0,
  };
}

/**
 * Previous window of an inclusive day range: the same number of days ending
 * the day before `from`. `shiftDays` moves previous rows onto the current days.
 * @param {{from: string, to: string}} range inclusive local day keys
 * @returns {{from: string, to: string, shiftDays: number}}
 */
export function previousDayRange({ from, to }) {
  const days = daysBetweenDateKeys(from, to) + 1;
  return { from: shiftDateKey(from, -days), to: shiftDateKey(from, -1), shiftDays: days };
}

/**
 * Rollup day rows moved `days` calendar days forward (setDate, DST-safe).
 * @param {Array<{dateKey: string}>} rows
 * @param {number} days
 */
export function shiftRowDates(rows, days) {
  return rows.map((r) => ({ ...r, dateKey: shiftDateKey(r.dateKey, days) }));
}

/**
 * Previous-window totals per current bucket for a day range (named day
 * periods and custom ranges): the previous rows are shifted onto the current
 * range and bucketed by the same customChartBuckets call as the current
 * series, so day and week/month/year grains line up index for index.
 * @param {Array} previousRows readRollupDaily rows of previousDayRange(range)
 * @param {{from: string, to: string}} range current inclusive day range
 * @returns {Array<object>} one bucketTotals per current bucket
 */
export function previousDaySeries(previousRows, range) {
  const { shiftDays } = previousDayRange(range);
  return customChartBuckets(shiftRowDates(previousRows, shiftDays), range).map(bucketTotals);
}

/**
 * Previous window for the hourly chart periods. `24h` is the preceding
 * rolling 24h, fully comparable. `today` is yesterday from local midnight
 * (one calendar day back, DST-safe) clipped to the elapsed slice — the tile
 * trend's "vs same time yesterday", never past today's midnight — so only
 * the leading hour buckets the window actually spans (`comparable`) get a
 * previous value; a 23-hour spring-forward yesterday leaves slot 23 null.
 * Hour index of a previous instant is its offset from `start`.
 * @param {"today"|"24h"} period
 * @param {number} now
 * @returns {{start: number, end: number, comparable: number}}
 */
export function previousHourWindow(period, now) {
  const { start, end } = previousPeriodRange(period, now);
  return { start, end, comparable: Math.min(Math.ceil((end - start) / HOUR_MS), HOUR_BUCKETS) };
}

/**
 * Add normalized history points into 24 hour slots (mutates `slots`): a point
 * lands in slot floor((t - start) / 1h), capped at the last slot. Points
 * failing `inWindow` or hitting a null slot are skipped. Shared by the current
 * and previous hour series so both normalize identically.
 * @param {Array<object|null>} slots 24 bucket-shaped totals (null = not comparable)
 * @param {Array<{t:number,input:number,cached:number,output:number,cost:number}>} points
 * @param {number} start ms instant of slot 0
 * @param {(t: number) => boolean} inWindow
 * @returns {Array<object|null>} `slots`
 */
export function foldHourPoints(slots, points, start, inWindow) {
  for (const p of points) {
    if (!inWindow(p.t)) continue;
    const slot = slots[Math.min(Math.floor((p.t - start) / HOUR_MS), HOUR_BUCKETS - 1)];
    if (!slot) continue;
    slot.input += p.input;
    slot.cached += p.cached;
    slot.output += p.output;
    slot.tokens += p.input + p.output;
    slot.cost += p.cost;
    slot.requests += 1;
  }
  return slots;
}

/**
 * Elapsed slice of a previous day matching today's partial day bucket
 * (YAN-1787). Today's day bucket only holds the hours elapsed since local
 * midnight, so its `previous` is clipped to the same elapsed time from the
 * previous day's local midnight — the rule `previousPeriodRange("today")`
 * uses — never past that day's next local midnight (setDate, DST-safe: a
 * 23-hour previous day ends early, a 25-hour one keeps its extra hour).
 * Half-open `[start, end)`; `dayEnd` bounds the whole previous day.
 * @param {string} previousDayKey local `YYYY-MM-DD` of the matching previous day
 * @param {number} now ms instant (today's elapsed time is measured from its local midnight)
 * @returns {{start: number, end: number, dayEnd: number}}
 */
export function previousDaySlice(previousDayKey, now) {
  const [y, m, d] = previousDayKey.split("-").map(Number);
  const day = new Date(y, m - 1, d);
  const start = day.getTime();
  day.setDate(day.getDate() + 1);
  const dayEnd = day.getTime();
  const todayMidnight = new Date(now);
  todayMidnight.setHours(0, 0, 0, 0);
  return { start, end: Math.min(start + (now - todayMidnight.getTime()), dayEnd), dayEnd };
}

/**
 * Retention guard for today's previous slice (YAN-1787): the previous day's
 * history is complete enough to clip when it holds at least the rollup's
 * requests for that day. Fewer means it is incomplete (e.g. history
 * retention pruned it) — no clip is possible and a whole day would overstate
 * the baseline, so the caller reports null. More (legacy rows never rolled
 * up) or no rollup row at all still clips from history.
 * @param {{historyRequests: number, rollupRequests: number}} counts whole-day request counts
 * @returns {boolean}
 */
export function historyCoversRollup({ historyRequests, rollupRequests }) {
  return historyRequests >= rollupRequests;
}

/**
 * `previous` for today's partial day bucket (YAN-1787) from the previous
 * day's elapsed-slice sums, normalized exactly like a rollup day bucket
 * (day-level `input = max(sum prompt, sum cached)`, `tokens = input +
 * output`), so today's current and previous values use one rule.
 * @param {{requests:number,prompt:number,cached:number,output:number,cost:number}} sums
 * @returns {{input:number,cached:number,output:number,tokens:number,cost:number,requests:number}}
 */
export function sliceTotals({ requests, prompt, cached, output, cost }) {
  const input = Math.max(prompt, cached);
  return { input, cached, output, tokens: input + output, cost, requests };
}

/**
 * Fold normalized previous-window history points into 24 hour slots.
 * @param {Array<{t:number,input:number,cached:number,output:number,cost:number}>} points
 * @param {{start: number, end: number, comparable: number}} window previousHourWindow result
 * @returns {Array<object|null>} bucketTotals per slot; null past the comparable slice
 */
export function previousHourSeries(points, { start, end, comparable }) {
  const slots = Array.from({ length: HOUR_BUCKETS }, (_, i) =>
    i < comparable ? zeroTotals() : null,
  );
  return foldHourPoints(slots, points, start, (t) => t >= start && t < end);
}

/**
 * Attach the aligned previous totals to each current bucket (same index).
 * @param {Array<object>} buckets current chart buckets
 * @param {Array<object|null>} previous previous totals per bucket
 */
export function withPrevious(buckets, previous) {
  return buckets.map((b, i) => ({ ...b, previous: previous[i] ?? null }));
}
