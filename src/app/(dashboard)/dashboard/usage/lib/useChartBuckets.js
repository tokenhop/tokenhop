"use client";

import { useCallback, useEffect, useState } from "react";
import { shapeChartSeries } from "./usageShapes";

/**
 * Shared /api/usage/chart fetch for the Usage page: one request feeds both
 * the stat-tile sparklines and the tokens chart.
 * @param {string|null} period selected period; null disables the fetch
 * @param {boolean} enabled false keeps the fetch off (quiet state / logs tab)
 * @param {number} [refreshKey] re-runs the fetch as a background refresh
 *   (same period keeps the old buckets visible instead of flashing a skeleton)
 * @returns {{ buckets: Array<object>, bucketsPeriod: string|null, loading: boolean, error: string|null, retry: () => void }}
 */
export function useChartBuckets(period, enabled, refreshKey) {
  const [buckets, setBuckets] = useState([]);
  const [bucketsPeriod, setBucketsPeriod] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt re-runs the fetch on retry; refreshKey re-runs it on catch-up.
  useEffect(() => {
    if (!enabled || !period) return;
    const controller = new AbortController();
    // Only a first fetch (or a new period) flips the skeleton; background
    // refreshes keep the current buckets on screen.
    if (bucketsPeriod !== period) setLoading(true);
    setError(null);
    fetch(`/api/usage/chart?period=${encodeURIComponent(period)}`, {
      signal: controller.signal,
    })
      .then((response) =>
        response.ok ? response.json() : Promise.reject(new Error(`chart ${response.status}`)),
      )
      .then((json) => {
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
  }, [enabled, period, attempt, refreshKey]);

  return { buckets, bucketsPeriod, loading, error, retry };
}
