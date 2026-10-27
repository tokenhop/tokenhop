// Savings compare totals aggregated in SQL (YAN-429): one query per window, no
// rows reach JS. Mirrors the getUsageSavings counting rules (positive
// per-method tokensSavedEst, a row counts once) without per-row pricing.
import { getAdapter } from "../driver.js";
import { daysBetweenDateKeys, shiftDateKey } from "@/shared/utils/period";
import { readSavingsTotals, scopeSql, whereAll } from "./usageRollupRepo.js";

/**
 * Tokens saved and requests with savings in the half-open window
 * `[start, end)` within the usage scope `ctx`.
 * @param {object|null} ctx usage scope
 * @param {{start: number, end: number}} range ms timestamps
 * @returns {Promise<{tokensSavedEst: number, requestsWithSavings: number}>}
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
  const row = db.get(
    `SELECT COALESCE(SUM(CAST(json_extract(j.value, '$.tokensSavedEst') AS REAL)), 0) AS saved,
       COUNT(DISTINCT s.id) AS requests
     FROM (
       SELECT u.id AS id, u.meta AS meta FROM usageHistory u
       ${whereAll(
         scope.sql,
         "u.timestamp >= ?",
         "u.timestamp < ?",
         "u.meta IS NOT NULL",
         "json_valid(u.meta)",
       )}
     ) s, json_each(s.meta, '$.savings.byMethod') j
     WHERE j.type = 'object'
       AND CAST(json_extract(j.value, '$.tokensSavedEst') AS REAL) > 0`,
    [...scope.params, new Date(start).toISOString(), new Date(end).toISOString()],
  );
  return {
    tokensSavedEst: Number(row?.saved) || 0,
    requestsWithSavings: Number(row?.requests) || 0,
  };
}

/**
 * Savings compare over inclusive local day keys, independent of history
 * retention. Null bounds mean all time, for which no previous window exists.
 * @param {object|null} ctx usage scope
 * @param {{from: string|null, to: string|null}} range
 * @returns {Promise<{currentTotals: object, previous: object|null}>}
 */
export async function getRollupSavingsTotals(ctx, { from, to }) {
  const db = await getAdapter();
  const totalsIn = (start = null, end = null) => {
    const totals = readSavingsTotals(ctx, db, start, end);
    return {
      tokensSavedEst: totals.tokensSavedEst,
      requestsWithSavings: totals.requestsWithSavings,
    };
  };
  if (from == null && to == null) return { currentTotals: totalsIn(), previous: null };
  const days = daysBetweenDateKeys(from, to) + 1;
  return {
    currentTotals: totalsIn(from, shiftDateKey(to, 1)),
    previous: totalsIn(shiftDateKey(from, -days), from),
  };
}
