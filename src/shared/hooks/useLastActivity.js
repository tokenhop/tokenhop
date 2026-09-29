"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Most recent request time, fetched the first time the page turns quiet.
 * The value is period-independent, so later quiet periods reuse it instead of
 * refetching; `retry` re-reads after a failure.
 * @param {boolean} enabled
 * @returns {{lastRequestAt: string|null|undefined, loading: boolean, error: string|null, retry: () => void}}
 *   `lastRequestAt` is undefined until loaded and null when there was never a request.
 */
export default function useLastActivity(enabled) {
  const [lastRequestAt, setLastRequestAt] = useState(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const loaded = lastRequestAt !== undefined;

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the retry trigger.
  useEffect(() => {
    if (!enabled || loaded) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    async function load() {
      try {
        const response = await fetch("/api/usage/last-activity", {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
        if (!controller.signal.aborted) setLastRequestAt(payload?.lastRequestAt ?? null);
      } catch (cause) {
        if (controller.signal.aborted || cause?.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : "Request failed");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    load();
    return () => controller.abort();
  }, [enabled, loaded, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return { lastRequestAt, loading, error, retry };
}
