"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useNotificationStore } from "@/store/notificationStore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AUTO_REFRESH_STORAGE_KEY,
  CLAUDE_REFRESH_INTERVAL_MS,
  CONNECTIONS_PAGE_SIZE,
  REFRESH_INTERVAL_MS,
  buildLoadingState,
  filterQuotaStateByConnections,
  filterQuotasByVisibility,
  getHiddenQuotaRows,
  getPaginationPageValue,
  getProviderOptions,
  getQuotaCache,
  getQuotaVisibilityKey,
  getSafePagination,
  getSafeTotals,
  parseQuotaData,
  reconcileConnectionsPage,
  setQuotaCache,
  shouldResetPage,
  sortVisibleConnections,
} from "@/app/(dashboard)/dashboard/quota/lib/quotaUtils.js";
import { getBulkActionTargets, getSoonestReset, summarizeQuotaHealth } from "./quotaSummary";
import { getConnectionLabel } from "./quotaLabels";
import QuotaSummaryCard from "./components/QuotaSummaryCard";
import QuotaFilters from "./components/QuotaFilters";
import QuotaAccountCard from "./components/QuotaAccountCard";
import Button from "@/shared/components/Button";
import EmptyState from "@/shared/components/EmptyState";
import Pagination from "@/shared/components/Pagination";
import Toggle from "@/shared/components/Toggle";
import { ConfirmDialog, EditConnectionModal } from "@/shared/components";
import ResetCreditsDialog from "@/app/(dashboard)/dashboard/quota/components/ResetCreditsDialog";

const AUTO_PING_SETTINGS_KEYS = {
  claude: "claudeAutoPing",
  codex: "codexAutoPing",
};

const AUTO_PING_TOOLTIPS = {
  claude:
    "When your 5h quota runs out, auto-sends a request the moment it resets so a new window starts right away.",
  codex:
    "Auto-starts the next 5h Codex window after reset by sending a tiny gpt-5.5 request. Consumes a small amount of quota.",
};

function getCodexResetCreditCount(quota) {
  const value = quota?.raw?.resetCredits?.availableCount;
  const count = typeof value === "number" ? value : Number(value);
  return Number.isFinite(count) ? Math.max(0, count) : 0;
}

/**
 * Signal Quota page client:
 * Runway summary (healthy / low / empty), filters (provider + status + expiring first + bulk),
 * responsive 3/2/1 card grid, and full parity with existing quota tracking.
 */
export default function QuotaPageClient() {
  const [connections, setConnections] = useState([]);
  const [quotaData, setQuotaData] = useState({});
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [autoPingMaps, setAutoPingMaps] = useState({ claude: {}, codex: {} });
  const [hasHydratedAutoRefresh, setHasHydratedAutoRefresh] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [countdown, setCountdown] = useState(60);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [initialQuotaLoaded, setInitialQuotaLoaded] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlRefreshHandledRef = useRef(false);
  const notify = useNotificationStore();

  // Per-account action state
  const [deletingId, setDeletingId] = useState(null);
  const [togglingId, setTogglingId] = useState(null);
  const [resettingLimitId, setResettingLimitId] = useState(null);
  const [resetConfirmState, setResetConfirmState] = useState(null);
  const [resetCreditsState, setResetCreditsState] = useState(null);
  const [deleteConfirmState, setDeleteConfirmState] = useState(null);
  const [bulkConfirmState, setBulkConfirmState] = useState(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState(null);
  const [proxyPools, setProxyPools] = useState([]);

  // Filters & pagination
  const [providerFilter, setProviderFilter] = useState("all");
  const [providerOptions, setProviderOptions] = useState([]);
  const [accountFilter, setAccountFilter] = useState("all");
  const [quotaSortMode, setQuotaSortMode] = useState("default");
  const [quotaVisibility, setQuotaVisibility] = useState({});
  const [expiringFirst, setExpiringFirst] = useState(false);
  const [bulkToggling, setBulkToggling] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(CONNECTIONS_PAGE_SIZE);
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: CONNECTIONS_PAGE_SIZE,
    total: 0,
    totalPages: 1,
  });
  const [totals, setTotals] = useState({
    eligibleConnections: 0,
    providerFilteredConnections: 0,
  });

  const intervalRef = useRef(null);
  const countdownRef = useRef(null);
  const tickCountRef = useRef(0);

  // Fetch connections list from the backend
  const fetchConnections = useCallback(
    async (targetPage = page) => {
      try {
        const params = new URLSearchParams({
          page: String(targetPage),
          pageSize: String(pageSize),
          accountStatus: accountFilter,
          sort: "priority",
        });

        if (providerFilter !== "all") {
          params.set("provider", providerFilter);
        }

        const response = await fetch(`/api/providers/client?${params.toString()}`);
        if (!response.ok) throw new Error("Failed to fetch connections");

        const data = await response.json();
        const connectionList = data.connections || [];
        const nextPagination = getSafePagination(data.pagination, pageSize);
        const nextTotals = getSafeTotals(data.totals, connectionList.length);

        setConnections(connectionList);
        setProviderOptions(getProviderOptions(data.providerOptions));
        setPagination(nextPagination);
        setTotals(nextTotals);
        setPage(getPaginationPageValue(data.pagination, targetPage));
        return connectionList;
      } catch (error) {
        console.error("Error fetching connections:", error);
        setConnections([]);
        setProviderOptions([]);
        setPagination({ page: 1, pageSize, total: 0, totalPages: 1 });
        setTotals({ eligibleConnections: 0, providerFilteredConnections: 0 });
        return [];
      }
    },
    [accountFilter, page, pageSize, providerFilter],
  );

  // Fetch quota for a specific connection
  const fetchQuota = useCallback(async (connectionId, provider, { force = false } = {}) => {
    setLoading((prev) => ({ ...prev, [connectionId]: true }));
    setErrors((prev) => ({ ...prev, [connectionId]: null }));

    try {
      const url = `/api/usage/${connectionId}${force ? "?force=1" : ""}`;
      const response = await fetch(url);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData.error || response.statusText;

        if (response.status === 404) return;
        if (response.status === 401) {
          const quotaEntry = { quotas: [], message: errorMsg };
          setQuotaData((prev) => ({ ...prev, [connectionId]: quotaEntry }));
          setQuotaCache(connectionId, quotaEntry);
          return;
        }

        throw new Error(`HTTP ${response.status}: ${errorMsg}`);
      }

      const data = await response.json();
      const parsedQuotas = parseQuotaData(provider, data);

      const quotaEntry = {
        quotas: parsedQuotas,
        plan: data.plan || null,
        message: data.message || null,
        raw: data,
      };

      setQuotaData((prev) => ({ ...prev, [connectionId]: quotaEntry }));
      setQuotaCache(connectionId, quotaEntry);
    } catch (error) {
      console.error(`[Quota] Error fetching quota for ${provider} (${connectionId}):`, error);
      setErrors((prev) => ({
        ...prev,
        [connectionId]: error.message || "Failed to fetch quota",
      }));
    } finally {
      setLoading((prev) => ({ ...prev, [connectionId]: false }));
    }
  }, []);

  const refreshProvider = useCallback(
    async (connectionId, provider) => {
      await fetchQuota(connectionId, provider, { force: true });
    },
    [fetchQuota],
  );

  const refreshAll = useCallback(
    async (force = false) => {
      if (refreshingAll) return;
      setRefreshingAll(true);
      setCountdown(60);

      tickCountRef.current += 1;
      const tick = tickCountRef.current;
      const claudeEvery = Math.round(CLAUDE_REFRESH_INTERVAL_MS / REFRESH_INTERVAL_MS);
      const shouldFetch = (conn) => force || conn.provider !== "claude" || tick % claudeEvery === 0;

      try {
        const visibleConnections = await fetchConnections(page);
        setLoading(buildLoadingState(visibleConnections));
        setErrors((prev) => filterQuotaStateByConnections(prev, visibleConnections));
        setQuotaData((prev) => filterQuotaStateByConnections(prev, visibleConnections));

        await Promise.all(
          visibleConnections.filter(shouldFetch).map((conn) => fetchQuota(conn.id, conn.provider)),
        );
      } catch (error) {
        console.error("Error refreshing quota:", error);
      } finally {
        setRefreshingAll(false);
      }
    },
    [refreshingAll, fetchConnections, fetchQuota, page],
  );

  // Bulk active toggle
  const bulkSetActive = useCallback(
    async (targetIds, isActive) => {
      if (!targetIds.length || bulkToggling) return;
      setBulkToggling(true);
      try {
        await Promise.all(
          targetIds.map((id) =>
            fetch(`/api/providers/${id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ isActive }),
            }),
          ),
        );
        await reconcileConnectionsPage(fetchConnections, page);
      } catch (error) {
        console.error("Error bulk toggling connections:", error);
      } finally {
        setBulkToggling(false);
      }
    },
    [bulkToggling, fetchConnections, page],
  );

  // Per-connection delete
  const handleDeleteConnection = useCallback(
    async (id) => {
      setDeletingId(id);
      try {
        const res = await fetch(`/api/providers/${id}`, { method: "DELETE" });
        if (res.ok) {
          setQuotaData((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          setLoading((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          setErrors((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });

          if (typeof window !== "undefined") {
            try {
              const cache = getQuotaCache();
              if (cache[id]) {
                delete cache[id];
                window.localStorage.setItem("quotaCacheData", JSON.stringify(cache));
              }
            } catch (e) {
              console.error("Error deleting cache entry:", e);
            }
          }

          await reconcileConnectionsPage(fetchConnections, page);
        }
      } catch (error) {
        console.error("Error deleting connection:", error);
      } finally {
        setDeletingId(null);
        setDeleteConfirmState(null);
      }
    },
    [fetchConnections, page],
  );

  // Per-connection active toggle
  const handleToggleConnectionActive = useCallback(
    async (id, isActive) => {
      setTogglingId(id);
      try {
        const res = await fetch(`/api/providers/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive }),
        });
        if (res.ok) {
          await reconcileConnectionsPage(fetchConnections, page);
        }
      } catch (error) {
        console.error("Error updating connection status:", error);
      } finally {
        setTogglingId(null);
      }
    },
    [fetchConnections, page],
  );

  // Edit connection save
  const handleUpdateConnection = useCallback(
    async (formData) => {
      if (!selectedConnection?.id) return;
      const connectionId = selectedConnection.id;
      const provider = selectedConnection.provider;
      try {
        const res = await fetch(`/api/providers/${connectionId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formData),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          return data.error || "Failed to save connection";
        }
        await fetchConnections();
        setShowEditModal(false);
        setSelectedConnection(null);
        await fetchQuota(connectionId, provider);
        return null;
      } catch (error) {
        console.error("Error saving connection:", error);
        return "Failed to save connection";
      }
    },
    [selectedConnection, fetchConnections, fetchQuota],
  );

  // Auto-ping toggle
  const toggleAutoPing = useCallback(
    async (connectionId, provider, on) => {
      const settingsKey = AUTO_PING_SETTINGS_KEYS[provider];
      if (!settingsKey) return;

      const previous = autoPingMaps;
      const nextProviderMap = { ...(autoPingMaps[provider] || {}), [connectionId]: on };
      const nextMaps = { ...autoPingMaps, [provider]: nextProviderMap };
      setAutoPingMaps(nextMaps);
      try {
        const r = await fetch("/api/settings", { cache: "no-store" });
        const s = r.ok ? await r.json() : {};
        const cfg = { ...(s[settingsKey] || {}), connections: nextProviderMap };
        await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [settingsKey]: cfg }),
        });
      } catch {
        setAutoPingMaps(previous);
      }
    },
    [autoPingMaps],
  );

  // Codex reset credit
  const handleResetCodexLimit = useCallback(
    async (connectionId, provider) => {
      if (provider !== "codex" || resettingLimitId) return;
      setResettingLimitId(connectionId);
      setErrors((prev) => ({ ...prev, [connectionId]: null }));

      try {
        const response = await fetch(`/api/usage/${connectionId}/codex-reset-credits`, {
          method: "POST",
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            result.message || result.error || result.code || "Failed to reset Codex limit",
          );
        }
        await fetchQuota(connectionId, provider);
      } catch (error) {
        setErrors((prev) => ({
          ...prev,
          [connectionId]: error.message || "Failed to reset Codex limit",
        }));
      } finally {
        setResettingLimitId(null);
        setResetConfirmState(null);
      }
    },
    [fetchQuota, resettingLimitId],
  );

  const handleViewCodexResetCredits = useCallback(async (connection) => {
    setResetCreditsState({ connection, loading: true, error: null, data: null });
    try {
      const response = await fetch(`/api/usage/${connection.id}/codex-reset-credits`, {
        cache: "no-store",
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || result.message || "Failed to load Codex reset credits");
      }
      const credits = Array.isArray(result.credits) ? [...result.credits] : [];
      credits.sort((a, b) => {
        const aTime = a.expiresAt ? new Date(a.expiresAt).getTime() : Number.POSITIVE_INFINITY;
        const bTime = b.expiresAt ? new Date(b.expiresAt).getTime() : Number.POSITIVE_INFINITY;
        return aTime - bTime;
      });
      setResetCreditsState({
        connection,
        loading: false,
        error: null,
        data: { ...result, credits },
      });
    } catch (error) {
      setResetCreditsState({
        connection,
        loading: false,
        error: error.message || "Failed to load Codex reset credits",
        data: null,
      });
    }
  }, []);

  // Quota row visibility
  const updateQuotaVisibility = useCallback(async (nextVisibility, previousVisibility) => {
    setQuotaVisibility(nextVisibility);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quotaVisibility: nextVisibility }),
      });
      if (!response.ok) throw new Error("Failed to update quota visibility");
    } catch (error) {
      console.error("Error updating quota visibility:", error);
      setQuotaVisibility(previousVisibility);
    }
  }, []);

  const handleHideQuota = useCallback(
    (provider, quota) => {
      const key = getQuotaVisibilityKey(quota);
      if (!provider || !key) return;
      const previous = quotaVisibility;
      const providerVisibility = previous[provider] || {};
      const hidden = new Set(providerVisibility.hidden || []);
      hidden.add(key);
      const next = { ...previous, [provider]: { ...providerVisibility, hidden: [...hidden] } };
      updateQuotaVisibility(next, previous);
    },
    [quotaVisibility, updateQuotaVisibility],
  );

  const handleShowQuota = useCallback(
    (provider, quota) => {
      const key = getQuotaVisibilityKey(quota);
      if (!provider || !key) return;
      const previous = quotaVisibility;
      const providerVisibility = previous[provider] || {};
      const hidden = new Set(providerVisibility.hidden || []);
      hidden.delete(key);
      const next = { ...previous, [provider]: { ...providerVisibility, hidden: [...hidden] } };
      updateQuotaVisibility(next, previous);
    },
    [quotaVisibility, updateQuotaVisibility],
  );

  // Initial load
  useEffect(() => {
    let cancelled = false;
    async function init() {
      setConnectionsLoading(true);
      const list = await fetchConnections(page);
      if (cancelled) return;
      setConnectionsLoading(false);

      setLoading(buildLoadingState(list));
      setErrors((prev) => filterQuotaStateByConnections(prev, list));
      setQuotaData((prev) => filterQuotaStateByConnections(prev, list));

      await Promise.all(list.map((c) => fetchQuota(c.id, c.provider)));
      if (!cancelled) setInitialQuotaLoaded(true);
    }
    init();
    return () => {
      cancelled = true;
    };
  }, [fetchConnections, fetchQuota, page]);

  // Command-palette action: /dashboard/quota?refresh=1 runs one forced
  // refresh after initial load. The page's own per-row errors stay inline;
  // the toast confirms only that a refresh ran, per row-by-row honesty.
  const refreshRequested = searchParams?.get("refresh") === "1";
  useEffect(() => {
    if (!refreshRequested) {
      urlRefreshHandledRef.current = false;
      return;
    }
    if (urlRefreshHandledRef.current || !initialQuotaLoaded || connectionsLoading || refreshingAll)
      return;
    urlRefreshHandledRef.current = true;
    refreshAll(true).finally(() => {
      notify.info("Quota refresh finished. Failed accounts show their own error inline.");
    });
    const params = new URLSearchParams(searchParams.toString());
    params.delete("refresh");
    const query = params.toString();
    router.replace(query ? `/dashboard/quota?${query}` : "/dashboard/quota", { scroll: false });
  }, [
    refreshRequested,
    initialQuotaLoaded,
    connectionsLoading,
    refreshingAll,
    refreshAll,
    router,
    searchParams,
    notify,
  ]);

  // Load proxy pools for edit modal
  useEffect(() => {
    let cancelled = false;
    fetch("/api/proxy-pools?isActive=true", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data?.proxyPools) setProxyPools(data.proxyPools);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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

  // Load auto-ping and quotaVisibility settings
  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : {}))
      .then((s) => {
        setAutoPingMaps({
          claude: s?.claudeAutoPing?.connections || {},
          codex: s?.codexAutoPing?.connections || {},
        });
        setQuotaVisibility(s?.quotaVisibility || {});
      })
      .catch(() => {});
  }, []);

  // Auto-refresh interval with tab visibility detection
  useEffect(() => {
    if (!hasHydratedAutoRefresh || !autoRefresh) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
      return;
    }

    intervalRef.current = setInterval(() => {
      refreshAll();
    }, REFRESH_INTERVAL_MS);

    countdownRef.current = setInterval(() => {
      setCountdown((prev) => (prev <= 1 ? 60 : prev - 1));
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [autoRefresh, hasHydratedAutoRefresh, refreshAll]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) {
        if (intervalRef.current) clearInterval(intervalRef.current);
        if (countdownRef.current) clearInterval(countdownRef.current);
      } else if (autoRefresh && hasHydratedAutoRefresh) {
        intervalRef.current = setInterval(() => refreshAll(), REFRESH_INTERVAL_MS);
        countdownRef.current = setInterval(() => {
          setCountdown((prev) => (prev <= 1 ? 60 : prev - 1));
        }, 1000);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [autoRefresh, hasHydratedAutoRefresh, refreshAll]);

  // Sorted connections list
  const sortedConnections = useMemo(
    () =>
      sortVisibleConnections(connections, quotaData, expiringFirst, providerFilter, quotaSortMode),
    [connections, quotaData, expiringFirst, providerFilter, quotaSortMode],
  );

  // Runway summary
  const healthSummary = useMemo(() => {
    const list = sortedConnections.map((c) => ({
      id: c.id,
      quotas: quotaData[c.id]?.quotas || [],
    }));
    return summarizeQuotaHealth(list);
  }, [sortedConnections, quotaData]);

  // Next reset account
  const nextReset = useMemo(() => {
    const connectionItems = sortedConnections.map((c) => ({
      id: c.id,
      label: getConnectionLabel(c) || c.provider,
    }));
    return getSoonestReset(connectionItems, quotaData);
  }, [sortedConnections, quotaData]);

  // Bulk action target calculation
  const emptyTargetIds = useMemo(
    () => getBulkActionTargets(sortedConnections, quotaData, "off"),
    [sortedConnections, quotaData],
  );

  const availableTargetIds = useMemo(
    () => getBulkActionTargets(sortedConnections, quotaData, "on"),
    [sortedConnections, quotaData],
  );

  const hasEligible = totals.eligibleConnections > 0;
  const hasVisible = sortedConnections.length > 0;

  // Filter change handlers
  const handleProviderChange = (newProvider) => {
    if (shouldResetPage(providerFilter, newProvider)) setPage(1);
    setProviderFilter(newProvider);
  };

  const handleAccountFilterChange = (newFilter) => {
    if (shouldResetPage(accountFilter, newFilter)) setPage(1);
    setAccountFilter(newFilter);
  };

  return (
    <div className="flex flex-col gap-6" data-testid="quota-page">
      {/* Top action bar: Auto-refresh chip + Refresh all */}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="inline-flex h-11 items-center gap-2 rounded-xl border border-line bg-raised px-3 text-sm text-text">
          <span className="font-medium">Auto-refresh</span>
          {autoRefresh && (
            <span className="font-mono text-xs text-muted tabular-nums">({countdown}s)</span>
          )}
          <Toggle
            size="sm"
            checked={autoRefresh}
            onChange={setAutoRefresh}
            aria-label="Toggle auto-refresh"
          />
        </div>

        <Button
          variant="secondary"
          icon="refresh"
          loading={refreshingAll}
          onClick={() => refreshAll(true)}
          title="Refresh all quotas"
        >
          Refresh all
        </Button>
      </div>

      {/* Runway summary card */}
      <QuotaSummaryCard
        summary={healthSummary}
        nextReset={nextReset}
        loading={connectionsLoading}
      />

      {/* Filters bar */}
      <QuotaFilters
        providerFilter={providerFilter}
        onProviderChange={handleProviderChange}
        providerOptions={providerOptions}
        accountFilter={accountFilter}
        onAccountFilterChange={handleAccountFilterChange}
        quotaSortMode={quotaSortMode}
        onQuotaSortModeChange={setQuotaSortMode}
        expiringFirst={expiringFirst}
        onToggleExpiringFirst={() => setExpiringFirst((prev) => !prev)}
        onTurnOffEmpty={() => {
          if (emptyTargetIds.length === 0) return;
          setBulkConfirmState({
            action: "off",
            ids: emptyTargetIds,
            title: "Turn off empty accounts?",
            message: `This will disable ${emptyTargetIds.length} account${emptyTargetIds.length > 1 ? "s" : ""} on this page that have depleted quota.`,
          });
        }}
        onTurnOnAvailable={() => bulkSetActive(availableTargetIds, true)}
        bulkBusy={bulkToggling}
        emptyCount={emptyTargetIds.length}
        availableCount={availableTargetIds.length}
      />

      {/* Expiring first notice */}
      {expiringFirst && (
        <div
          role="status"
          className="rounded-xl border border-warn/30 bg-warn-bg px-4 py-2.5 text-xs text-warn"
        >
          Expiring-first currently reorders accounts inside the current page. Cross-page ordering
          still follows backend pagination.
        </div>
      )}

      {/* Content states */}
      {!connectionsLoading && !hasEligible ? (
        <EmptyState
          icon="cloud_off"
          title="No providers connected"
          body="Connect to providers with OAuth or API keys to track your quota limits and runway."
          action={
            <Button href="/dashboard/providers" variant="primary" icon="dns">
              Go to Providers
            </Button>
          }
        />
      ) : !connectionsLoading && !hasVisible ? (
        <EmptyState
          icon="filter_alt_off"
          title="No accounts match current filters"
          body={
            providerFilter === "all"
              ? "Try changing the account status filter to see more accounts."
              : `No matching accounts found for ${providerFilter}. Try selecting All providers.`
          }
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setProviderFilter("all");
                setAccountFilter("all");
                setPage(1);
              }}
            >
              Reset filters
            </Button>
          }
        />
      ) : (
        /* Responsive card grid: 3 cols at 1440, 2 at 1024, 1 at 390 */
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {sortedConnections.map((conn) => {
            const quota = quotaData[conn.id];
            const rawQuotas = quota?.quotas || [];
            const visibleQuotas = filterQuotasByVisibility(
              conn.provider,
              rawQuotas,
              quotaVisibility,
            );
            const hiddenRows = getHiddenQuotaRows(conn.provider, rawQuotas, quotaVisibility);
            const isCodex = conn.provider === "codex";
            const resetCredits = getCodexResetCreditCount(quota);
            const isResetting = resettingLimitId === conn.id;
            const rowBusy = deletingId === conn.id || togglingId === conn.id || isResetting;

            return (
              <QuotaAccountCard
                key={conn.id}
                connection={conn}
                quotas={visibleQuotas}
                hiddenQuotaRows={hiddenRows}
                loading={loading[conn.id]}
                error={errors[conn.id]}
                message={quota?.message}
                rowBusy={rowBusy}
                autoPing={autoPingMaps[conn.provider]?.[conn.id] === true}
                canAutoPing={Boolean(
                  AUTO_PING_SETTINGS_KEYS[conn.provider] && conn.authType === "oauth",
                )}
                autoPingHint={AUTO_PING_TOOLTIPS[conn.provider]}
                codexResetCredits={resetCredits}
                canResetCodex={isCodex && resetCredits > 0}
                quotaSortLabel={isCodex && quotaSortMode !== "default"}
                onRefresh={refreshProvider}
                onEdit={(c) => {
                  setSelectedConnection(c);
                  setShowEditModal(true);
                }}
                onDelete={(id) => {
                  const target = sortedConnections.find((c) => c.id === id);
                  setDeleteConfirmState(target || { id });
                }}
                onToggle={handleToggleConnectionActive}
                onToggleAutoPing={toggleAutoPing}
                onResetCodex={(c) => setResetConfirmState({ connection: c, count: resetCredits })}
                onViewCodexCredits={handleViewCodexResetCredits}
                onHideQuota={handleHideQuota}
                onShowQuota={handleShowQuota}
              />
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {pagination.total > 0 && (
        <Pagination
          currentPage={pagination.page}
          pageSize={pageSize}
          totalItems={pagination.total}
          onPageChange={(nextPage) => {
            setPage(nextPage);
            fetchConnections(nextPage);
          }}
          onPageSizeChange={(nextSize) => {
            setPage(1);
            setPageSize(nextSize);
          }}
        />
      )}

      {/* Confirm: Delete connection */}
      <ConfirmDialog
        isOpen={Boolean(deleteConfirmState)}
        onClose={() => setDeleteConfirmState(null)}
        onConfirm={async () => {
          if (!deleteConfirmState?.id) return;
          await handleDeleteConnection(deleteConfirmState.id);
        }}
        title="Delete connection?"
        message={`Delete ${getConnectionLabel(deleteConfirmState || {}) || "this connection"}? This cannot be undone.`}
        confirmText="Delete"
        variant="danger"
        loading={Boolean(deletingId)}
      />

      {/* Confirm: Turn off empty accounts */}
      <ConfirmDialog
        isOpen={Boolean(bulkConfirmState)}
        onClose={() => setBulkConfirmState(null)}
        onConfirm={async () => {
          if (!bulkConfirmState?.ids?.length) return;
          await bulkSetActive(bulkConfirmState.ids, false);
          setBulkConfirmState(null);
        }}
        title={bulkConfirmState?.title || "Turn off empty accounts?"}
        message={bulkConfirmState?.message}
        confirmText="Turn off empty"
        variant="danger"
        loading={bulkToggling}
      />

      {/* Confirm: Codex reset credit */}
      <ConfirmDialog
        isOpen={Boolean(resetConfirmState)}
        onClose={() => {
          if (!resettingLimitId) setResetConfirmState(null);
        }}
        onConfirm={async () => {
          const c = resetConfirmState?.connection;
          if (!c) return;
          await handleResetCodexLimit(c.id, c.provider);
        }}
        title="Reset Codex limit?"
        message={`Use 1 Codex reset credit for ${getConnectionLabel(resetConfirmState?.connection || {}) || "this account"}. This cannot be undone. Remaining credits: ${resetConfirmState?.count ?? 0}.`}
        confirmText="Reset limit"
        variant="danger"
        loading={Boolean(resettingLimitId)}
      />

      {/* Codex reset credits expiry dialog */}
      <ResetCreditsDialog state={resetCreditsState} onClose={() => setResetCreditsState(null)} />

      {/* Edit connection modal */}
      <EditConnectionModal
        isOpen={showEditModal}
        connection={selectedConnection}
        proxyPools={proxyPools}
        onSave={handleUpdateConnection}
        onClose={() => {
          setShowEditModal(false);
          setSelectedConnection(null);
        }}
      />
    </div>
  );
}
