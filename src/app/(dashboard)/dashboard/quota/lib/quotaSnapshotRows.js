// Builds display-only quota entries from the persisted snapshot returned by
// `/api/usage/[id]?cached=1` (YAN-422). Never mixed into live `quotaData`.
import {
  attachForecasts,
  attachQuotaHistory,
} from "@/app/(dashboard)/dashboard/quota/lib/quotaForecastJoin.js";

function windowLabel(kind) {
  return kind.startsWith("model:") ? kind.slice("model:".length) : kind;
}

/**
 * Convert a cached usage payload into a display entry, or null when there is
 * nothing to show. Responses without `cached: true` (e.g. a server that ignores
 * the param and returned live usage) are rejected.
 *
 * @param {object|null|undefined} payload `{ cached, quotaSnapshot, forecasts, history }`
 * @returns {{quotas: Array<object>, updatedAt: string|null, stale: boolean}|null}
 */
export function buildCachedQuotaEntry(payload) {
  if (payload?.cached !== true) return null;
  const windows = payload.quotaSnapshot?.windows;
  if (!Array.isArray(windows) || windows.length === 0) return null;

  const rows = [];
  for (const window of windows) {
    if (!window || typeof window.kind !== "string" || !window.kind) continue;
    const fraction = Number(window.usedFraction);
    if (!Number.isFinite(fraction)) continue;
    const usedPct = Math.min(100, Math.max(0, fraction * 100));
    rows.push({
      name: windowLabel(window.kind),
      quotaType: window.kind,
      used: usedPct,
      total: 100,
      resetAt: typeof window.resetsAt === "string" && window.resetsAt ? window.resetsAt : null,
    });
  }
  if (rows.length === 0) return null;

  return {
    quotas: attachQuotaHistory(attachForecasts(rows, payload.forecasts), payload.history),
    updatedAt: payload.quotaSnapshot.updatedAt ?? null,
    stale: payload.quotaSnapshot.stale === true,
  };
}
