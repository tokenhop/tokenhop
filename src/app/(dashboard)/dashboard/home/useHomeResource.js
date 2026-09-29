"use client";

import { useEffect, useState } from "react";
import { getSnapshot, loadResource, subscribe } from "./homeResourceStore";

const IDLE = { data: null, loading: false, error: null };
const PENDING = { data: null, loading: true, error: null };

function fromSnapshot(url, snapshot) {
  return {
    url,
    data: snapshot.data,
    error: snapshot.error,
    loading: snapshot.data == null && (snapshot.loading || snapshot.error == null),
  };
}

/**
 * A Home REST resource backed by the shared GET store: hooks reading the same
 * URL share one request, and tab-focus refresh lives in HomePageClient (stale
 * entries only). Bump `refreshKey` to force a re-read after a mutation.
 * A refresh keeps the last good data; `loading` is true only before the first
 * response. State is tagged with its URL, so a URL (period) switch never
 * returns the previous URL's data. Responses must be successful JSON.
 *
 * @param {string|null} url
 * @param {number} [refreshKey]
 * @param {{ intervalMs?: number }} [options] poll cadence; 0 disables polling. Polls pause while the tab is hidden.
 * @returns {{ data: unknown, loading: boolean, error: string|null }}
 */
export function useHomeResource(url, refreshKey = 0, { intervalMs = 0 } = {}) {
  const [state, setState] = useState(() => (url ? fromSnapshot(url, getSnapshot(url)) : null));

  useEffect(() => {
    if (!url) return undefined;
    const apply = (snapshot) => setState(fromSnapshot(url, snapshot));
    const unsubscribe = subscribe(url, apply);
    loadResource(url, { key: refreshKey });
    apply(getSnapshot(url));
    return unsubscribe;
  }, [url, refreshKey]);

  useEffect(() => {
    if (!url || intervalMs <= 0) return undefined;
    const timer = setInterval(() => {
      if (!document.hidden) loadResource(url, { key: "poll" });
    }, intervalMs);
    return () => clearInterval(timer);
  }, [url, intervalMs]);

  if (!url) return IDLE;
  if (!state || state.url !== url) return PENDING;
  const { data, loading, error } = state;
  return { data, loading, error };
}
