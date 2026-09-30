"use client";

import { useHomeResource } from "@/app/(dashboard)/dashboard/home/useHomeResource";

/** Live-routes poll cadence: 60s, matching the quota snapshot poller tick. */
export const LIVE_ROUTES_POLL_MS = 60_000;

/**
 * Live routes flow model (`/api/home/live-routes`), shared by Home and Usage
 * (YAN-412). Polls at the quota cadence, pauses while the tab is hidden and
 * keeps the last good model under a poll error. Backed by the Home GET store
 * so both pages share one request when mounted together.
 *
 * @param {number} [refreshKey] bump to re-read (manual retry)
 * @returns {{ routes: object|null, loading: boolean, error: string|null }}
 */
export default function useLiveRoutes(refreshKey = 0) {
  const { data, loading, error } = useHomeResource("/api/home/live-routes", refreshKey, {
    intervalMs: LIVE_ROUTES_POLL_MS,
  });
  const valid = data && Array.isArray(data.clients) && Array.isArray(data.providers) ? data : null;
  return { routes: valid, loading, error };
}
