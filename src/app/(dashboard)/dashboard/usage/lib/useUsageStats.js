"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { initialStreamState, streamReducer } from "./streamLifecycle";

const EMPTY_LIVE = { activeRequests: [], lastProvider: "", errorProvider: "" };
const statsUrl = (period) => `/api/usage/stats?period=${period}&compare=previous`;

/**
 * Fetch `/api/usage/stats?period=&compare=previous` for the aggregate tiles and
 * keep only the live topology fields on a slim `/api/usage/stream` (YAN-407).
 *
 * `stats` is owned by REST alone: its identity changes only when period data is
 * fetched, so stream messages never re-sort the breakdown. The stream owns
 * `live` (`{activeRequests, lastProvider, errorProvider}`) in separate state
 * and is closed while the tab is hidden or the Request log tab is open; each
 * reopen triggers one catch-up stats fetch (`caughtUp` clears the flag).
 *
 * @param {string|null} period "today"|"24h"|"7d"|"30d"|"60d"; null until
 *   usePeriod resolves after hydration — no fetch happens and `loading`
 *   stays true so callers keep their skeletons.
 * @param {{tab?: "overview"|"logs"}} [options] active page tab; the stream
 *   only runs on "overview".
 * @returns {{
 *   stats: object|null period stats (compare fields included when supported);
 *   statsPeriod: string|null period `stats` was fetched for;
 *   live: {activeRequests: object[], lastProvider: string, errorProvider: string};
 *   loading: boolean; fetching: boolean; error: Error|null; retry: () => void}}
 */
export default function useUsageStats(period, { tab = "overview" } = {}) {
  const [stats, setStats] = useState(null);
  const [statsPeriod, setStatsPeriod] = useState(period);
  const [live, setLive] = useState(EMPTY_LIVE);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState(null);
  const [stream, dispatchStream] = useReducer(
    streamReducer,
    { hidden: false, tab },
    initialStreamState,
  );
  const [reload, setReload] = useState(0);
  const hasStats = useRef(false);

  // REST owns `stats`. Runs on a period change, on retry, and once per stream
  // reopen (hidden tab or logs tab came back). Only the very first load flips
  // the skeleton; later ones are background refreshes (`fetching`).
  const catchUp = stream.needsCatchUp;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload and catchUp are re-fetch triggers.
  useEffect(() => {
    // Null period: usePeriod has not resolved yet, so hold the loading state
    // instead of fetching a placeholder window.
    if (!period) return;
    const controller = new AbortController();
    if (hasStats.current) setFetching(true);
    else setLoading(true);
    setError(null);
    fetch(statsUrl(period), { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`stats ${r.status}`))))
      .then((data) => {
        // Replace (not merge): each period is a complete snapshot, so stale
        // period fields must not leak across period switches.
        hasStats.current = true;
        setStats(data);
        setStatsPeriod(period);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e);
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setLoading(false);
        setFetching(false);
        if (catchUp) dispatchStream({ type: "caughtUp" });
      });
    return () => controller.abort();
  }, [period, reload, catchUp]);

  const retry = useCallback(() => setReload((value) => value + 1), []);

  // Visibility drives the reducer. document only appears in effects, so the
  // hook renders identically on the server; this sync dispatch corrects the
  // SSR default in case the tab hydrated while hidden.
  useEffect(() => {
    dispatchStream({ type: "visibility", hidden: document.hidden });
    const onVisibility = () => dispatchStream({ type: "visibility", hidden: document.hidden });
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    dispatchStream({ type: "tab", tab });
  }, [tab]);

  // One EventSource while the reducer says the stream should be open; closing
  // on cleanup covers hidden-tab and logs-tab transitions.
  useEffect(() => {
    if (!stream.open) return;
    const es = new EventSource("/api/usage/stream");
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        setLive({
          activeRequests: Array.isArray(data.activeRequests) ? data.activeRequests : [],
          lastProvider: data.lastProvider || "",
          errorProvider: data.errorProvider || "",
        });
      } catch (err) {
        console.error("[SSE CLIENT] parse error:", err);
      }
    };
    return () => es.close();
  }, [stream.open]);

  return { stats, statsPeriod, live, loading, fetching, error, retry };
}
