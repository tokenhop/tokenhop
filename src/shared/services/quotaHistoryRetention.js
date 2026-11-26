// YAN-422: bounded retention sweep for quotaHistory (30–90 days, default 60d).
// First run is delayed so pruning never competes with startup; then daily.
// Reads optional settings.quotaHistoryRetentionDays (clamped/validated 30..90,
// falling back to 60d so quotaHistory is always bounded). Never breaks startup.
import { QUOTA_SNAPSHOT } from "open-sse/config/quotaSnapshot.js";

globalThis.__quotaHistoryRetention ??= {};
const g = globalThis.__quotaHistoryRetention;

const H = QUOTA_SNAPSHOT.history;
const SWEEP_MS = 24 * 60 * 60 * 1000;
const FIRST_SWEEP_DELAY_MS = 10 * 60 * 1000;

/**
 * Resolve effective retention days in [minRetentionDays, maxRetentionDays] (30..90).
 * Missing or invalid values fall back to defaultRetentionDays (60) so history
 * stays strictly bounded.
 */
export function resolveQuotaHistoryRetentionDays(raw) {
  if (raw === undefined || raw === null || raw === "") return H.defaultRetentionDays;
  const days = Number(raw);
  if (!Number.isInteger(days)) return H.defaultRetentionDays;
  return Math.min(H.maxRetentionDays, Math.max(H.minRetentionDays, days));
}

export async function runQuotaHistoryRetention(opts = {}) {
  if (g.quotaHistoryRetentionRunning) return null;
  g.quotaHistoryRetentionRunning = true;
  try {
    const { getSettings } = await import("@/lib/db/index.js");
    const raw = (await getSettings())?.quotaHistoryRetentionDays;
    const days = resolveQuotaHistoryRetentionDays(raw);
    const { pruneQuotaHistoryUnscoped } = await import("@/lib/db/repos/quotaHistoryRepo.js");
    const result = await pruneQuotaHistoryUnscoped(days, opts);
    if (result.deleted > 0) {
      console.log(
        `[QuotaHistoryRetention] pruned ${result.deleted} row(s) in ${result.batches} batch(es) older than ${days}d`,
      );
    }
    return result;
  } catch (e) {
    console.log("[QuotaHistoryRetention] sweep failed:", e?.message);
    return null;
  } finally {
    g.quotaHistoryRetentionRunning = false;
  }
}

export function startQuotaHistoryRetention() {
  if (g.quotaHistoryRetentionInterval) return;
  g.quotaHistoryRetentionInterval = setInterval(runQuotaHistoryRetention, SWEEP_MS);
  if (g.quotaHistoryRetentionInterval.unref) g.quotaHistoryRetentionInterval.unref();
  const first = setTimeout(runQuotaHistoryRetention, FIRST_SWEEP_DELAY_MS);
  if (first.unref) first.unref();
}
