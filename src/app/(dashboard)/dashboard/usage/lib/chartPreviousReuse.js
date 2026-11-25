// Client-side reuse of /api/usage/chart previous-period series across
// background refreshes (YAN-1789). Pure JS — no React, DOM, or DB access.
//
// UsageTokensChart sends `compare=previous`, which doubles chart work when
// live catch-up refreshes re-read the previous window. Within the reuse TTL
// (and while the window boundaries have not rolled over), background refreshes
// omit `compare=previous` and re-attach the cached `prevTokens` per bucket.
import { localTodayKey, shiftDateKey } from "@/shared/utils/period";

export const PREVIOUS_REUSE_TTL_MS = 60_000;
export const ROLLING_24H_DRIFT_GRACE_MS = 10_000;

const IMMUTABLE_GRAINS = new Set(["week", "month", "year"]);

/**
 * Elapsed local hours since today's local midnight. Unlike `Date#getHours()`,
 * this increases monotonically across a 25-hour fall-back DST transition so
 * the repeated 01:xx hour does not alias the pre-transition hour.
 *
 * @param {number} now
 * @returns {number}
 */
function localElapsedHour(now) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return Math.floor((now - midnight.getTime()) / 3_600_000);
}

/**
 * True when a `custom` range's previous window could not shift at `referenceNow`:
 * either it uses coarse (>92d) week/month/year buckets (which never clip today)
 * or its end date was already strictly older than yesterday local at
 * `referenceNow` (giving a +/-1 day buffer against browser/server TZ skew).
 * Callers must pass `cached.fetchedAt` as `referenceNow`, never the current
 * wall clock, so a partial-day snapshot captured on `to === today` cannot
 * appear immutable on a later day.
 *
 * @param {string|null} period
 * @param {{from: string, to: string}|null} range
 * @param {Array<{grain?: string|null}>|null} slots
 * @param {number} [referenceNow]
 * @returns {boolean}
 */
export function isImmutablePreviousWindow(period, range, slots, referenceNow = Date.now()) {
  if (period !== "custom" || typeof range?.to !== "string") return false;
  if (Array.isArray(slots) && slots.length > 0 && IMMUTABLE_GRAINS.has(slots[0]?.grain)) {
    return true;
  }
  return range.to < shiftDateKey(localTodayKey(referenceNow), -1);
}

/**
 * Capture the previous-period series from a `compare=previous` response.
 * Returns null if the period has no previous window (`all`), the series is
 * empty, shapes mismatch, or any bucket omitted `previous` (for example when
 * the server's `attachPrevious` failed and degraded to current-only buckets).
 *
 * @param {Array<object>} rawBuckets raw JSON array from /api/usage/chart
 * @param {Array<object>} shapedBuckets output of shapeChartSeries(rawBuckets)
 * @param {{period: string, windowKey: string, scopeKey: string, now?: number}} meta
 * @returns {object|null}
 */
export function capturePreviousSnapshot(
  rawBuckets,
  shapedBuckets,
  { period, windowKey, scopeKey, now = Date.now() },
) {
  if (period === "all") return null;
  if (
    !Array.isArray(rawBuckets) ||
    rawBuckets.length === 0 ||
    !Array.isArray(shapedBuckets) ||
    rawBuckets.length !== shapedBuckets.length
  ) {
    return null;
  }
  if (!rawBuckets.every((b) => b && Object.hasOwn(b, "previous") && b.previous !== undefined)) {
    return null;
  }
  return {
    windowKey,
    scopeKey,
    period,
    fetchedAt: now,
    localDay: localTodayKey(now),
    localHour: localElapsedHour(now),
    slots: shapedBuckets.map((b) => ({
      grain: b.grain ?? null,
      start: b.start ?? null,
      prevTokens: b.prevTokens ?? null,
    })),
  };
}

/**
 * Decide whether `cached` can supply `prevTokens` for a background refresh
 * of the given window/scope at `now`.
 *
 * @param {object|null} cached
 * @param {{period: string, range?: {from: string, to: string}|null, windowKey: string|null, scopeKey: string, now?: number}} query
 * @returns {boolean}
 */
export function canReusePrevious(
  cached,
  { period, range = null, windowKey, scopeKey, now = Date.now() },
) {
  if (
    !cached ||
    period === "all" ||
    cached.period !== period ||
    cached.windowKey !== windowKey ||
    cached.scopeKey !== scopeKey ||
    !Array.isArray(cached.slots) ||
    cached.slots.length === 0
  ) {
    return false;
  }
  if (now < cached.fetchedAt) {
    return false;
  }
  if (isImmutablePreviousWindow(period, range, cached.slots, cached.fetchedAt)) {
    return true;
  }
  if (now - cached.fetchedAt >= PREVIOUS_REUSE_TTL_MS) {
    return false;
  }
  if (period !== "24h" && localTodayKey(now) !== cached.localDay) {
    return false;
  }
  if (period === "today" && localElapsedHour(now) !== cached.localHour) {
    return false;
  }
  return true;
}

/**
 * Re-attach cached `prevTokens` onto freshly shaped non-compare buckets.
 * Returns null if the server's bucket skeleton shifted (for example across a
 * midnight rollover or excessive 24h drift), signaling the caller to fall back
 * to a full `compare=previous` fetch.
 *
 * @param {Array<object>} freshShaped output of shapeChartSeries(rawBuckets)
 * @param {object|null} cached snapshot returned by capturePreviousSnapshot
 * @param {string} period
 * @returns {Array<object>|null}
 */
export function mergeReusedPrevious(freshShaped, cached, period) {
  if (
    !cached ||
    !Array.isArray(cached.slots) ||
    !Array.isArray(freshShaped) ||
    freshShaped.length === 0 ||
    freshShaped.length !== cached.slots.length
  ) {
    return null;
  }
  if (period === "24h") {
    for (let i = 0; i < freshShaped.length; i++) {
      if (freshShaped[i]?.grain !== "hour" || cached.slots[i]?.grain !== "hour") {
        return null;
      }
    }
    const freshT = Date.parse(freshShaped[0]?.start);
    const cachedT = Date.parse(cached.slots[0]?.start);
    if (
      !Number.isFinite(freshT) ||
      !Number.isFinite(cachedT) ||
      freshT < cachedT ||
      freshT - cachedT > PREVIOUS_REUSE_TTL_MS + ROLLING_24H_DRIFT_GRACE_MS
    ) {
      return null;
    }
  } else {
    for (let i = 0; i < freshShaped.length; i++) {
      const grain = freshShaped[i]?.grain;
      const start = freshShaped[i]?.start;
      if (
        typeof grain !== "string" ||
        typeof start !== "string" ||
        grain !== cached.slots[i]?.grain ||
        start !== cached.slots[i]?.start
      ) {
        return null;
      }
    }
  }
  return freshShaped.map((b, i) => ({
    ...b,
    prevTokens: cached.slots[i].prevTokens,
  }));
}
