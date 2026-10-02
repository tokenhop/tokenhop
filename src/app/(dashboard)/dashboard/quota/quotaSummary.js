import {
  getConnectionLabel,
  getRemainingPercentage,
} from "@/app/(dashboard)/dashboard/quota/lib/quotaUtils.js";
import { worstForecast } from "@/shared/utils/quotaForecast.js";

/**
 * Health bucket for one quota reading. The account-level summary uses
 * three buckets (>45 healthy, 1–45 running low, 0 empty) so a single
 * worn-down window marks the account "Running low" even when the
 * individual Meter shows err red below 21 — the row and card stay red
 * together, but the card keeps its "low, act soon" label down to 1%.
 * `unlimited`/`credits` rows never deplete, so callers must skip them
 * (see `getAccountWorstRemaining`); NaN fails loud instead of guessing.
 *
 * @param {number} remainingPercent 0–100 remaining.
 * @returns {"healthy"|"low"|"empty"}
 */
export function getHealthBucket(remainingPercent) {
  if (typeof remainingPercent !== "number" || !Number.isFinite(remainingPercent)) {
    throw new Error(`getHealthBucket: expected a finite number, got ${remainingPercent}`);
  }
  const clamped = Math.min(100, Math.max(0, remainingPercent));
  if (clamped <= 0) return "empty";
  if (clamped <= 45) return "low";
  return "healthy";
}

/**
 * Worst-case remaining across one account's quotas. Unlimited rows and credit
 * balances never run out, so they are skipped (returns null when nothing
 * measurable remains).
 *
 * @param {Array<object>} quotas Normalized quota rows.
 * @returns {number|null}
 */
export function getAccountWorstRemaining(quotas) {
  if (!Array.isArray(quotas)) return null;
  let worst = null;
  for (const quota of quotas) {
    if (quota?.unlimited === true || quota?.isCreditBalance === true) continue;
    const remaining = getRemainingPercentage(quota);
    if (!Number.isFinite(remaining)) continue;
    worst = worst === null ? remaining : Math.min(worst, remaining);
  }
  return worst;
}

/**
 * Bucket every account with measurable quota into healthy / running low /
 * empty, plus the total counted.
 *
 * @param {Array<{id: string, quotas: Array<object>}>} accounts
 * @returns {{healthy: number, low: number, empty: number, total: number}}
 */
export function summarizeQuotaHealth(accounts) {
  const summary = { healthy: 0, low: 0, empty: 0, total: 0 };
  for (const account of accounts || []) {
    const worst = getAccountWorstRemaining(account?.quotas);
    if (worst === null) continue;
    summary[getHealthBucket(worst)] += 1;
    summary.total += 1;
  }
  return summary;
}

/**
 * Earliest future reset across a quota list, or null.
 *
 * @param {Array<object>} quotas Normalized quota rows.
 * @param {number} [now=Date.now()]
 * @returns {string|null} ISO reset time.
 */
export function getEarliestReset(quotas, now = Date.now()) {
  if (!Array.isArray(quotas)) return null;
  let earliest = null;
  for (const quota of quotas) {
    if (!quota?.resetAt) continue;
    const time = new Date(quota.resetAt).getTime();
    if (!Number.isFinite(time) || time <= now) continue;
    if (earliest === null || time < new Date(earliest).getTime()) {
      earliest = quota.resetAt;
    }
  }
  return earliest;
}

/**
 * The soonest-resetting account for the summary "next reset" line.
 *
 * @param {Array<{id: string, label?: string}>} connections
 * @param {Record<string, {quotas?: Array<object>}>} quotaData
 * @param {number} [now=Date.now()]
 * @returns {{connectionId: string, label: string, resetAt: string}|null}
 */
export function getSoonestReset(connections, quotaData, now = Date.now()) {
  let soonest = null;
  for (const connection of connections || []) {
    const resetAt = getEarliestReset(quotaData?.[connection?.id]?.quotas, now);
    if (!resetAt) continue;
    if (!soonest || new Date(resetAt).getTime() < new Date(soonest.resetAt).getTime()) {
      soonest = {
        connectionId: connection.id,
        label: connection.label || connection.name || connection.id,
        resetAt,
      };
    }
  }
  return soonest;
}

/**
 * A connection is depleted when any measurable quota has ≤5% left (matches
 * the page's existing bulk-action threshold).
 *
 * @param {Array<object>} quotas Normalized quota rows.
 * @returns {boolean}
 */
export function isAccountDepleted(quotas) {
  if (!Array.isArray(quotas) || quotas.length === 0) return false;
  return quotas.some((quota) => {
    if (quota?.unlimited === true || quota?.isCreditBalance === true) return false;
    const hasRemaining = quota?.remaining !== undefined || quota?.remainingPercentage !== undefined;
    // used/total fallback reads total 0 as 0%, so only trust it with a real total.
    if (!hasRemaining && !(quota?.total > 0)) return false;
    return getRemainingPercentage(quota) <= 5;
  });
}

/**
 * Status pill for one account card. Status is never color-only: every
 * variant carries a text label.
 *
 * @param {{isActive?: boolean, quotas?: Array<object>, error?: string|null, loading?: boolean}} account
 * @returns {{label: string, variant: "ok"|"warn"|"err"|"neutral"}}
 */
export function getAccountStatus({ isActive, quotas, error, loading } = {}) {
  const worst = getAccountWorstRemaining(quotas);
  if ((isActive ?? true) === false) {
    const empty = worst === 0 || isAccountDepleted(quotas);
    return { label: empty ? "Turned off · empty" : "Turned off", variant: "neutral" };
  }
  if (error) return { label: "Error", variant: "err" };
  if (loading && !quotas?.length) return { label: "Checking", variant: "neutral" };
  if (worst === null) {
    return quotas?.length
      ? { label: "Active", variant: "ok" }
      : { label: "No data", variant: "neutral" };
  }
  const bucket = getHealthBucket(worst);
  if (bucket === "empty") return { label: "Empty", variant: "err" };
  if (bucket === "low") return { label: "Running low", variant: "warn" };
  return { label: "Active", variant: "ok" };
}

/**
 * Connection ids targeted by the bulk actions: "off" hits active depleted
 * accounts, "on" hits inactive accounts that still have quota.
 *
 * @param {Array<{id: string, isActive?: boolean}>} connections
 * @param {Record<string, {quotas?: Array<object>}>} quotaData
 * @param {"off"|"on"} action
 * @returns {Array<string>}
 */
export function getBulkActionTargets(connections, quotaData, action) {
  const targets = [];
  for (const connection of connections || []) {
    const active = connection?.isActive ?? true;
    const depleted = isAccountDepleted(quotaData?.[connection?.id]?.quotas);
    if (action === "off" && active && depleted) targets.push(connection.id);
    if (action === "on" && !active && !depleted) targets.push(connection.id);
  }
  return targets;
}

const KNOWN_FORECAST_STATES = new Set(["will-run-out", "tight", "on-track", "idle"]);

/**
 * Find the most urgent known forecast across visible accounts for the
 * summary card. Items are labeled "Account · Window" so the card can name
 * the window that needs attention. Unknown/missing forecasts and
 * unlimited/credit rows are ignored.
 *
 * @param {Array<object>} connections visible connections ({ id, provider, ... })
 * @param {Record<string, {quotas?: Array<object>}>} quotaData quotas keyed by connection id
 * @returns {{ best: ({label: string, forecast: object}|null), hasForecasts: boolean }}
 */
export function getWorstForecast(connections, quotaData) {
  const items = [];
  for (const connection of connections || []) {
    const quotas = quotaData?.[connection?.id]?.quotas;
    if (!Array.isArray(quotas)) continue;
    const accountLabel = getConnectionLabel(connection) || connection?.provider || connection?.id;
    for (const quota of quotas) {
      if (quota.unlimited === true || quota.isCreditBalance === true) continue;
      if (!KNOWN_FORECAST_STATES.has(quota?.forecast?.state)) continue;
      items.push({ label: `${accountLabel} · ${quota.name}`, forecast: quota.forecast });
    }
  }
  return { best: worstForecast(items), hasForecasts: items.length > 0 };
}
