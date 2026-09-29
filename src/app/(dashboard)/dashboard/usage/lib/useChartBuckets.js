"use client";

import { useCallback, useEffect, useState } from "react";
import { shapeChartSeries } from "./usageShapes";

/**
 * Shared /api/usage/chart fetch for the Usage page: one request feeds both
 * the stat-tile sparklines and the tokens chart.
 * @param {string|null} period selected period; null disables the fetch
 * @param {boolean} enabled false keeps the fetch off (quiet state / logs tab)
 * @returns {{ buckets: Array<object>, loading: boolean, error: string|null, retry: () => void }}
 */
export function useChartBuckets(period, enabled) {
  const [buckets, setBuckets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt re-runs the fetch on retry.
  useEffect(() => {
    if (!enabled || !period) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/usage/chart?period=${encodeURIComponent(period)}`, {
      signal: controller.signal,
    })
      .then((response) =>
        response.ok ? response.json() : Promise.reject(new Error(`chart ${response.status}`)),
      )
      .then((json) => setBuckets(shapeChartSeries(json)))
      .catch((cause) => {
        if (cause?.name === "AbortError") return;
        setError(cause?.message || "chart request failed");
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setLoading(false);
      });
    return () => controller.abort();
  }, [enabled, period, attempt]);

  return { buckets, loading, error, retry };
}
