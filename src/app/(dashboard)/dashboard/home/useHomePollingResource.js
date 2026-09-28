"use client";

import { useEffect, useState } from "react";

/**
 * Polling REST resource for live Home widgets. Polls at `intervalMs` (at or
 * below the existing usage cadence), pauses while the tab is hidden, and
 * re-reads on visibility restore. Responses must be successful JSON.
 *
 * @param {string|null} url
 * @param {number} [refreshKey] bump to re-read immediately
 * @param {number} [intervalMs] poll cadence; 0 disables polling
 * @returns {{ data: unknown, loading: boolean, error: string|null }}
 */
export function useHomePollingResource(url, refreshKey = 0, intervalMs = 0) {
  const [state, setState] = useState({ data: null, loading: Boolean(url), error: null });

  // biome-ignore lint/correctness/useExhaustiveDependencies: url + refreshKey + intervalMs are the only intended triggers; load is defined inline per cycle.
  useEffect(() => {
    if (!url) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    const controller = new AbortController();

    async function load() {
      setState((current) => ({ ...current, loading: true, error: null }));
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.error || `Request failed (${response.status})`);
        }
        const data = await response.json();
        if (!controller.signal.aborted) setState({ data, loading: false, error: null });
      } catch (error) {
        // Keep the last good render on transient failures; the card shows the
        // error with a retry instead of blanking to an error state.
        if (!controller.signal.aborted) {
          setState((current) => ({
            ...current,
            loading: false,
            error: error.message || "Unable to load data",
          }));
        }
      }
    }

    load();
    let timer = null;
    if (intervalMs > 0) {
      timer = setInterval(() => {
        if (!document.hidden) load();
      }, intervalMs);
    }
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [url, refreshKey, intervalMs]);

  return state;
}
