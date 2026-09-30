"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { refreshShellStatus } from "@/shared/hooks/useShellStatus";
import {
  QUOTA_CACHE_KEY,
  getQuotaCache,
  getQuotaVisibilityKey,
  reconcileConnectionsPage,
} from "@/app/(dashboard)/dashboard/quota/lib/quotaUtils.js";

export const AUTO_PING_SETTINGS_KEYS = {
  claude: "claudeAutoPing",
  codex: "codexAutoPing",
};

const JSON_HEADERS = { "Content-Type": "application/json" };

/** Throw `HTTP <status>: <server message>` for any non-OK response. */
async function assertOk(response, fallback) {
  if (response.ok) return response;
  const data = await response.json().catch(() => ({}));
  const message = data.message || data.error || data.code || response.statusText || fallback;
  throw new Error(`HTTP ${response.status}: ${message}`);
}

function withoutKey(id) {
  return (prev) => {
    const next = { ...prev };
    delete next[id];
    return next;
  };
}

function deleteQuotaCacheEntry(connectionId) {
  if (typeof window === "undefined") return;
  try {
    const cache = getQuotaCache();
    if (cache[connectionId]) {
      delete cache[connectionId];
      window.localStorage.setItem(QUOTA_CACHE_KEY, JSON.stringify(cache));
    }
  } catch (error) {
    console.error("Error deleting cache entry:", error);
  }
}

/**
 * useQuotaActions — per-account mutation/action state extracted from QuotaPageClient.
 * Owns busy ids, confirm-dialog state, edit-modal state, proxy pools, auto-ping
 * maps, quota visibility, and every per-account mutation.
 *
 * Failure contract: every request checks HTTP non-OK. Failures toast via
 * `notify.error(message, { action: { label: "Retry", onSelect } })`.
 * Delete, Codex reset and bulk toggle throw so ConfirmDialog stays open with
 * its inline error (delete also exposes `deleteError`). Once a mutation has
 * committed, a failed list refresh toasts a refresh-only retry and never
 * re-runs the mutation (provider API cannot recreate a deleted connection).
 */
export function useQuotaActions({
  fetchConnections,
  fetchQuota,
  invalidateQuota,
  retryLoad,
  page,
  // quotaData is part of the page contract; no action reads it today.
  setQuotaData,
  setLoading,
  setErrors,
  notify,
}) {
  const [deletingId, setDeletingId] = useState(null);
  const [togglingId, setTogglingId] = useState(null);
  const [resettingLimitId, setResettingLimitId] = useState(null);
  const [resetConfirmState, setResetConfirmState] = useState(null);
  const [resetCreditsState, setResetCreditsState] = useState(null);
  const [deleteConfirmState, setDeleteConfirmState] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const clearDeleteError = useCallback(() => setDeleteError(null), []);
  const [bulkConfirmState, setBulkConfirmState] = useState(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState(null);
  const [proxyPools, setProxyPools] = useState([]);
  const [autoPingMaps, setAutoPingMaps] = useState({ claude: {}, codex: {} });
  const [quotaVisibility, setQuotaVisibility] = useState({});
  const [bulkToggling, setBulkToggling] = useState(false);

  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  /** Error toast whose Retry swallows the rejection (inline state already shows it). */
  const failToast = useCallback((message, retry) => {
    notifyRef.current?.error(message, {
      action: {
        label: "Retry",
        onSelect: () => {
          Promise.resolve()
            .then(retry)
            .catch(() => {});
        },
      },
    });
  }, []);

  /** Refresh the list after a committed mutation; a failure never re-runs the mutation. */
  const refreshAfter = useCallback(
    async (what) => {
      try {
        await reconcileConnectionsPage(fetchConnections, page);
        refreshShellStatus();
      } catch (error) {
        console.error(`Error refreshing after ${what}:`, error);
        // retryLoad reloads list + quotas, same path as the page ErrorState Retry.
        failToast(`${what} saved, but the list refresh failed: ${error.message}`, retryLoad);
      }
    },
    [failToast, fetchConnections, page, retryLoad],
  );

  // Proxy pools for the edit modal.
  const loadProxyPools = useCallback(async () => {
    try {
      const res = await fetch("/api/proxy-pools?isActive=true", { cache: "no-store" });
      const data = await (await assertOk(res, "Failed to load proxy pools")).json();
      if (data?.proxyPools) setProxyPools(data.proxyPools);
    } catch (error) {
      failToast(`Proxy pools failed to load: ${error.message}`, loadProxyPools);
    }
  }, [failToast]);

  // Auto-ping maps + quota visibility.
  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const s = await (await assertOk(res, "Failed to load settings")).json();
      setAutoPingMaps({
        claude: s?.claudeAutoPing?.connections || {},
        codex: s?.codexAutoPing?.connections || {},
      });
      setQuotaVisibility(s?.quotaVisibility || {});
    } catch (error) {
      failToast(`Quota settings failed to load: ${error.message}`, loadSettings);
    }
  }, [failToast]);

  useEffect(() => {
    loadProxyPools();
    loadSettings();
  }, [loadProxyPools, loadSettings]);

  // Bulk active toggle; reconcile successful writes even if other targets fail.
  const bulkSetActive = useCallback(
    async (targetIds, isActive) => {
      if (!targetIds.length || bulkToggling) return;
      setBulkToggling(true);
      try {
        const results = await Promise.allSettled(
          targetIds.map((id) =>
            fetch(`/api/providers/${id}`, {
              method: "PUT",
              headers: JSON_HEADERS,
              body: JSON.stringify({ isActive }),
            }),
          ),
        );
        const succeeded = results.filter(
          (result) => result.status === "fulfilled" && result.value.ok,
        ).length;
        if (succeeded > 0) await refreshAfter("Bulk update");
        if (succeeded !== targetIds.length) {
          const error = new Error(
            `Failed to update ${targetIds.length - succeeded} of ${targetIds.length} connection${targetIds.length > 1 ? "s" : ""}`,
          );
          console.error("Error bulk toggling connections:", error);
          // PUT isActive is idempotent: retrying all targets is safe.
          failToast(`Bulk update failed: ${error.message}`, () =>
            bulkSetActive(targetIds, isActive),
          );
          throw error;
        }
      } finally {
        setBulkToggling(false);
      }
    },
    [bulkToggling, failToast, refreshAfter],
  );

  // Per-connection delete; throws so the dialog stays open with inline error.
  const handleDeleteConnection = useCallback(
    async (id) => {
      setDeletingId(id);
      setDeleteError(null);
      try {
        try {
          await assertOk(
            await fetch(`/api/providers/${id}`, { method: "DELETE" }),
            "Failed to delete connection",
          );
        } catch (error) {
          console.error("Error deleting connection:", error);
          setDeleteError(error.message);
          failToast(`Delete failed: ${error.message}`, () => handleDeleteConnection(id));
          throw error;
        }
        // In-flight quota fetches for the deleted account must not re-add it.
        invalidateQuota(id);
        setQuotaData(withoutKey(id));
        setLoading(withoutKey(id));
        setErrors(withoutKey(id));
        deleteQuotaCacheEntry(id);
        setDeleteConfirmState(null);
        await refreshAfter("Delete");
      } finally {
        setDeletingId(null);
      }
    },
    [failToast, invalidateQuota, refreshAfter, setErrors, setLoading, setQuotaData],
  );

  // Per-connection active toggle; toasts, never throws (card has no catcher).
  const handleToggleConnectionActive = useCallback(
    async (id, isActive) => {
      setTogglingId(id);
      try {
        const res = await fetch(`/api/providers/${id}`, {
          method: "PUT",
          headers: JSON_HEADERS,
          body: JSON.stringify({ isActive }),
        });
        await assertOk(res, "Failed to update connection");
      } catch (error) {
        console.error("Error updating connection status:", error);
        failToast(`Failed to ${isActive ? "enable" : "disable"} connection: ${error.message}`, () =>
          handleToggleConnectionActive(id, isActive),
        );
        setTogglingId(null);
        return;
      }
      await refreshAfter("Connection status");
      setTogglingId(null);
    },
    [failToast, refreshAfter],
  );

  // Edit connection save; returns an error string for the modal, null on success.
  const handleUpdateConnection = useCallback(
    async (formData) => {
      if (!selectedConnection?.id) return "No connection selected";
      const { id: connectionId, provider } = selectedConnection;
      try {
        const res = await fetch(`/api/providers/${connectionId}`, {
          method: "PUT",
          headers: JSON_HEADERS,
          body: JSON.stringify(formData),
        });
        await assertOk(res, "Failed to save connection");
      } catch (error) {
        console.error("Error saving connection:", error);
        // Modal stays open showing the returned message; the user resubmits there.
        notifyRef.current?.error(`Save failed: ${error.message}`);
        return error.message;
      }
      setShowEditModal(false);
      setSelectedConnection(null);
      await refreshAfter("Connection");
      await fetchQuota(connectionId, provider);
      return null;
    },
    [selectedConnection, fetchQuota, refreshAfter],
  );

  // Auto-ping toggle; optimistic, reverts + toasts on failure.
  const toggleAutoPing = useCallback(
    async (connectionId, provider, on) => {
      const settingsKey = AUTO_PING_SETTINGS_KEYS[provider];
      if (!settingsKey) return;

      const previous = autoPingMaps;
      const nextProviderMap = { ...(autoPingMaps[provider] || {}), [connectionId]: on };
      setAutoPingMaps({ ...autoPingMaps, [provider]: nextProviderMap });
      try {
        // Read-modify-write: a failed read must not PATCH over unknown settings.
        const read = await fetch("/api/settings", { cache: "no-store" });
        const s = await (await assertOk(read, "Failed to read settings")).json();
        const cfg = { ...(s?.[settingsKey] || {}), connections: nextProviderMap };
        const patch = await fetch("/api/settings", {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ [settingsKey]: cfg }),
        });
        await assertOk(patch, "Failed to save auto-ping");
      } catch (error) {
        console.error("Error toggling auto-ping:", error);
        setAutoPingMaps(previous);
        failToast(`Auto-ping ${on ? "enable" : "disable"} failed: ${error.message}`, () =>
          toggleAutoPing(connectionId, provider, on),
        );
      }
    },
    [autoPingMaps, failToast],
  );

  // Codex reset credit; throws so the confirm dialog stays open on failure.
  const handleResetCodexLimit = useCallback(
    async (connectionId, provider) => {
      if (provider !== "codex" || resettingLimitId) return;
      setResettingLimitId(connectionId);
      setErrors((prev) => ({ ...prev, [connectionId]: null }));
      try {
        try {
          const response = await fetch(`/api/usage/${connectionId}/codex-reset-credits`, {
            method: "POST",
          });
          await assertOk(response, "Failed to reset Codex limit");
        } catch (error) {
          console.error("Error resetting Codex limit:", error);
          setErrors((prev) => ({ ...prev, [connectionId]: error.message }));
          failToast(`Codex reset failed: ${error.message}`, () =>
            handleResetCodexLimit(connectionId, provider),
          );
          throw error;
        }
        setResetConfirmState(null);
        // Credit is spent; fetchQuota records its own row error, never re-POST.
        await fetchQuota(connectionId, provider);
      } finally {
        setResettingLimitId(null);
      }
    },
    [failToast, fetchQuota, resettingLimitId, setErrors],
  );

  // Codex reset credit expiry list; errors render inside the dialog.
  const handleViewCodexResetCredits = useCallback(async (connection) => {
    setResetCreditsState({ connection, loading: true, error: null, data: null });
    try {
      const response = await fetch(`/api/usage/${connection.id}/codex-reset-credits`, {
        cache: "no-store",
      });
      const result = await (await assertOk(response, "Failed to load Codex reset credits")).json();
      const credits = Array.isArray(result.credits) ? [...result.credits] : [];
      const time = (c) =>
        c.expiresAt ? new Date(c.expiresAt).getTime() : Number.POSITIVE_INFINITY;
      credits.sort((a, b) => time(a) - time(b));
      setResetCreditsState({
        connection,
        loading: false,
        error: null,
        data: { ...result, credits },
      });
    } catch (error) {
      setResetCreditsState({ connection, loading: false, error: error.message, data: null });
    }
  }, []);

  // Quota row visibility; optimistic, reverts + toasts on failure.
  const updateQuotaVisibility = useCallback(
    async (nextVisibility, previousVisibility) => {
      setQuotaVisibility(nextVisibility);
      try {
        const response = await fetch("/api/settings", {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ quotaVisibility: nextVisibility }),
        });
        await assertOk(response, "Failed to update quota visibility");
      } catch (error) {
        console.error("Error updating quota visibility:", error);
        setQuotaVisibility(previousVisibility);
        failToast(`Visibility update failed: ${error.message}`, () =>
          updateQuotaVisibility(nextVisibility, previousVisibility),
        );
      }
    },
    [failToast],
  );

  const setQuotaHidden = useCallback(
    (provider, quota, hide) => {
      const key = getQuotaVisibilityKey(quota);
      if (!provider || !key) return;
      const previous = quotaVisibility;
      const providerVisibility = previous[provider] || {};
      const hidden = new Set(providerVisibility.hidden || []);
      if (hide) hidden.add(key);
      else hidden.delete(key);
      const next = { ...previous, [provider]: { ...providerVisibility, hidden: [...hidden] } };
      updateQuotaVisibility(next, previous);
    },
    [quotaVisibility, updateQuotaVisibility],
  );

  const handleHideQuota = useCallback(
    (provider, quota) => setQuotaHidden(provider, quota, true),
    [setQuotaHidden],
  );
  const handleShowQuota = useCallback(
    (provider, quota) => setQuotaHidden(provider, quota, false),
    [setQuotaHidden],
  );

  return {
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
  };
}
