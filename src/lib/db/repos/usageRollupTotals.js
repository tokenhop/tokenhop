// Compare totals read from usageRollup only, so long windows and custom date
// ranges never scan usageHistory (YAN-421, YAN-426).
import { getAdapter } from "../driver.js";
import {
  PERIOD_DAYS,
  daysBetweenDateKeys,
  localTodayKey,
  shiftDateKey,
} from "@/shared/utils/period";
import { cutoffDateKey, readRollupTotals } from "./usageRollupRepo.js";

/**
 * Calendar-aligned compare totals for day-grain periods; sub-day periods must
 * continue using history because a daily rollup cannot apportion partial days.
 * `all` has no prior window. Both day windows contain the same number of days.
 * @returns {Promise<{currentTotals: object, previous: object|null}>}
 */
export async function getRollupPeriodTotals(ctx, period, now = Date.now()) {
  if (period !== "all" && !Object.hasOwn(PERIOD_DAYS, period)) {
    throw new Error(`getRollupPeriodTotals: unsupported period ${period}`);
  }
  const db = await getAdapter();
  if (period === "all") return { currentTotals: readRollupTotals(ctx, db), previous: null };
  const days = PERIOD_DAYS[period];
  const cutoff = cutoffDateKey(days, now);
  return {
    currentTotals: readRollupTotals(ctx, db, cutoff, shiftDateKey(localTodayKey(now), 1)),
    previous: readRollupTotals(ctx, db, cutoffDateKey(days * 2, now), cutoff),
  };
}

/**
 * Compare totals for a custom inclusive day range, read from usageRollup only.
 * Same shape as getRollupPeriodTotals.
 * @param {object|null} ctx usage scope
 * @param {{from: string, to: string}} range inclusive local day keys
 * @returns {Promise<{currentTotals: object, previous: object}>}
 */
export async function getRollupRangeTotals(ctx, { from, to }) {
  const db = await getAdapter();
  const days = daysBetweenDateKeys(from, to) + 1;
  return {
    currentTotals: readRollupTotals(ctx, db, from, shiftDateKey(to, 1)),
    previous: readRollupTotals(ctx, db, shiftDateKey(from, -days), from),
  };
}
