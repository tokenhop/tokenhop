"use client";

import { useEffect, useState } from "react";

/**
 * A small, abortable REST resource. Set `refreshKey` to re-read after a mutation;
 * visibility restore re-reads without background polling. Responses must be successful JSON.
 * @param {string|null} url
 * @param {number} [refreshKey]
 * @returns {{ data: unknown, loading: boolean, error: string|null }}
 */
export function useHomeResource(url, refreshKey = 0) {
  const [state, setState] = useState({ data: null, loading: Boolean(url), error: null });

  // biome-ignore lint/correctness/useExhaustiveDependencies: url + refreshKey are the only intended triggers; load is defined inline per cycle.
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
        if (!controller.signal.aborted) {
          setState({ data: null, loading: false, error: error.message || "Unable to load data" });
        }
      }
    }

    load();
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [url, refreshKey]);

  return state;
}
