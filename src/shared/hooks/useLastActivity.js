"use client";

import { useEffect, useState } from "react";

/**
 * Fetch most recent request only while the containing period is quiet.
 * @param {boolean} enabled
 * @returns {{lastRequestAt: string|null|undefined, loading: boolean, error: string|null}}
 */
export default function useLastActivity(enabled) {
  const [lastRequestAt, setLastRequestAt] = useState(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setLastRequestAt(undefined);
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
  }, [enabled]);

  return { lastRequestAt, loading, error };
}
