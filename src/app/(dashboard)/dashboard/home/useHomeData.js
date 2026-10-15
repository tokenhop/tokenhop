"use client";

import { useEffect, useState } from "react";
import { useSettingsScope } from "@/shared/hooks/useSettingsScope";
import { useAuthStatusState } from "@/shared/hooks/useAuthStatus";
import { STALE_MS, FOCUS_THROTTLE_MS } from "./homeResourceStore";
import {
  keyIdentity,
  keyIdentityReady,
  loadKeyContext,
  loadKeyList,
} from "../endpoint/hooks/keyApi";
import { settingsEndpoint } from "@/shared/utils/settingsApi";
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
 * API keys list (context-aware: workspace-scoped in hashed storage, legacy
 * unscoped when pristine/off). Members list their own keys; viewers skip.
 * @param {number} refreshKey bump to re-read after create/toggle
 * @returns {{ keys: Array<object>, context: object|null, loading: boolean, error: string|null }}
 */
export function useHomeKeys(refreshKey = 0) {
  const { status: authStatus, loaded: authReady } = useAuthStatusState();
  const identity = keyIdentity(authStatus);
  const ready = authReady && keyIdentityReady(authStatus);
  const [state, setState] = useState({
    id: null,
    keys: [],
    context: null,
    loading: true,
    error: null,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: authStatus covered by identity; refreshKey forces reload
  useEffect(() => {
    if (!ready) return undefined;
    let cancelled = false;
    let inFlight = false;
    let lastLoadedAt = 0;
    let lastFocusAt = 0;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const context = await loadKeyContext(authStatus);
        if (cancelled) return;
        const keys = await loadKeyList(context);
        if (!cancelled) setState({ id: identity, keys, context, loading: false, error: null });
      } catch (err) {
        if (!cancelled) {
          setState({
            id: identity,
            keys: [],
            context: null,
            loading: false,
            error: err?.message || "Could not load the keys",
          });
        }
      } finally {
        inFlight = false;
        lastLoadedAt = Date.now();
      }
    };
    load();
    // Same stale-on-focus contract as the shared Home resource store.
    const onVisible = () => {
      const now = Date.now();
      if (document.hidden || now - lastFocusAt < FOCUS_THROTTLE_MS) return;
      if (now - lastLoadedAt < STALE_MS) return;
      lastFocusAt = now;
      load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ready, identity, refreshKey]);

  if (!authReady) return { identity, keys: [], context: null, loading: true, error: null };
  if (!ready) {
    return {
      keys: [],
      context: null,
      loading: false,
      identity,
      error: "Could not load key permissions. Reload to try again.",
    };
  }
  if (state.id !== identity)
    return { identity, keys: [], context: null, loading: true, error: null };
  return {
    identity,
    keys: state.keys,
    context: state.context,
    loading: state.loading,
    error: state.error,
  };
}

/**
 * Tailscale + Cloudflare tunnel status, trust state and settings flags.
 * Settings and host status are gated independently by their capabilities;
 * unavailable settings leave `requireApiKey: null` so local UI still renders.
 * @param {number} refreshKey bump to re-read after enable/disable
 * @returns {{ tunnel: object, loading: boolean, error: string|null }}
 */
export function useHomeWaysIn(refreshKey = 0) {
  const { ready, canManageInstance, canHostOps } = useSettingsScope();
  const {
    data,
    loading: statusLoading,
    error: statusError,
  } = useHomeResource(ready && canHostOps ? "/api/tunnel/status" : null, refreshKey);
  const {
    data: settings,
    loading: settingsLoading,
    error: settingsError,
  } = useHomeResource(ready && canManageInstance ? "/api/settings" : null, refreshKey);
  // A failed refresh keeps the last good snapshot in the store: never drive
  // host chips or the Enable action from that stale/errored state.
  const hostAvailable = ready && canHostOps && data != null && !statusError;
  const tunnel = {
    tunnel: hostAvailable ? (data.tunnel ?? null) : null,
    tailscale: hostAvailable ? (data.tailscale ?? null) : null,
    canHostOps: hostAvailable,
    requireApiKey:
      ready && canManageInstance && settings != null ? Boolean(settings.requireApiKey) : null,
  };
  return {
    tunnel,
    loading: !ready || statusLoading || settingsLoading,
    error:
      (ready && canHostOps ? statusError : null) ||
      (ready && canManageInstance ? settingsError : null),
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
 * @returns {{ combos: Array<object>, strategies: object, globalStrategy: string, loading: boolean, error: string|null }}
 */
export function useHomeCombos(refreshKey = 0) {
  const {
    data,
    loading: combosLoading,
    error: combosError,
  } = useHomeResource("/api/combos", refreshKey);
  // YAN-749: scoped, read the workspace's effective values (id-keyed
  // comboStrategies, YAN-364) and re-key them by name for CombosTop.
  const { ready, scope } = useSettingsScope();
  const {
    data: settings,
    loading: settingsLoading,
    error: settingsError,
  } = useHomeResource(ready ? settingsEndpoint("comboStrategies", scope) : null, refreshKey);
  const combos = Array.isArray(data?.combos) ? data.combos : [];
  // Workspace GET is `{ data, effective }`; the instance GET is the flat blob.
  const values = scope?.workspaceId ? settings?.effective : settings;
  const raw = values?.comboStrategies;
  const map = raw && typeof raw === "object" ? raw : {};
  const strategies = scope?.workspaceId
    ? Object.fromEntries(combos.filter((c) => map[c.id]).map((c) => [c.name, map[c.id]]))
    : map;
  return {
    combos,
    strategies,
    globalStrategy: values?.comboStrategy || "fallback",
    loading: combosLoading || settingsLoading || !ready,
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
