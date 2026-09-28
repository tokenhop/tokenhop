"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Fetch `/api/usage/stats?period=` and merge SSE realtime fields.
 * Copied semantics from the retired `UsageStats.js`: REST owns the full
 * stats object; `/api/usage/stream` only overwrites `activeRequests`,
 * `recentRequests`, `errorProvider` and `pending`.
 *
 * No period-over-period delta is fetched: there is no previous-window
 * endpoint, and a second stats call could not align calendar windows like
 * "today" vs yesterday, so tiles show in-period context lines instead.
 *
 * @param {string} period "today"|"24h"|"7d"|"30d"|"60d"
 * @returns {{stats: object|null, loading: boolean, fetching: boolean, error: Error|null}}
 */
export default function useUsageStats(period) {
  const [stats, setStats] = useState(null);
  const [statsPeriod, setStatsPeriod] = useState(period);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState(null);
  const isInitial = useRef(true);
  const hasLoaded = useRef(false);

  useEffect(() => {
    if (isInitial.current) {
      isInitial.current = false;
      setLoading(true);
    } else {
      setFetching(true);
    }
    setError(null);
    let cancelled = false;
    fetch(`/api/usage/stats?period=${period}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`stats ${r.status}`))))
      .then((data) => {
        if (cancelled) return;
        hasLoaded.current = true;
        // Replace (not merge): each period is a complete snapshot, so stale
        // period fields must not leak across period switches.
        setStats(data);
        setStatsPeriod(period);
      })
      .catch((e) => {
        if (!cancelled) setError(e);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setFetching(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [period]);

  useEffect(() => {
    const es = new EventSource("/api/usage/stream");
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        setStats((prev) =>
          prev
            ? {
                ...prev,
                activeRequests: data.activeRequests,
                recentRequests: data.recentRequests,
                errorProvider: data.errorProvider,
                pending: data.pending,
              }
            : prev,
        );
        if (hasLoaded.current) setLoading(false);
      } catch (err) {
        console.error("[SSE CLIENT] parse error:", err);
      }
    };
    es.onerror = () => setLoading(false);
    return () => es.close();
  }, []);

  return { stats, statsPeriod, loading, fetching, error };
}
