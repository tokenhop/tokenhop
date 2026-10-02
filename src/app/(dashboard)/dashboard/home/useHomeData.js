"use client";

import { useEffect, useState } from "react";
import { useHomeResource } from "./useHomeResource";

/** Builds the period-scoped endpoint URL; null while the period is unresolved. */
const periodUrl = (path, period) => (period ? `${path}?period=${period}` : null);

/**
 * Usage stats for a Home period (today/24h/7d/30d/60d). A null period (URL and
 * storage not resolved yet) keeps the tiles on skeletons without fetching.
 * @param {"today"|"24h"|"7d"|"30d"|"60d"|null} period
 * @param {number} [refreshKey] bump to re-read
 * @returns {{ current: object|null, currentPeriod: string|null, loading: boolean, error: string|null }}
 *   `currentPeriod` is the period `current` was fetched for (it lags a switch until the refetch lands).
 */
export function useHomeUsage(period, refreshKey = 0) {
  const [currentPeriod, setCurrentPeriod] = useState(null);
  const { data, loading, error } = useHomeResource(
    periodUrl("/api/usage/stats", period),
    refreshKey,
  );
  useEffect(() => {
    if (data && !loading) setCurrentPeriod(period);
  }, [data, loading, period]);
  return { current: data, currentPeriod, loading: loading || period === null, error };
}

/**
 * Chart buckets for the cost and requests sparklines.
 * @param {"today"|"24h"|"7d"|"30d"|"60d"|null} period
 * @param {number} [refreshKey] bump to re-read
 * @returns {{ buckets: Array<{ tokens: number, cost: number, requests?: number }>|null, loading: boolean, error: string|null }}
 */
export function useHomeChart(period, refreshKey = 0) {
  const { data, loading, error } = useHomeResource(
    periodUrl("/api/usage/chart", period),
    refreshKey,
  );
  return { buckets: Array.isArray(data) ? data : null, loading: loading || period === null, error };
}

/**
 * Token-saver savings for a period. Only recorded aggregation is shown:
 * an endpoint failure or malformed payload surfaces `savingsUnavailable`
 * so the tile can say "Savings data unavailable" instead of inventing numbers.
 * @param {"today"|"24h"|"7d"|"30d"|"60d"|null} period
 * @param {number} [refreshKey] bump to re-read
 * @returns {{ savings: object|null, loading: boolean, error: null, savingsUnavailable: boolean }}
 */
export function useHomeSavings(period, refreshKey = 0) {
  const { data, loading } = useHomeResource(periodUrl("/api/usage/savings", period), refreshKey);
  const waiting = loading || period === null;
  const valid =
    data && typeof data.tokensSavedEst === "number" && Array.isArray(data.methods) ? data : null;
  const savingsUnavailable = !waiting && !valid;
  return {
    savings: valid,
    loading: waiting,
    error: null,
    savingsUnavailable,
  };
}

/**
 * Previous-period request count + top-combo counts for a Home period.
 * Failures degrade gracefully: delta text and combo counts fall back to
 * "unavailable", derived from /api/usage/stats instead of erroring.
 * @param {"today"|"24h"|"7d"|"30d"|"60d"|null} period
 * @param {number} [refreshKey] bump to re-read
 * @returns {{ summary: object|null, loading: boolean, error: null }}
 */
export function useHomeSummary(period, refreshKey = 0) {
  const { data, loading } = useHomeResource(periodUrl("/api/home/summary", period), refreshKey);
  const valid = data && typeof data === "object" ? data : null;
  return { summary: valid, loading: loading || period === null, error: null };
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
