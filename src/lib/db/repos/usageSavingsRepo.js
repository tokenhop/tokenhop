// YAN-1226: period savings + Home summary readers. Day-grain periods
// (7d/30d/60d/90d/all) read the daily usageRollup/usageComboRollup so long
// windows survive history retention; today/24h stay on usageHistory meta
// (a daily rollup cannot apportion partial days). Split out of usageRepo.js.
import { getAdapter } from "../driver.js";
import { parseJson } from "../helpers/jsonCol.js";
import { getMetaSync, setMetaSync } from "../helpers/metaStore.js";
import {
  PERIOD_DAYS,
  isPeriod,
  localTodayKey,
  periodStart,
  shiftDateKey,
} from "@/shared/utils/period";
import {
  cutoffDateKey,
  hasUntrackedRollupDays,
  readComboTop,
  readRollupTotals,
  readSavingsTotals,
  scopeSql,
  whereAll,
} from "./usageRollupRepo.js";
import { priceSavedGroups, savedTokensCost } from "./usageSavingsPricing.js";

/** _meta keys for the YAN-408 lifetime savings counter. */
export const SAVINGS_LIFETIME_KEY = "savingsTokensLifetime";

/**
 * Sum the saved tokens of every usageHistory row (YAN-408). One SQL aggregate
 * using JSON1 (`json_each`/`json_extract` ship with every supported driver —
 * `getUsageTotals` already relies on them), so JS never sees the rows. Sums
 * only positive per-method `tokensSavedEst`, matching savingsDeltas.
 * Runs at most once per install, before any incremental counter write.
 * @param {object} adapter sync DB adapter (inside a transaction)
 * @returns {number} lifetime saved tokens across all recorded rows
 */
export function backfillSavingsLifetimeUnscoped(adapter) {
  const row = adapter.get(
    `SELECT COALESCE(SUM(CAST(json_extract(j.value, '$.tokensSavedEst') AS REAL)), 0) AS lifetime
     FROM usageHistory u, json_each(u.meta, '$.savings.byMethod') j
     WHERE u.meta IS NOT NULL AND json_valid(u.meta)
       AND CAST(json_extract(j.value, '$.tokensSavedEst') AS REAL) > 0`,
  );
  return Number(row?.lifetime) || 0;
}

/**
 * Total tokens saved by the token savers across all recorded requests (YAN-408
 * milestone toast). On first read the counter is backfilled from history
 * exactly once; after that it is a point lookup.
 * @returns {Promise<number>}
 */
export async function getSavingsLifetime(ctx) {
  const db = await getAdapter();
  // Scoped savings remain exact after history retention; the instance-wide
  // single-user total continues using its existing _meta counter.
  if (ctx) {
    const scope = scopeSql(ctx);
    const row = db.get(
      `SELECT COALESCE(SUM(savingsSavedEst), 0) AS saved FROM usageRollup ${whereAll(scope.sql)}`,
      scope.params,
    );
    return Number(row?.saved) || 0;
  }
  const stored = getMetaSync(db, SAVINGS_LIFETIME_KEY, null);
  if (stored !== null) return Number(stored) || 0;
  let lifetime = 0;
  db.transaction(() => {
    lifetime = backfillSavingsLifetimeUnscoped(db);
    setMetaSync(db, SAVINGS_LIFETIME_KEY, lifetime);
  });
  return lifetime;
}

/**
 * Period savings from daily rollups, or request meta for today/24h.
 * Estimated only — RTK bytes/4, real Headroom tokens, PXPIPE estimates.
 * PXPIPE uses the same meta source (recorded once per successful request),
 * never the JSONL events file, so there is no double counting.
 */
export async function getUsageSavings(ctx, period = "7d", now = Date.now()) {
  if (!isPeriod(period)) throw new Error(`Invalid period: ${period}`);
  const db = await getAdapter();
  if (period !== "today" && period !== "24h") {
    const start = period === "all" ? null : cutoffDateKey(PERIOD_DAYS[period], now);
    const end = period === "all" ? null : shiftDateKey(localTodayKey(now), 1);
    const totals = readSavingsTotals(ctx, db, start, end);
    // SQLite SUM(REAL) uses compensated summation while the history path
    // summed in JS; round headline + per-method sums to 6dp so fractional
    // Headroom values cannot drift by an ULP between the two paths.
    const round6 = (n) => +n.toFixed(6);
    const byMethod = Object.fromEntries(
      Object.entries(totals.byMethod)
        .filter(([, value]) => value.tokensSavedEst > 0)
        .map(([method, value]) => [
          method,
          {
            tokensSavedEst: round6(value.tokensSavedEst),
            tokensBeforeEst: round6(value.tokensBeforeEst),
            requests: value.requests,
          },
        ]),
    );
    // Saved-token input pricing is linear: pricing grouped tokens equals
    // pricing each request, without retaining or parsing the request history.
    const { costSavedEst, pricedRequests } = await priceSavedGroups(totals.byProviderModel);
    return {
      period,
      estimated: true,
      tokensSavedEst: round6(totals.tokensSavedEst),
      tokensBeforeEst: round6(totals.tokensBeforeEst),
      percentage:
        totals.tokensBeforeEst > 0
          ? +((totals.tokensSavedEst / totals.tokensBeforeEst) * 100).toFixed(2)
          : 0,
      requestsWithSavings: totals.requestsWithSavings,
      // $ at list prices: each request's saved tokens priced with its own
      // model; null when no request in the period had resolvable pricing.
      costSavedEst,
      pricedRequests,
      // Fixed columns use canonical rtk/headroom/pxpipe order; unknown legacy
      // methods still contribute to headline totals, but not the breakdown.
      methods: Object.keys(byMethod),
      byMethod,
      // True when the window holds rollup days whose history was pruned before
      // savings tracking (migration 021), so the totals are incomplete.
      prunedBeforeTracking: hasUntrackedRollupDays(ctx, db, start, end),
    };
  }
  const scope = scopeSql(ctx);

  const rows = db.all(
    `SELECT timestamp, provider, model, meta FROM usageHistory ${whereAll(scope.sql, "timestamp >= ?", "timestamp <= ?")}`,
    [
      ...scope.params,
      new Date(periodStart(period, now)).toISOString(),
      new Date(now).toISOString(),
    ],
  );

  const byMethod = {};
  let tokensSavedEst = 0;
  let tokensBeforeEst = 0;
  let requestsWithSavings = 0;
  let costSavedEst = 0;
  let pricedRequests = 0;
  const pricingCache = new Map();

  for (const row of rows) {
    const meta = parseJson(row.meta, {});
    const savings = meta?.savings;
    if (!savings || typeof savings !== "object") continue;
    // Guard against partially-shaped legacy rows
    const methods =
      savings.byMethod && typeof savings.byMethod === "object" ? savings.byMethod : {};
    if (Object.keys(methods).length === 0) continue;

    let rowSaved = 0;
    for (const [method, m] of Object.entries(methods)) {
      if (typeof m !== "object" || !m) continue;
      const saved = Number(m.tokensSavedEst) || 0;
      const before = Number(m.tokensBeforeEst) || 0;
      if (saved <= 0) continue;
      if (!byMethod[method])
        byMethod[method] = { tokensSavedEst: 0, tokensBeforeEst: 0, requests: 0 };
      byMethod[method].tokensSavedEst += saved;
      byMethod[method].tokensBeforeEst += before;
      byMethod[method].requests += 1;
      rowSaved += saved;
    }
    if (rowSaved <= 0) continue;
    tokensSavedEst += rowSaved;
    tokensBeforeEst += Number(savings.tokensBeforeEst) || 0;
    requestsWithSavings += 1;

    const rowCost = await savedTokensCost(row.provider, row.model, rowSaved, pricingCache);
    if (rowCost > 0) {
      costSavedEst += rowCost;
      pricedRequests += 1;
    }
  }

  const methods = Object.keys(byMethod);
  const percentage =
    tokensBeforeEst > 0 ? +((tokensSavedEst / tokensBeforeEst) * 100).toFixed(2) : 0;

  return {
    period,
    estimated: true,
    tokensSavedEst,
    tokensBeforeEst,
    percentage,
    requestsWithSavings,
    // $ at list prices: each request's saved tokens priced with its own model.
    // null when no request in the period had resolvable pricing.
    costSavedEst: pricedRequests > 0 ? +costSavedEst.toFixed(6) : null,
    pricedRequests,
    methods,
    byMethod,
    // History-backed window: nothing is pruned inside it.
    prunedBeforeTracking: false,
  };
}

export async function getHomeSummary(ctx, period = "7d", now = Date.now()) {
  if (!isPeriod(period)) throw new Error(`Invalid period: ${period}`);
  const db = await getAdapter();
  if (period !== "today" && period !== "24h") {
    const start = period === "all" ? null : cutoffDateKey(PERIOD_DAYS[period], now);
    const end = period === "all" ? null : shiftDateKey(localTodayKey(now), 1);
    return {
      period,
      requests: readRollupTotals(ctx, db, start, end).requests,
      topCombos: readComboTop(ctx, db, start, end),
      // Same flag and [start, end) bounds as getUsageSavings: history pruned
      // before savings/combo tracking means topCombos may be understated.
      prunedBeforeTracking: hasUntrackedRollupDays(ctx, db, start, end),
    };
  }
  const scope = scopeSql(ctx);
  const window = [new Date(periodStart(period, now)).toISOString(), new Date(now).toISOString()];
  const where = whereAll(scope.sql, "timestamp >= ?", "timestamp <= ?");

  const requests =
    db.get(`SELECT COUNT(*) AS n FROM usageHistory ${where}`, [...scope.params, ...window])?.n || 0;

  // Names are extracted only from json_valid rows (CASE guarantees the order, so
  // malformed meta never reaches json_type/json_extract) and truncated to 128
  // chars like the rollup path, so both windows group identically.
  const topCombos = db.all(
    `SELECT name, COUNT(*) AS requests FROM (
       SELECT CASE WHEN json_valid(meta) THEN
                CASE WHEN json_type(meta, '$.comboName') = 'text'
                  THEN substr(json_extract(meta, '$.comboName'), 1, 128) END
              END AS name
       FROM usageHistory ${where}
     ) WHERE name IS NOT NULL AND name != ''
     GROUP BY name ORDER BY requests DESC, name ASC LIMIT 5`,
    [...scope.params, ...window],
  );

  return { period, requests, topCombos, prunedBeforeTracking: false };
}
