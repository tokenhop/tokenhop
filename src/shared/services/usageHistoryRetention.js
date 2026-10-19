// YAN-424: opt-in usageHistory retention sweep. The first run is delayed so
// pruning never competes with startup; then it repeats daily. Reads
// usageHistoryRetentionDays on every run (0 = keep forever = no-op), so a
// settings change takes effect on the next tick without a restart. Never
// breaks startup; overlapping runs are skipped. Survives Next.js hot reload
// via the shared singleton (see initializeApp.js).
//
// No VACUUM on purpose: SQLite reuses the freed pages for new rows, so the
// file stops growing; VACUUM would block the database while it runs and, under
// the sql.js fallback, rewrites the whole file.
global.__appSingleton ??= {};
const g = global.__appSingleton;

const SWEEP_MS = 24 * 60 * 60 * 1000;
const FIRST_SWEEP_DELAY_MS = 10 * 60 * 1000;
const MIN_DAYS = 2;
const MAX_DAYS = 3650;

/** Valid stored values: 0 (keep forever) or an integer in 2..3650. Else null (invalid). */
function parseDays(value) {
  const days = Number(value);
  if (days === 0) return 0;
  return Number.isInteger(days) && days >= MIN_DAYS && days <= MAX_DAYS ? days : null;
}

export async function runUsageHistoryRetention() {
  if (g.usageHistoryRetentionRunning) return null;
  g.usageHistoryRetentionRunning = true;
  try {
    const { getSettings } = await import("@/lib/localDb");
    const raw = (await getSettings()).usageHistoryRetentionDays;
    const days = parseDays(raw);
    if (days === null) {
      // Hand-edited or imported garbage: never prune on it, warn once per value.
      if (g.usageHistoryRetentionWarned !== String(raw)) {
        g.usageHistoryRetentionWarned = String(raw);
        console.warn(
          "[UsageRetention] ignoring invalid usageHistoryRetentionDays (expected 0 or 2..3650)",
        );
      }
      return null;
    }
    if (days === 0) return null;
    const { pruneUsageHistoryUnscoped } = await import("@/lib/db/repos/usageRetentionRepo.js");
    const result = await pruneUsageHistoryUnscoped(days);
    if (result.deleted > 0) {
      console.log(
        `[UsageRetention] pruned ${result.deleted} row(s) in ${result.batches} batch(es) older than ${days}d`,
      );
    }
    // Skipped legacy days / non-canonical rows repeat every run: log on change only.
    const skipKey = `${result.skippedDays}/${result.nonCanonicalRows}`;
    if (
      (result.skippedDays || result.nonCanonicalRows) &&
      g.usageHistoryRetentionSkip !== skipKey
    ) {
      console.log(
        `[UsageRetention] kept ${result.skippedDays} day(s) not covered by the rollup and ${result.nonCanonicalRows} row(s) with non-standard timestamps`,
      );
    }
    g.usageHistoryRetentionSkip = skipKey;
    return result;
  } catch (e) {
    console.log("[UsageRetention] sweep failed:", e.message);
    return null;
  } finally {
    g.usageHistoryRetentionRunning = false;
  }
}

export function startUsageHistoryRetention() {
  if (g.usageHistoryRetentionInterval) return;
  g.usageHistoryRetentionInterval = setInterval(runUsageHistoryRetention, SWEEP_MS);
  if (g.usageHistoryRetentionInterval.unref) g.usageHistoryRetentionInterval.unref();
  const first = setTimeout(runUsageHistoryRetention, FIRST_SWEEP_DELAY_MS);
  if (first.unref) first.unref();
}
