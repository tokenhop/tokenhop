// Savings compare totals aggregated in SQL (YAN-429): one query per window, no
// rows reach JS. Mirrors the getUsageSavings counting rules (positive
// per-method tokensSavedEst, a row counts once); groups are priced with the
// same shared list-price math (YAN-1237).
import { getAdapter } from "../driver.js";
import { daysBetweenDateKeys, shiftDateKey } from "@/shared/utils/period";
import {
  hasUntrackedRollupDays,
  readSavingsTotals,
  scopeSql,
  whereAll,
} from "./usageRollupRepo.js";
import { priceSavedGroups } from "./usageSavingsPricing.js";

/**
 * Tokens saved and requests with savings in the half-open window
 * `[start, end)` within the usage scope `ctx`, priced like getUsageSavings.
 * One SQL query: savings summed per provider/model group with a distinct row
 * count per group; a request belongs to exactly one provider/model, so the
 * sum of per-group distinct counts is the exact distinct count overall.
 * @param {object|null} ctx usage scope
 * @param {{start: number, end: number}} range ms timestamps
 * @returns {Promise<{tokensSavedEst: number, requestsWithSavings: number, costSavedEst: number|null}>}
 */
export async function getSavingsTotals(ctx, { start, end } = {}) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    throw new Error("getSavingsTotals requires finite ms start ≤ end");
  }
  const db = await getAdapter();
  // Aliased: the query joins json_each, so bare workspaceId would be ambiguous.
  const scope = scopeSql(ctx, "u.");
  // Rows are filtered (scope, window, json_valid) in a subquery before json_each,
  // so malformed meta can never reach the JSON1 table-valued function regardless
  // of the planner's join order.
  const rows = db.all(
    `SELECT s.provider AS provider, s.model AS model,
       COALESCE(SUM(CAST(json_extract(j.value, '$.tokensSavedEst') AS REAL)), 0) AS saved,
       COUNT(DISTINCT s.id) AS requests
     FROM (
       SELECT u.id AS id, u.provider AS provider, u.model AS model, u.meta AS meta FROM usageHistory u
       ${whereAll(
         scope.sql,
         "u.timestamp >= ?",
         "u.timestamp < ?",
         "u.meta IS NOT NULL",
         "json_valid(u.meta)",
       )}
     ) s, json_each(s.meta, '$.savings.byMethod') j
     WHERE j.type = 'object'
       AND CAST(json_extract(j.value, '$.tokensSavedEst') AS REAL) > 0
     GROUP BY s.provider, s.model`,
    [...scope.params, new Date(start).toISOString(), new Date(end).toISOString()],
  );
  let tokensSavedEst = 0;
  let requestsWithSavings = 0;
  const groups = [];
  for (const row of rows) {
    tokensSavedEst += Number(row.saved) || 0;
    const groupRequests = Number(row.requests) || 0;
    requestsWithSavings += groupRequests;
    groups.push({
      provider: row.provider || null,
      model: row.model || null,
      tokensSavedEst: Number(row.saved) || 0,
      savingsRequests: groupRequests,
    });
  }
  const { costSavedEst } = await priceSavedGroups(groups);
  return { tokensSavedEst, requestsWithSavings, costSavedEst };
}

/**
 * Savings compare over inclusive local day keys, independent of history
 * retention. Null bounds mean all time, for which no previous window exists.
 * `previous` is also null when the previous window holds rollup days whose
 * history was pruned before savings tracking: its totals would be understated
 * and the trend would show an inflated delta, so it reports no prior data.
 * `costSavedEst` matches getUsageSavings: rollup rows are grouped and priced
 * the same way (null when no group had resolvable pricing).
 * @param {object|null} ctx usage scope
 * @param {{from: string|null, to: string|null}} range
 * @returns {Promise<{currentTotals: object, previous: object|null}>}
 */
export async function getRollupSavingsTotals(ctx, { from, to }) {
  const db = await getAdapter();
  const pricingCache = new Map(); // shared so both windows price each model once
  const totalsIn = async (start = null, end = null) => {
    const totals = readSavingsTotals(ctx, db, start, end);
    const { costSavedEst } = await priceSavedGroups(totals.byProviderModel, pricingCache);
    return {
      tokensSavedEst: totals.tokensSavedEst,
      requestsWithSavings: totals.requestsWithSavings,
      costSavedEst,
    };
  };
  if (from == null && to == null) return { currentTotals: await totalsIn(), previous: null };
  const days = daysBetweenDateKeys(from, to) + 1;
  const previousStart = shiftDateKey(from, -days);
  return {
    currentTotals: await totalsIn(from, shiftDateKey(to, 1)),
    previous: hasUntrackedRollupDays(ctx, db, previousStart, from)
      ? null
      : await totalsIn(previousStart, from),
  };
}
