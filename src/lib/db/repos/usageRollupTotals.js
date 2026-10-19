// Compare totals read from usageRollup only, so long windows and custom date
// ranges never scan usageHistory (YAN-421, YAN-426).
import { getAdapter } from "../driver.js";
import {
  PERIOD_DAYS,
  daysBetweenDateKeys,
  isRollupOnlyPeriod,
  shiftDateKey,
} from "@/shared/utils/period";
import { cutoffDateKey, readRollupTotals } from "./usageRollupRepo.js";

/**
 * Compare totals for the rollup-only periods (90d, all), read from usageRollup
 * so long windows never scan usageHistory (YAN-421). `90d`: current = the last
 * 90 calendar days, previous = the 90 calendar days before them. `all`: the
 * whole rollup and `previous: null` (no prior window). Other periods keep the
 * usageHistory-based getUsageTotals.
 * @returns {Promise<{currentTotals: object, previous: object|null}>}
 */
export async function getRollupUsageTotals(ctx, period) {
  if (!isRollupOnlyPeriod(period)) {
    throw new Error(`getRollupUsageTotals: unsupported period ${period}`);
  }
  const db = await getAdapter();
  if (period === "all") return { currentTotals: readRollupTotals(ctx, db), previous: null };
  const cutoff = cutoffDateKey(PERIOD_DAYS["90d"]);
  return {
    currentTotals: readRollupTotals(ctx, db, cutoff),
    previous: readRollupTotals(ctx, db, cutoffDateKey(PERIOD_DAYS["90d"] * 2), cutoff),
  };
}

/**
 * Compare totals for a custom inclusive day range, read from usageRollup only.
 * `previous` is the same number of days immediately before `from`. Same shape
 * as getRollupUsageTotals.
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
