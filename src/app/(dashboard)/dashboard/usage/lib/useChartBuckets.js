"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  canReusePrevious,
  capturePreviousSnapshot,
  mergeReusedPrevious,
} from "./chartPreviousReuse";
import { appendUsageFilters } from "./filterParams";
import { periodKey, periodQuery, readUsageJson } from "./periodRequest";
import { shapeChartSeries } from "./usageShapes";

/**
 * Shared /api/usage/chart fetch for the Usage page: one request feeds both
 * the stat-tile sparklines and the tokens chart. Sends `compare=previous`
 * (YAN-1235) on initial loads and whenever the cached previous series expires
 * or rolls over; eligible background refreshes omit `compare=previous` and
 * reuse the cached `prevTokens` per bucket (YAN-1789). `all` has no previous
 * window and never requests `compare=previous`.
 * @param {string|null} period selected period ("custom" for a date range); null disables the fetch
 * @param {boolean} enabled false keeps the fetch off (quiet state / logs tab)
 * @param {number} [refreshKey] re-runs the fetch as a background refresh
 *   (same period keeps the old buckets visible instead of flashing a skeleton)
 * @param {{workspaceId?: string, view?: string, userId?: string, apiKeyId?: string}|null} [filters]
 *   optional scope appended to the chart URL (YAN-376); a change resets
 *   buckets so old-scope data never flashes. Null preserves unscoped behavior.
 * @param {{from: string, to: string}|null} [range] inclusive day range for "custom"
 * @returns {{ buckets: Array<object>, bucketsPeriod: string|null, loading: boolean, error: string|null, retry: () => void }}
 *   `bucketsPeriod` is periodKey(period, range): the bare period, or `custom:from:to`.
 */
export function useChartBuckets(period, enabled, refreshKey, filters = null, range = null) {
  // Window identity: a new custom range must re-fetch even though period stays "custom".
  const windowKey = periodKey(period, range);
  const [buckets, setBuckets] = useState([]);
  const [bucketsPeriod, setBucketsPeriod] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  // Callers may pass a fresh object each render: key the fetch on the encoded scope.
  const scopeKey = appendUsageFilters("", filters);
  // Last fetch that completed: re-enabling for the same period and trigger
  // values (logs tab → overview) must not re-fetch, only a real trigger does.
  const lastFetch = useRef("");
  const loadedScope = useRef(null);
  const previousCache = useRef(null);

  const retry = useCallback(() => {
    previousCache.current = null;
    setAttempt((count) => count + 1);
  }, []);

  // Scope switch: reset buckets like a new period so old-scope data never flashes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is the reset trigger.
  useEffect(() => {
    lastFetch.current = "";
    loadedScope.current = null;
    previousCache.current = null;
    setBuckets([]);
    setBucketsPeriod(null);
    setError(null);
  }, [scopeKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt re-runs the fetch on retry; refreshKey re-runs it on catch-up; scopeKey re-runs it on a scope change; windowKey covers period and range.
  useEffect(() => {
    if (!enabled || !windowKey) {
      setLoading(false);
      return;
    }
    const key = `${windowKey}|${attempt}|${refreshKey ?? 0}|${scopeKey}`;
    if (lastFetch.current === key) {
      // Back on already-loaded data: a fetch aborted by this switch can't clear its own skeleton.
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    // Only a first fetch (or a new period/scope) flips the skeleton; background
    // refreshes keep the current buckets on screen.
    if (bucketsPeriod !== windowKey || loadedScope.current !== scopeKey) setLoading(true);
    setError(null);
    const requestStartedAt = Date.now();
    const reuse = canReusePrevious(previousCache.current, {
      period,
      range,
      windowKey,
      scopeKey,
      now: requestStartedAt,
    });
    const includeCompare = period !== "all" && !reuse;
    const fetchChart = (withCompare) => {
      const url = `/api/usage/chart?${periodQuery(period, range)}${withCompare ? "&compare=previous" : ""}`;
      return fetch(appendUsageFilters(url, filters), {
        signal: controller.signal,
      }).then((response) => readUsageJson(response, "chart"));
    };

    fetchChart(includeCompare)
      // A 400 (invalid custom range) surfaces the server's `error` message.
      .then((json) => {
        // Late success after abort (scope/period switch): the next effect run
        // owns state, so drop this payload instead of overwriting fresh data.
        if (controller.signal.aborted) return undefined;
        const shaped = shapeChartSeries(json);
        if (reuse) {
          const merged = mergeReusedPrevious(shaped, previousCache.current, period);
          if (merged) {
            lastFetch.current = key;
            loadedScope.current = scopeKey;
            setBuckets(merged);
            setBucketsPeriod(windowKey);
            return undefined;
          }
          // Server bucket skeleton shifted (e.g. midnight rollover under clock skew):
          // clear stale cache and fall back to one full compare=previous fetch.
          previousCache.current = null;
          const fallbackStartedAt = Date.now();
          return fetchChart(true).then((fullJson) => {
            if (controller.signal.aborted) return;
            const fullShaped = shapeChartSeries(fullJson);
            previousCache.current = capturePreviousSnapshot(fullJson, fullShaped, {
              period,
              windowKey,
              scopeKey,
              now: fallbackStartedAt,
            });
            lastFetch.current = key;
            loadedScope.current = scopeKey;
            setBuckets(fullShaped);
            setBucketsPeriod(windowKey);
          });
        }
        previousCache.current = includeCompare
          ? capturePreviousSnapshot(json, shaped, {
              period,
              windowKey,
              scopeKey,
              now: requestStartedAt,
            })
          : null;
        lastFetch.current = key;
        loadedScope.current = scopeKey;
        setBuckets(shaped);
        setBucketsPeriod(windowKey);
        return undefined;
      })
      .catch((cause) => {
        if (controller.signal.aborted || cause?.name === "AbortError") return;
        setError(cause?.message || "chart request failed");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [enabled, windowKey, attempt, refreshKey, scopeKey]);

  return { buckets, bucketsPeriod, loading, error, retry };
}
