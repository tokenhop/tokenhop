"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { appendUsageFilters } from "./filterParams";
import { shapeChartSeries } from "./usageShapes";

/**
 * Shared /api/usage/chart fetch for the Usage page: one request feeds both
 * the stat-tile sparklines and the tokens chart.
 * @param {string|null} period selected period; null disables the fetch
 * @param {boolean} enabled false keeps the fetch off (quiet state / logs tab)
 * @param {number} [refreshKey] re-runs the fetch as a background refresh
 *   (same period keeps the old buckets visible instead of flashing a skeleton)
 * @param {{workspaceId?: string, view?: string, userId?: string, apiKeyId?: string}|null} [filters]
 *   optional scope appended to the chart URL (YAN-376); a change resets
 *   buckets so old-scope data never flashes. Null preserves unscoped behavior.
 * @returns {{ buckets: Array<object>, bucketsPeriod: string|null, loading: boolean, error: string|null, retry: () => void }}
 */
export function useChartBuckets(period, enabled, refreshKey, filters = null) {
  const [buckets, setBuckets] = useState([]);
  const [bucketsPeriod, setBucketsPeriod] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  // Callers may pass a fresh object each render: key the fetch on the encoded scope.
  const scopeKey = appendUsageFilters("", filters);
  // Last fetch that completed: re-enabling for the same period and trigger
  // values (logs tab → overview) must not re-fetch, only a real trigger does.
  const lastFetch = useRef("");

  // Scope switch: reset buckets like a new period so old-scope data never flashes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is the reset trigger.
  useEffect(() => {
    setBuckets([]);
    setBucketsPeriod(null);
    setError(null);
  }, [scopeKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt re-runs the fetch on retry; refreshKey re-runs it on catch-up; scopeKey re-runs it on a scope change.
  useEffect(() => {
    if (!enabled || !period) return;
    const key = `${period}|${attempt}|${refreshKey ?? 0}|${scopeKey}`;
    if (lastFetch.current === key) return;
    const controller = new AbortController();
    // Only a first fetch (or a new period) flips the skeleton; background
    // refreshes keep the current buckets on screen.
    if (bucketsPeriod !== period) setLoading(true);
    setError(null);
    fetch(appendUsageFilters(`/api/usage/chart?period=${encodeURIComponent(period)}`, filters), {
      signal: controller.signal,
    })
      .then((response) =>
        response.ok ? response.json() : Promise.reject(new Error(`chart ${response.status}`)),
      )
      .then((json) => {
        // Late success after abort (scope/period switch): the next effect run
        // owns state, so drop this payload instead of overwriting fresh data.
        if (controller.signal.aborted) return;
        lastFetch.current = key;
        setBuckets(shapeChartSeries(json));
        setBucketsPeriod(period);
      })
      .catch((cause) => {
        if (cause?.name === "AbortError") return;
        setError(cause?.message || "chart request failed");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [enabled, period, attempt, refreshKey, scopeKey]);

  return { buckets, bucketsPeriod, loading, error, retry };
}
