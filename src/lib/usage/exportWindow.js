// Export windows for /api/usage/export (YAN-425). Pure time math, kept out
// of the repos so the tenancy lint only sees functions that read data.
// Windows match getUsageStats: sub-day periods (today, 24h) start at
// periodStart; day-grain periods (7d..90d), `all` and custom ranges use
// local day keys. Request rows read usageHistory over the same span:
// named periods use periodStart (local midnight of the first rollup day for
// day-grain periods), custom ranges the local-day bounds of from..to
// inclusive, and `all` has no lower bound.
import { cutoffDateKey, localDateKey } from "@/lib/db/repos/usageRollupRepo.js";
import { PERIOD_DAYS, isCustomPeriod, periodStart } from "@/shared/utils/period";

const localDayStartMs = (dateKey) => {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
};
const nextLocalDayStartMs = (dateKey) => {
  const start = new Date(localDayStartMs(dateKey));
  start.setDate(start.getDate() + 1);
  return start.getTime();
};

/** Inclusive local day keys `[fromKey, toKey]` for a named period (`all` = open start). */
function exportDayWindow(period, now = Date.now()) {
  const todayKey = localDateKey(new Date(now));
  if (period === "all") return { fromKey: null, toKey: todayKey };
  // Sub-day periods fold history for daily rows; their rollup window is
  // unused but still resolved to today so callers can rely on the shape.
  if (period === "today" || period === "24h") return { fromKey: todayKey, toKey: todayKey };
  const days = PERIOD_DAYS[period];
  if (!days) throw new Error(`Invalid period: ${period}`);
  return { fromKey: cutoffDateKey(days, now), toKey: todayKey };
}

/**
 * Resolve both export windows for a period: `history` (streamRequestRows
 * over `[startMs, nowMs]`; startMs null for `all`) backs request rows and
 * the sub-day daily fold, `rollup` (streamDailyRows over inclusive day
 * keys) backs the other daily rows. Windows match getUsageStats (see the
 * file header).
 */
export function exportWindow(period, range = null, now = Date.now()) {
  if (isCustomPeriod(period)) {
    if (!range?.from || !range?.to) throw new Error("custom period requires a {from, to} range");
    return {
      history: {
        startMs: localDayStartMs(range.from),
        nowMs: nextLocalDayStartMs(range.to) - 1,
      },
      rollup: { fromKey: range.from, toKey: range.to },
    };
  }
  const history =
    period === "all"
      ? { startMs: null, nowMs: now }
      : { startMs: periodStart(period, now), nowMs: now };
  return { history, rollup: exportDayWindow(period, now) };
}
