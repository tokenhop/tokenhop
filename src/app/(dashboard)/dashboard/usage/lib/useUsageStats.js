"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { initialStreamState, streamReducer } from "./streamLifecycle";
import { appendUsageFilters } from "./filterParams";

const EMPTY_LIVE = { activeRequests: [], lastProvider: "", errorProvider: "" };
const statsUrl = (period, filters) =>
  appendUsageFilters(`/api/usage/stats?period=${period}&compare=previous`, filters);

/** A repeated frame (same providers, counts, last/error provider) isn't state. */
const sameLive = (a, b) =>
  a.lastProvider === b.lastProvider &&
  a.errorProvider === b.errorProvider &&
  a.activeRequests.length === b.activeRequests.length &&
  a.activeRequests.every(
    (entry, i) =>
      entry.provider === b.activeRequests[i]?.provider &&
      entry.count === b.activeRequests[i]?.count,
  );

/**
 * Fetch `/api/usage/stats?period=&compare=previous` for the aggregate tiles and
 * keep only the live topology fields on a slim `/api/usage/stream` (YAN-407).
 *
 * `stats` is owned by REST alone: its identity changes only when period data is
 * fetched, so stream messages never re-sort the breakdown. The stream owns
 * `live` (`{activeRequests, lastProvider, errorProvider}`) in separate state
 * and is closed while the tab is hidden or the Request log tab is open. Each
 * reopen — visibility, tab switch or an EventSource reconnect after a network
 * error — triggers exactly one catch-up stats fetch (`caughtUp` clears the
 * flag, `catchUpKey` lets background consumers re-fetch too).
 *
 * @param {string|null} period "today"|"24h"|"7d"|"30d"|"60d"; null until
 *   usePeriod resolves after hydration — no fetch happens and `loading`
 *   stays true so callers keep their skeletons.
 * @param {{tab?: "overview"|"logs"}} [options] active page tab; the stream
 *   only runs on "overview".
 * @param {{workspaceId?: string, view?: string, userId?: string, apiKeyId?: string}|null} [filters]
 *   optional scope appended to the stats and stream URLs (YAN-376); a change
 *   resets `stats` and reconnects the stream so old-scope data never flashes.
 * @returns {{
 *   stats: object|null period stats (compare fields included when supported);
 *   statsPeriod: string|null period `stats` was fetched for;
 *   live: {activeRequests: object[], lastProvider: string, errorProvider: string};
 *   loading: boolean; fetching: boolean; error: Error|null; catchUpKey: number;
 *   retry: () => void}}
 */
export default function useUsageStats(period, { tab = "overview" } = {}, filters = null) {
  const [stats, setStats] = useState(null);
  const [statsPeriod, setStatsPeriod] = useState(period);
  const [live, setLive] = useState(EMPTY_LIVE);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState(null);
  const [catchUpKey, setCatchUpKey] = useState(0);
  // Hidden-tab default matches the DOM instead of SSR: the reducer state is
  // never rendered and the stream only opens inside an effect, so hydration
  // isn't affected either way.
  const [stream, dispatchStream] = useReducer(
    streamReducer,
    { hidden: typeof document !== "undefined" && document.hidden, tab },
    initialStreamState,
  );
  const [reload, setReload] = useState(0);
  const hasStats = useRef(false);
  // Callers may pass a fresh object each render: key effects on the encoded scope.
  const scopeKey = appendUsageFilters("", filters);

  // A stream reopen (hidden tab, logs tab or a reconnect came back) asks for
  // one catch-up fetch: bump the reload trigger and clear the flag in the same
  // pass, so clearing it can't re-run the fetch.
  useEffect(() => {
    if (!stream.needsCatchUp) return;
    setReload((value) => value + 1);
    setCatchUpKey((value) => value + 1);
    dispatchStream({ type: "caughtUp" });
  }, [stream.needsCatchUp]);

  // Scope switch: reset stats like a new period so old-scope data never
  // flashes; the stream effect below reconnects with the new scope.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is the reset trigger.
  useEffect(() => {
    hasStats.current = false;
    setStats(null);
    setStatsPeriod(null);
    setError(null);
    setLive(EMPTY_LIVE);
  }, [scopeKey]);

  // REST owns `stats`. Runs on a period change, on retry and on a catch-up.
  // Only the very first load flips the skeleton; later ones are background
  // refreshes (`fetching`).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is the re-fetch trigger; filters are keyed by scopeKey.
  useEffect(() => {
    // Null period: usePeriod has not resolved yet, so hold the loading state
    // instead of fetching a placeholder window.
    if (!period) return;
    const controller = new AbortController();
    if (hasStats.current) setFetching(true);
    else setLoading(true);
    setError(null);
    fetch(statsUrl(period, filters), { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`stats ${r.status}`))))
      .then((data) => {
        // Late success after abort (scope/period switch): the next effect run
        // owns state, so drop this payload instead of overwriting fresh data.
        if (controller.signal.aborted) return;
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
      });
    return () => controller.abort();
  }, [period, reload, scopeKey]);

  const retry = useCallback(() => {
    setReload((value) => value + 1);
    setCatchUpKey((value) => value + 1);
  }, []);

  // Visibility drives the reducer. Initial state reads document.hidden on
  // client; this sync dispatch catches visibility changes before the listener
  // is attached.
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
  // on cleanup covers hidden-tab and logs-tab transitions. EventSource
  // auto-reconnects after an error, so onopen after onerror asks the reducer
  // for one catch-up fetch. Scope changes rebuild the stream with the new
  // filter query so live frames match the current scope (YAN-376).
  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey rebuilds the stream on a scope change; filters are keyed by scopeKey.
  useEffect(() => {
    if (!stream.open) return;
    const es = new EventSource(appendUsageFilters("/api/usage/stream", filters));
    let sawError = false;
    let warned = false;
    es.onopen = () => {
      warned = false;
      if (sawError) {
        sawError = false;
        dispatchStream({ type: "reconnected" });
      }
    };
    es.onerror = () => {
      sawError = true;
      if (!warned) {
        warned = true;
        console.warn("[SSE CLIENT] usage stream disconnected; waiting for reconnect");
      }
    };
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        const next = {
          activeRequests: Array.isArray(data.activeRequests) ? data.activeRequests : [],
          lastProvider: data.lastProvider || "",
          errorProvider: data.errorProvider || "",
        };
        // Identical frames keep the previous state object, so no re-render.
        setLive((current) => (sameLive(current, next) ? current : next));
      } catch (err) {
        console.error("[SSE CLIENT] parse error:", err);
      }
    };
    return () => {
      es.close();
      // A closed stream must not keep lighting the routes map: drop the
      // in-flight overlay so the window model speaks alone (YAN-412).
      setLive((current) => (sameLive(current, EMPTY_LIVE) ? current : EMPTY_LIVE));
    };
  }, [stream.open, scopeKey]);

  return { stats, statsPeriod, live, loading, fetching, error, catchUpKey, retry };
}
