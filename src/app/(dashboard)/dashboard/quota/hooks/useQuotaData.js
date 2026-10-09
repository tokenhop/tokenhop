"use client";
import { useSettingsScope } from "@/shared/hooks/useSettingsScope";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AUTO_REFRESH_STORAGE_KEY,
  CLAUDE_REFRESH_INTERVAL_MS,
  REFRESH_INTERVAL_MS,
  buildLoadingState,
  filterQuotaStateByConnections,
  getProviderOptions,
  getSafePagination,
  getSafeTotals,
  parseQuotaData,
  setQuotaCache,
} from "@/app/(dashboard)/dashboard/quota/lib/quotaUtils.js";
import { attachForecasts } from "@/app/(dashboard)/dashboard/quota/lib/quotaForecastJoin.js";

/**
 * useQuotaData — fetching + refresh state extracted from QuotaPageClient.
 * Owns connections list, per-connection quota/errors/loading, auto-refresh
 * polling (one interval, paused while the tab is hidden), and force refresh.
 * The page keeps filters, sorting, visibility, and per-row actions.
 */
export function useQuotaData({ page, setPage, pageSize, accountFilter, providerFilter, notify }) {
  const { ready, scope } = useSettingsScope();
  const [connections, setConnections] = useState([]);
  const [quotaData, setQuotaData] = useState({});
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});
  const [connectionsError, setConnectionsError] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [hasHydratedAutoRefresh, setHasHydratedAutoRefresh] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [nextRefreshAt, setNextRefreshAt] = useState(null);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [initialQuotaLoaded, setInitialQuotaLoaded] = useState(false);
  const [providerOptions, setProviderOptions] = useState([]);
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize,
    total: 0,
    totalPages: 1,
  });
  const [totals, setTotals] = useState({
    eligibleConnections: 0,
    providerFilteredConnections: 0,
  });

  const intervalRef = useRef(null);
  const refreshingRef = useRef(false);
  const tickCountRef = useRef(0);
  const connectionsGenerationRef = useRef(0);
  const quotaGenerationsRef = useRef(new Map());
  const viewRef = useRef({ page, pageSize, accountFilter, providerFilter });
  const previousView = viewRef.current;
  if (
    previousView.page !== page ||
    previousView.pageSize !== pageSize ||
    previousView.accountFilter !== accountFilter ||
    previousView.providerFilter !== providerFilter
  ) {
    viewRef.current = { page, pageSize, accountFilter, providerFilter };
  }
  const invalidateQuota = useCallback((id) => {
    const generations = quotaGenerationsRef.current;
    generations.set(id, (generations.get(id) || 0) + 1);
  }, []);
  // Drop state for accounts no longer listed and ignore their in-flight quota settles.
  // Keys stay in the map (bounded by account count): deleting one would restart its
  // counter and let an old in-flight settle match a new request's generation.
  const pruneQuotaState = useCallback(
    (list) => {
      const keep = new Set(list.map((c) => c.id));
      for (const id of quotaGenerationsRef.current.keys()) {
        if (!keep.has(id)) invalidateQuota(id);
      }
      setLoading((prev) => filterQuotaStateByConnections(prev, list));
      setErrors((prev) => filterQuotaStateByConnections(prev, list));
      setQuotaData((prev) => filterQuotaStateByConnections(prev, list));
    },
    [invalidateQuota],
  );
  const refreshAllRef = useRef(null);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const setPageRef = useRef(setPage);
  setPageRef.current = setPage;

  const clearPoll = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // Fetch connections list from the backend
  const fetchConnections = useCallback(
    async (targetPage = page) => {
      if (!ready) return null;
      const generation = connectionsGenerationRef.current + 1;
      connectionsGenerationRef.current = generation;
      try {
        const params = new URLSearchParams({
          page: String(targetPage),
          pageSize: String(pageSize),
          accountStatus: accountFilter,
          sort: "priority",
        });

        if (scope?.workspaceId) params.set("workspaceId", scope.workspaceId);
        if (providerFilter !== "all") {
          params.set("provider", providerFilter);
        }

        const response = await fetch(`/api/providers/client?${params.toString()}`);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(`HTTP ${response.status}: ${errorData.error || response.statusText}`);
        }

        const data = await response.json();
        if (generation !== connectionsGenerationRef.current) return null;
        const connectionList = data.connections || [];
        const nextPagination = getSafePagination(data.pagination, pageSize);
        const nextTotals = getSafeTotals(data.totals, connectionList.length);

        setConnections(connectionList);
        setConnectionsError(null);
        setProviderOptions(getProviderOptions(data.providerOptions));
        setPagination(nextPagination);
        if (nextPagination.page !== targetPage) setPageRef.current?.(nextPagination.page);
        setTotals(nextTotals);
        return connectionList;
      } catch (error) {
        if (generation !== connectionsGenerationRef.current) return null;
        console.error("Error fetching connections:", error);
        setConnections([]);
        setConnectionsError(error.message || "Failed to fetch connections");
        setProviderOptions([]);
        setPagination({ page: 1, pageSize, total: 0, totalPages: 1 });
        setTotals({ eligibleConnections: 0, providerFilteredConnections: 0 });
        throw error;
      }
    },
    [accountFilter, page, pageSize, providerFilter, ready, scope?.workspaceId],
  );

  // Fetch quota for a specific connection; 401/404 surface as row errors.
  const fetchQuota = useCallback(
    async (connectionId, provider, { force = false } = {}) => {
      // Latest request per account wins; older settles (data, errors, cache, loading) are dropped.
      // A changed page/filters/size invalidates in-flight settles captured under the previous view.
      const view = viewRef.current;
      invalidateQuota(connectionId);
      const generation = quotaGenerationsRef.current.get(connectionId);
      const isCurrent = () =>
        viewRef.current === view && quotaGenerationsRef.current.get(connectionId) === generation;
      setLoading((prev) => ({ ...prev, [connectionId]: true }));
      setErrors((prev) => ({ ...prev, [connectionId]: null }));

      try {
        const url = `/api/usage/${connectionId}${force ? "?force=1" : ""}`;
        const response = await fetch(url);

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const errorMsg = errorData.error || response.statusText;
          if (response.status === 401 && isCurrent()) {
            const quotaEntry = { quotas: [], message: errorMsg };
            setQuotaData((prev) => ({ ...prev, [connectionId]: quotaEntry }));
            setQuotaCache(connectionId, quotaEntry);
          }
          throw new Error(`HTTP ${response.status}: ${errorMsg}`);
        }

        const data = await response.json();
        const parsedQuotas = attachForecasts(parseQuotaData(provider, data), data.forecasts);

        const quotaEntry = {
          quotas: parsedQuotas,
          plan: data.plan || null,
          message: data.message || null,
          raw: data,
        };

        if (!isCurrent()) return null;
        setQuotaData((prev) => ({ ...prev, [connectionId]: quotaEntry }));
        setQuotaCache(connectionId, quotaEntry);
        return true;
      } catch (error) {
        if (!isCurrent()) return null;
        console.error(`[Quota] Error fetching quota for ${provider} (${connectionId}):`, error);
        setErrors((prev) => ({
          ...prev,
          [connectionId]: error.message || "Failed to fetch quota",
        }));
        return false;
      } finally {
        if (isCurrent()) setLoading((prev) => ({ ...prev, [connectionId]: false }));
      }
    },
    [invalidateQuota],
  );

  const refreshProvider = useCallback(
    async (connectionId, provider) => {
      await fetchQuota(connectionId, provider, { force: true });
    },
    [fetchQuota],
  );

  const refreshAll = useCallback(
    async (force = false) => {
      if (refreshingRef.current) return undefined;
      refreshingRef.current = true;
      setRefreshingAll(true);

      tickCountRef.current += 1;
      const tick = tickCountRef.current;
      const claudeEvery = Math.round(CLAUDE_REFRESH_INTERVAL_MS / REFRESH_INTERVAL_MS);
      const shouldFetch = (conn) => force || conn.provider !== "claude" || tick % claudeEvery === 0;

      try {
        const visibleConnections = await fetchConnections(page);
        if (!visibleConnections) return undefined;
        const targets = visibleConnections.filter(shouldFetch);
        setLoading(buildLoadingState(targets));
        pruneQuotaState(visibleConnections);

        const results = await Promise.all(
          targets.map((conn) => fetchQuota(conn.id, conn.provider, { force })),
        );
        const failed = results.filter((ok) => ok === false).length;
        const summary = { total: targets.length, failed };
        if (failed > 0) {
          notifyRef.current?.error(
            `Quota refresh finished with ${failed} of ${targets.length} account${targets.length > 1 ? "s" : ""} failing.`,
            {
              action: {
                label: "Retry",
                onSelect: () => refreshAll(true),
              },
            },
          );
        }
        return summary;
      } catch (error) {
        console.error("Error refreshing quota:", error);
        notifyRef.current?.error(
          `Quota refresh failed: ${error.message || "Failed to fetch connections"}`,
          {
            action: { label: "Retry", onSelect: () => refreshAll(true) },
          },
        );
        return undefined;
      } finally {
        refreshingRef.current = false;
        setRefreshingAll(false);
      }
    },
    [fetchConnections, fetchQuota, page, pruneQuotaState],
  );

  refreshAllRef.current = refreshAll;

  const retryLoad = useCallback(async () => {
    try {
      const list = await fetchConnections(page);
      if (!list) return;
      setLoading(buildLoadingState(list));
      pruneQuotaState(list);
      await Promise.all(list.map((conn) => fetchQuota(conn.id, conn.provider)));
    } catch {
      // fetchConnections records the error for the retry UI.
    }
  }, [fetchConnections, fetchQuota, page, pruneQuotaState]);

  // Initial load
  useEffect(() => {
    if (!ready) return undefined;
    let cancelled = false;
    async function init() {
      setConnectionsLoading(true);
      // Failure already recorded in connectionsError; render it, don't toast on mount.
      const list = await fetchConnections(page).catch(() => []);
      if (cancelled) return;
      setConnectionsLoading(false);
      // Superseded: the newer request owns list + quota fetches.
      if (!list) {
        setInitialQuotaLoaded(true);
        return;
      }

      setLoading(buildLoadingState(list));
      pruneQuotaState(list);

      await Promise.all(list.map((c) => fetchQuota(c.id, c.provider)));
      if (!cancelled) setInitialQuotaLoaded(true);
    }
    init();
    return () => {
      cancelled = true;
    };
  }, [fetchConnections, fetchQuota, page, pruneQuotaState, ready]);

  // Hydrate & persist autoRefresh
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(AUTO_REFRESH_STORAGE_KEY);
    setAutoRefresh(stored === null ? true : stored === "true");
    setHasHydratedAutoRefresh(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !hasHydratedAutoRefresh) return;
    window.localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, String(autoRefresh));
  }, [autoRefresh, hasHydratedAutoRefresh]);

  // One interval; consumers derive the countdown from nextRefreshAt.
  useEffect(() => {
    const schedule = () => {
      clearPoll();
      if (!hasHydratedAutoRefresh || !autoRefresh || document.hidden) {
        setNextRefreshAt(null);
        return;
      }
      setNextRefreshAt(Date.now() + REFRESH_INTERVAL_MS);
      intervalRef.current = setInterval(() => {
        // Interval cadence is fixed, so the next tick is one interval from now.
        setNextRefreshAt(Date.now() + REFRESH_INTERVAL_MS);
        refreshAllRef.current?.();
      }, REFRESH_INTERVAL_MS);
    };
    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => {
      clearPoll();
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [autoRefresh, hasHydratedAutoRefresh, clearPoll]);

  return {
    connections,
    quotaData,
    loading,
    errors,
    connectionsError,
    autoRefresh,
    setAutoRefresh,
    refreshingAll,
    nextRefreshAt,
    connectionsLoading,
    initialQuotaLoaded,
    pagination,
    totals,
    providerOptions,
    fetchConnections,
    fetchQuota,
    invalidateQuota,
    refreshProvider,
    refreshAll,
    retryLoad,
    setQuotaData,
    setLoading,
    setErrors,
  };
}
