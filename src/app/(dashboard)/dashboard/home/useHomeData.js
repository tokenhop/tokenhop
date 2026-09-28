"use client";

import { useHomeResource } from "./useHomeResource";
import { useHomePollingResource } from "./useHomePollingResource";

/** Live-routes poll cadence: 60s, matching the quota snapshot poller tick. */
export const LIVE_ROUTES_POLL_MS = 60_000;

/**
 * Usage stats for a Home period (today/7d/30d).
 * @param {"today"|"7d"|"30d"} period
 * @param {number} [refreshKey] bump to re-read
 * @returns {{ current: object|null, loading: boolean, error: string|null }}
 */
export function useHomeUsage(period, refreshKey = 0) {
  const { data, loading, error } = useHomeResource(`/api/usage/stats?period=${period}`, refreshKey);
  return { current: data, loading, error };
}

/**
 * Chart buckets for the cost sparkline (token series are not request counts).
 * @param {"today"|"7d"|"30d"} period
 * @param {number} [refreshKey] bump to re-read
 * @returns {{ buckets: Array<{ tokens: number, cost: number }>|null, loading: boolean, error: string|null }}
 */
export function useHomeChart(period, refreshKey = 0) {
  const { data, loading, error } = useHomeResource(`/api/usage/chart?period=${period}`, refreshKey);
  return { buckets: Array.isArray(data) ? data : null, loading, error };
}

/**
 * Token-saver savings for a period. Only recorded aggregation is shown:
 * an endpoint failure or malformed payload surfaces `savingsUnavailable`
 * so the tile can say "Savings data unavailable" instead of inventing numbers.
 * @param {"today"|"7d"|"30d"} period
 * @param {number} [refreshKey] bump to re-read
 * @returns {{ savings: object|null, loading: boolean, error: null, savingsUnavailable: boolean }}
 */
export function useHomeSavings(period, refreshKey = 0) {
  const { data, loading } = useHomeResource(`/api/usage/savings?period=${period}`, refreshKey);
  const valid =
    data && typeof data.tokensSavedEst === "number" && Array.isArray(data.methods) ? data : null;
  const savingsUnavailable = !loading && !valid;
  return {
    savings: valid,
    loading,
    error: null,
    savingsUnavailable,
  };
}

/**
 * Previous-period request count + top-combo counts for a Home period.
 * Failures degrade gracefully: delta text and combo counts fall back to
 * "unavailable", derived from /api/usage/stats instead of erroring.
 * @param {"today"|"7d"|"30d"} period
 * @param {number} [refreshKey] bump to re-read
 * @returns {{ summary: object|null, loading: boolean, error: null }}
 */
export function useHomeSummary(period, refreshKey = 0) {
  const { data, loading } = useHomeResource(`/api/home/summary?period=${period}`, refreshKey);
  const valid = data && typeof data === "object" ? data : null;
  return { summary: valid, loading, error: null };
}

/**
 * API keys list (full records; callers mask before display).
 * @param {number} refreshKey bump to re-read after create/toggle
 * @returns {{ keys: Array<object>, loading: boolean, error: string|null }}
 */
export function useHomeKeys(refreshKey = 0) {
  const { data, loading, error } = useHomeResource("/api/keys", refreshKey);
  const keys = Array.isArray(data?.keys) ? data.keys : [];
  return { keys, loading, error };
}

/**
 * Tailscale + Cloudflare tunnel status, trust state and settings flags.
 * @param {number} refreshKey bump to re-read after enable/disable
 * @returns {{ tunnel: object, loading: boolean, error: string|null }}
 */
export function useHomeWaysIn(refreshKey = 0) {
  const {
    data,
    loading: statusLoading,
    error: statusError,
  } = useHomeResource("/api/tunnel/status", refreshKey);
  const {
    data: settings,
    loading: settingsLoading,
    error: settingsError,
  } = useHomeResource("/api/settings", refreshKey);
  const tunnel = {
    tunnel: data?.tunnel ?? null,
    tailscale: data?.tailscale ?? null,
    requireApiKey: Boolean(settings?.requireApiKey),
  };
  return {
    tunnel,
    loading: statusLoading || settingsLoading,
    error: statusError || settingsError,
  };
}

/**
 * Provider connections (secrets stripped server-side).
 * @param {number} [refreshKey] bump to re-read
 * @returns {{ connections: Array<object>, loading: boolean, error: string|null }}
 */
export function useHomeProviders(refreshKey = 0) {
  const { data, loading, error } = useHomeResource("/api/providers", refreshKey);
  const connections = Array.isArray(data?.connections) ? data.connections : [];
  return { connections, loading, error };
}

/**
 * Combos plus strategy metadata for the top-used cards.
 * @param {number} [refreshKey] bump to re-read
 * @returns {{ combos: Array<object>, strategies: object, loading: boolean, error: string|null }}
 */
export function useHomeCombos(refreshKey = 0) {
  const {
    data,
    loading: combosLoading,
    error: combosError,
  } = useHomeResource("/api/combos", refreshKey);
  const {
    data: settings,
    loading: settingsLoading,
    error: settingsError,
  } = useHomeResource("/api/settings", refreshKey);
  const combos = Array.isArray(data?.combos) ? data.combos : [];
  const strategies =
    settings?.comboStrategies && typeof settings.comboStrategies === "object"
      ? settings.comboStrategies
      : {};
  return {
    combos,
    strategies,
    loading: combosLoading || settingsLoading,
    error: combosError || settingsError,
  };
}

/**
 * Quota snapshot accounts from GET /api/home/quota (server-side cached,
 * no upstream probe). Accounts without a snapshot degrade to Unknown.
 * @param {number} [refreshKey] bump to re-read
 * @returns {{ accounts: Array<object>, loading: boolean, error: string|null }}
 */
export function useHomeQuota(refreshKey = 0) {
  const { data, loading, error } = useHomeResource("/api/home/quota", refreshKey);
  const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
  return { accounts, loading, error };
}

/**
 * Live routes flow model: polling at the quota cadence, paused when hidden.
 * @param {number} [refreshKey] bump to re-read
 * @returns {{ routes: object|null, loading: boolean, error: string|null }}
 */
export function useHomeLiveRoutes(refreshKey = 0) {
  const { data, loading, error } = useHomePollingResource(
    "/api/home/live-routes",
    refreshKey,
    LIVE_ROUTES_POLL_MS,
  );
  const valid = data && Array.isArray(data.clients) && Array.isArray(data.providers) ? data : null;
  return { routes: valid, loading, error };
}

/**
 * Request details for the recent-requests rows (route + latency live here).
 * Null when observability is disabled or empty.
 * @param {number} [refreshKey] bump to re-read
 * @returns {{ details: Array<object>|null, loading: boolean, error: string|null }}
 */
export function useHomeRecentDetails(refreshKey = 0) {
  const { data, loading, error } = useHomeResource(
    "/api/usage/request-details?page=1&pageSize=6",
    refreshKey,
  );
  const details = Array.isArray(data?.details) ? data.details : null;
  return { details, loading, error };
}
