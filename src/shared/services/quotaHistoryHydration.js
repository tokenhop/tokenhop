// Startup hydration for persisted quota snapshots and runway forecasts (YAN-422).
// Runs once per process (memoized on globalThis): restores live windows into
// open-sse/services/quotaSnapshot.js, replays recent probe samples into
// forecastStore.js, seeds the write rate-limiter cache, and registers the
// header-snapshot persistence observer. Always fail-open.
import { restoreSnapshot, setHeaderSnapshotObserver } from "open-sse/services/quotaSnapshot.js";
import { LOOKBACK_MS } from "@/lib/quota/forecast.js";
import { recordQuotaSample } from "@/lib/quota/forecastStore.js";
import {
  loadLatestSnapshotsUnscoped,
  loadRecentForecastSamplesUnscoped,
  recordQuotaHistorySamplesUnscoped,
  seedQuotaHistoryWriteCacheUnscoped,
} from "@/lib/db/repos/quotaHistoryRepo.js";

const G_KEY = "__tokenhopQuotaHistoryHydration";

function state() {
  if (!globalThis[G_KEY] || typeof globalThis[G_KEY] !== "object") {
    globalThis[G_KEY] = { promise: null, observerRegistered: false };
  }
  return globalThis[G_KEY];
}

/** Register the fail-open observer that persists header-derived quota snapshots. */
export function registerQuotaHistoryHeaderObserver() {
  const s = state();
  if (s.observerRegistered) return;
  s.observerRegistered = true;
  setHeaderSnapshotObserver((connectionId, provider, windows) => {
    const samples = (windows || []).map((w) => ({
      windowKind: w.kind,
      quotaKey: "",
      usedFraction: w.usedFraction,
      resetsAt: w.resetsAt,
      source: "header",
      ts: w.observedAt,
    }));
    return recordQuotaHistorySamplesUnscoped(connectionId, provider, samples);
  });
}

/**
 * Hydrate in-memory quota snapshots and forecast samples from persisted
 * `quotaHistory` rows. Never throws; returns counts for diagnostics/tests.
 *
 * @param {{ now?: number }} [opts]
 * @returns {Promise<{ snapshotsRestored: number, forecastSamplesRestored: number }>}
 */
export async function hydrateQuotaSnapshotsFromHistory({ now = Date.now() } = {}) {
  registerQuotaHistoryHeaderObserver();
  let snapshotsRestored = 0;
  let forecastSamplesRestored = 0;

  try {
    const { snapshots, latestSeriesRows } = await loadLatestSnapshotsUnscoped({ now });
    seedQuotaHistoryWriteCacheUnscoped(latestSeriesRows);
    for (const entry of snapshots) {
      const restored = restoreSnapshot(
        entry.connectionId,
        entry.provider,
        entry.windows,
        { planTier: entry.planTier, updatedAt: entry.updatedAt },
        now,
      );
      if (restored) snapshotsRestored += 1;
    }
  } catch (error) {
    console.warn(`[QuotaHistory] snapshot restore failed: ${error?.message}`);
  }

  try {
    const recent = await loadRecentForecastSamplesUnscoped({ now, lookbackMs: LOOKBACK_MS });
    for (const row of recent) {
      if (!Number.isFinite(row.usedFraction) || !Number.isFinite(row.ts)) continue;
      recordQuotaSample(
        row.connectionId,
        row.quotaKey,
        {
          remaining: Math.min(100, Math.max(0, Math.round((1 - row.usedFraction) * 10000) / 100)),
          resetAt: row.resetsAt > 0 ? row.resetsAt : null,
        },
        row.ts,
      );
      forecastSamplesRestored += 1;
    }
  } catch (error) {
    console.warn(`[QuotaHistory] forecast restore failed: ${error?.message}`);
  }

  return { snapshotsRestored, forecastSamplesRestored };
}

/**
 * Single-flight memoized hydration: runs once per process so startup and early
 * requests both see restored snapshots immediately without duplicate DB scans.
 */
export function ensureQuotaSnapshotsHydrated() {
  const s = state();
  if (!s.promise) {
    s.promise = hydrateQuotaSnapshotsFromHistory().catch(() => ({
      snapshotsRestored: 0,
      forecastSamplesRestored: 0,
    }));
  }
  return s.promise;
}

/** Test helper: reset memoized hydration state and unregister header observer. */
export function _resetQuotaHistoryHydration() {
  const s = state();
  s.promise = null;
  s.observerRegistered = false;
  setHeaderSnapshotObserver(null);
}
