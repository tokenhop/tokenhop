"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useNotificationStore } from "@/store/notificationStore";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  CONNECTIONS_PAGE_SIZE,
  filterQuotasByVisibility,
  getHiddenQuotaRows,
  shouldResetPage,
  sortVisibleConnections,
} from "./lib/quotaUtils.js";
import { getBulkActionTargets, getSoonestReset, summarizeQuotaHealth } from "./quotaSummary";
import { getConnectionLabel } from "./quotaLabels";
import QuotaSummaryCard from "./components/QuotaSummaryCard";
import QuotaFilters from "./components/QuotaFilters";
import QuotaAccountCard from "./components/QuotaAccountCard";
import Countdown from "./components/Countdown";
import { useQuotaData } from "./hooks/useQuotaData";
import { AUTO_PING_SETTINGS_KEYS, useQuotaActions } from "./hooks/useQuotaActions";
import Button from "@/shared/components/Button";
import EmptyState from "@/shared/components/EmptyState";
import { ErrorState } from "@/shared/components/StateViews";
import Pagination from "@/shared/components/Pagination";
import Toggle from "@/shared/components/Toggle";
import { ConfirmDialog, EditConnectionModal } from "@/shared/components";
import ResetCreditsDialog from "./components/ResetCreditsDialog";

function getCodexResetCreditCount(quota) {
  const value = quota?.raw?.resetCredits?.availableCount;
  const count = typeof value === "number" ? value : Number(value);
  return Number.isFinite(count) ? Math.max(0, count) : 0;
}

/** Signal quota: summary, filters, responsive account cards and full quota actions. */
export default function QuotaPageClient() {
  const [providerFilter, setProviderFilter] = useState("all");
  const [accountFilter, setAccountFilter] = useState("all");
  const [quotaSortMode, setQuotaSortMode] = useState("default");
  const [expiringFirst, setExpiringFirst] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(CONNECTIONS_PAGE_SIZE);
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlRefreshHandledRef = useRef(false);
  const countdownId = useId();
  const notify = useNotificationStore();
  const {
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
    refreshProvider,
    refreshAll,
    retryLoad,
    setQuotaData,
    setLoading,
    setErrors,
  } = useQuotaData({ page, setPage, pageSize, accountFilter, providerFilter, notify });
  const {
    deletingId,
    togglingId,
    resettingLimitId,
    resetConfirmState,
    setResetConfirmState,
    resetCreditsState,
    setResetCreditsState,
    deleteConfirmState,
    setDeleteConfirmState,
    deleteError,
    clearDeleteError,
    bulkConfirmState,
    setBulkConfirmState,
    showEditModal,
    setShowEditModal,
    selectedConnection,
    setSelectedConnection,
    proxyPools,
    autoPingMaps,
    quotaVisibility,
    bulkToggling,
    bulkSetActive,
    handleDeleteConnection,
    handleToggleConnectionActive,
    handleUpdateConnection,
    toggleAutoPing,
    handleResetCodexLimit,
    handleViewCodexResetCredits,
    handleHideQuota,
    handleShowQuota,
  } = useQuotaActions({
    fetchConnections,
    fetchQuota,
    retryLoad,
    page,
    setQuotaData,
    setLoading,
    setErrors,
    notify,
  });

  const handleEdit = useCallback(
    (connection) => {
      setSelectedConnection(connection);
      setShowEditModal(true);
    },
    [setSelectedConnection, setShowEditModal],
  );
  const handleConfirmDelete = useCallback(
    (id) => {
      clearDeleteError();
      setDeleteConfirmState(connections.find((c) => c.id === id) || { id });
    },
    [clearDeleteError, connections, setDeleteConfirmState],
  );
  const handleConfirmResetCodex = useCallback(
    (connection) => {
      setResetConfirmState({
        connection,
        count: getCodexResetCreditCount(quotaData[connection.id]),
      });
    },
    [quotaData, setResetConfirmState],
  );

  // Command-palette action: one forced refresh; success only when every account succeeds.
  const refreshRequested = searchParams?.get("refresh") === "1";
  useEffect(() => {
    if (!refreshRequested) {
      urlRefreshHandledRef.current = false;
      return;
    }
    if (urlRefreshHandledRef.current || !initialQuotaLoaded || connectionsLoading || refreshingAll)
      return;
    urlRefreshHandledRef.current = true;
    refreshAll(true).then((result) => {
      if (result?.failed === 0) notify.success("All quotas refreshed.");
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
  const handleProviderChange = useCallback(
    (newProvider) => {
      if (shouldResetPage(providerFilter, newProvider)) setPage(1);
      setProviderFilter(newProvider);
    },
    [providerFilter],
  );

  const handleAccountFilterChange = useCallback(
    (newFilter) => {
      if (shouldResetPage(accountFilter, newFilter)) setPage(1);
      setAccountFilter(newFilter);
    },
    [accountFilter],
  );

  return (
    <div className="flex flex-col gap-6" data-testid="quota-page">
      {/* Top action bar: Auto-refresh chip + Refresh all */}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="inline-flex h-11 items-center gap-2 rounded-xl border border-line bg-raised px-3 text-sm text-text">
          <span className="font-medium">Auto-refresh</span>
          {autoRefresh && (
            <Countdown to={nextRefreshAt} label="Next refresh in" countdownId={countdownId} />
          )}
          <Toggle
            size="sm"
            checked={autoRefresh}
            onChange={setAutoRefresh}
            aria-label="Toggle auto-refresh"
            aria-describedby={autoRefresh && nextRefreshAt ? countdownId : undefined}
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
        onTurnOnAvailable={() => {
          // bulkSetActive already toasted a Retry; no dialog here to hold the rejection.
          bulkSetActive(availableTargetIds, true).catch(() => {});
        }}
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
      {!connectionsLoading && connectionsError ? (
        <ErrorState
          message={connectionsError}
          onRetry={retryLoad}
          title="Could not load connections"
        />
      ) : !connectionsLoading && !hasEligible ? (
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
                codexResetCredits={resetCredits}
                canResetCodex={isCodex && resetCredits > 0}
                quotaSortLabel={isCodex && quotaSortMode !== "default"}
                onRefresh={refreshProvider}
                onEdit={handleEdit}
                onDelete={handleConfirmDelete}
                onToggle={handleToggleConnectionActive}
                onToggleAutoPing={toggleAutoPing}
                onResetCodex={handleConfirmResetCodex}
                onViewCodexCredits={handleViewCodexResetCredits}
                onHideQuota={handleHideQuota}
                onShowQuota={handleShowQuota}
              />
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {pagination.total > pageSize && (
        <Pagination
          currentPage={pagination.page}
          pageSize={pageSize}
          totalItems={pagination.total}
          onPageChange={setPage}
          onPageSizeChange={(nextSize) => {
            setPage(1);
            setPageSize(nextSize);
          }}
        />
      )}

      {/* Confirm: Delete connection */}
      <ConfirmDialog
        isOpen={Boolean(deleteConfirmState)}
        onClose={() => {
          if (deletingId) return;
          setDeleteConfirmState(null);
          clearDeleteError();
        }}
        onConfirm={async () => {
          if (!deleteConfirmState?.id) return;
          await handleDeleteConnection(deleteConfirmState.id);
        }}
        title="Delete connection?"
        message={`Delete ${getConnectionLabel(deleteConfirmState || {}) || "this connection"}? This cannot be undone.`}
        confirmText="Delete"
        variant="danger"
        loading={Boolean(deletingId)}
        error={deleteError}
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
