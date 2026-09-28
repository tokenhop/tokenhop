"use client";

import { useCallback, useEffect, useReducer, useState } from "react";
import { useNotificationStore } from "@/store/notificationStore";
import { SELECTION_INITIAL, selectionReducer, validateProxyUrl } from "@/shared/utils/proxyPools";
import {
  JSON_HEADERS,
  DEPLOY_ENDPOINTS,
  apiJson,
  mutate,
  testHealth,
  importEntries,
} from "./proxyPoolRequests";

/** Proxy pools page state and server actions; the page renders only. */
export default function useProxyPools() {
  const [pools, setPools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [selection, dispatchSelection] = useReducer(selectionReducer, SELECTION_INITIAL);
  const [testingId, setTestingId] = useState(null);
  const [formTesting, setFormTesting] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelNarrow, setPanelNarrow] = useState(false);
  const [editing, setEditing] = useState(null);
  const [formError, setFormError] = useState(null);
  const [formKey, setFormKey] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [deployModal, setDeployModal] = useState(null);
  const [deleteState, setDeleteState] = useState(null);
  const [healthResult, setHealthResult] = useState(null);
  const notifySuccess = useNotificationStore((s) => s.success);
  const notifyError = useNotificationStore((s) => s.error);
  const notifyWarning = useNotificationStore((s) => s.warning);

  const fetchPools = useCallback(async () => {
    setLoadError(null);
    try {
      const { res, data } = await apiJson("/api/proxy-pools?includeUsage=true", {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(data?.error || "Failed to load proxy pools");
      setPools(data.proxyPools || []);
    } catch (error) {
      setLoadError(error.message || "Failed to load proxy pools");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPools();
  }, [fetchPools]);

  useEffect(() => {
    dispatchSelection({ type: "prune", ids: pools.map((p) => p.id) });
  }, [pools]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 1350px)");
    const update = () => setPanelNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const openPanel = useCallback((pool) => {
    setEditing(pool);
    setFormError(null);
    setFormKey((k) => k + 1);
    setPanelOpen(true);
  }, []);
  const openAdd = useCallback(() => openPanel(null), [openPanel]);
  const openEdit = useCallback((pool) => openPanel(pool), [openPanel]);

  const closePanel = useCallback(() => {
    if (saving || formTesting) return;
    setPanelOpen(false);
    setEditing(null);
    setFormError(null);
  }, [saving, formTesting]);

  const handleSave = useCallback(
    async (values) => {
      setSaving(true);
      setFormError(null);
      try {
        const isEdit = Boolean(editing);
        const { res, data } = await apiJson(
          isEdit ? `/api/proxy-pools/${editing.id}` : "/api/proxy-pools",
          {
            method: isEdit ? "PUT" : "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify(values),
          },
        );
        if (!res.ok) {
          setFormError(data?.error || "Failed to save proxy pool");
          return;
        }
        await fetchPools();
        setPanelOpen(false);
        setEditing(null);
        notifySuccess(isEdit ? "Proxy pool updated" : "Proxy pool created");
      } catch {
        setFormError("Failed to save proxy pool");
      } finally {
        setSaving(false);
      }
    },
    [editing, fetchPools, notifySuccess],
  );

  const handleFormTest = useCallback(
    async (values) => {
      if (validateProxyUrl(values.proxyUrl)) return;
      if (editing) {
        setFormTesting(true);
        try {
          const { res, data } = await apiJson(`/api/proxy-pools/${editing.id}/test`, {
            method: "POST",
          });
          await fetchPools();
          if (!res.ok) {
            setFormError(data?.error || "Proxy test failed");
            notifyError(data?.error || "Proxy test failed");
            return;
          }
          notifySuccess(data?.ok ? "Proxy test passed" : "Proxy test failed");
        } catch {
          setFormError("Proxy test failed");
        } finally {
          setFormTesting(false);
        }
        return;
      }
      // Unsaved entries cannot hit the id-based test endpoint: create first.
      setFormError("Save the proxy first, then test it from the list.");
    },
    [editing, fetchPools, notifySuccess, notifyError],
  );

  const handleDelete = useCallback((pool) => {
    setDeleteState({ count: 1, id: pool.id, name: pool.name });
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteState) return;
    const ids = deleteState.count > 1 ? [...selection.selectedIds] : [deleteState.id];
    setBulkBusy(true);
    try {
      let ok = 0;
      let blocked = 0;
      let failed = 0;
      for (const id of ids) {
        const result = await mutate(id, "DELETE");
        if (result === "ok") ok += 1;
        else if (result === "blocked") blocked += 1;
        else failed += 1;
      }
      await fetchPools();
      dispatchSelection({ type: "clear" });
      setDeleteState(null);
      const parts = [`Deleted ${ok}`];
      if (blocked) parts.push(`${blocked} still bound`);
      if (failed) parts.push(`${failed} failed`);
      if (ok > 0) notifySuccess(parts.join(", "));
      else notifyWarning(parts.join(", "));
    } finally {
      setBulkBusy(false);
    }
  }, [deleteState, selection.selectedIds, fetchPools, notifySuccess, notifyWarning]);

  const handleTest = useCallback(
    async (pool) => {
      setTestingId(pool.id);
      try {
        const { res, data } = await apiJson(`/api/proxy-pools/${pool.id}/test`, {
          method: "POST",
        });
        await fetchPools();
        if (!res.ok) notifyError(data?.error || "Proxy test failed");
        else notifySuccess(data?.ok ? "Proxy test passed" : "Proxy test failed");
      } catch {
        notifyError("Proxy test failed");
      } finally {
        setTestingId(null);
      }
    },
    [fetchPools, notifySuccess, notifyError],
  );

  const handleToggleActive = useCallback(
    async (pool) => {
      const next = !pool.isActive;
      setPools((prev) => prev.map((p) => (p.id === pool.id ? { ...p, isActive: next } : p)));
      if ((await mutate(pool.id, "PUT", { isActive: next })) !== "ok") {
        setPools((prev) =>
          prev.map((p) => (p.id === pool.id ? { ...p, isActive: pool.isActive } : p)),
        );
        notifyError("Failed to update active state");
      }
    },
    [notifyError],
  );

  const bulkSetActive = useCallback(
    async (isActive) => {
      const targets = selection.selectedIds;
      if (targets.length === 0) return;
      setBulkBusy(true);
      try {
        let ok = 0;
        let failed = 0;
        for (const id of targets) {
          if ((await mutate(id, "PUT", { isActive })) === "ok") ok += 1;
          else failed += 1;
        }
        await fetchPools();
        notifySuccess(
          `${isActive ? "Activated" : "Deactivated"} ${ok}${failed ? `, ${failed} failed` : ""}`,
        );
      } finally {
        setBulkBusy(false);
      }
    },
    [selection.selectedIds, fetchPools, notifySuccess],
  );

  const handleHealthCheck = useCallback(async () => {
    const targets =
      selection.selectedIds.length > 0
        ? pools.filter((p) => selection.selectedIds.includes(p.id))
        : pools;
    if (targets.length === 0) return;
    dispatchSelection({ type: "check-start", total: targets.length });
    const { alive, deadIds } = await testHealth(targets, (current) =>
      dispatchSelection({ type: "check-progress", current }),
    );
    await fetchPools();
    dispatchSelection({ type: "check-done" });
    if (deadIds.length > 0) {
      setHealthResult({ alive, deadIds });
    } else {
      notifySuccess(`Health check done. Alive: ${alive}, Dead: 0`);
    }
  }, [selection.selectedIds, pools, fetchPools, notifySuccess]);

  const disableDead = useCallback(async () => {
    const deadIds = healthResult?.deadIds || [];
    setBulkBusy(true);
    try {
      for (const id of deadIds) {
        // Per-pool failure leaves that pool active; the summary still reports.
        await mutate(id, "PUT", { isActive: false });
      }
      await fetchPools();
      notifySuccess(`Disabled ${deadIds.length} dead proxies`);
    } finally {
      setBulkBusy(false);
      setHealthResult(null);
    }
  }, [healthResult, fetchPools, notifySuccess]);

  const handleImport = useCallback(
    async (entries) => {
      setImporting(true);
      try {
        const { created, skipped, failed } = await importEntries(entries, pools);
        await fetchPools();
        setImportOpen(false);
        notifySuccess(
          `Batch import completed: Created ${created}, Skipped ${skipped}, Failed ${failed}`,
        );
      } finally {
        setImporting(false);
      }
    },
    [pools, fetchPools, notifySuccess],
  );

  const handleDeploy = useCallback(
    async (form) => {
      setDeploying(true);
      try {
        const { res, data } = await apiJson(
          DEPLOY_ENDPOINTS[deployModal] ?? DEPLOY_ENDPOINTS.deno,
          {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify(form),
          },
        );
        if (res.ok) {
          await fetchPools();
          setDeployModal(null);
          notifySuccess(`Deployed: ${data.deployUrl}`);
        } else {
          notifyError(data?.error || "Deploy failed");
        }
      } catch {
        notifyError("Deploy failed");
      } finally {
        setDeploying(false);
      }
    },
    [deployModal, fetchPools, notifySuccess, notifyError],
  );

  const allSelected = pools.length > 0 && selection.selectedIds.length === pools.length;
  const someSelected =
    selection.selectedIds.length > 0 && selection.selectedIds.length < pools.length;

  const toggleSelect = useCallback((id) => dispatchSelection({ type: "toggle", id }), []);
  const toggleSelectAll = useCallback(
    () =>
      dispatchSelection({
        type: allSelected ? "clear" : "select-all",
        ids: pools.map((p) => p.id),
      }),
    [allSelected, pools],
  );
  const clearSelection = useCallback(() => dispatchSelection({ type: "clear" }), []);
  const requestBulkDelete = useCallback(
    () => setDeleteState({ count: selection.selectedIds.length, ids: selection.selectedIds }),
    [selection.selectedIds],
  );

  return {
    pools,
    loading,
    loadError,
    selection,
    testingId,
    formTesting,
    bulkBusy,
    saving,
    importing,
    deploying,
    panelOpen,
    panelNarrow,
    editing,
    formError,
    formKey,
    importOpen,
    deployModal,
    deleteState,
    healthResult,
    allSelected,
    someSelected,
    setImportOpen,
    setDeployModal,
    setDeleteState,
    setHealthResult,
    openAdd,
    openEdit,
    closePanel,
    handleSave,
    handleFormTest,
    handleDelete,
    confirmDelete,
    handleTest,
    handleToggleActive,
    bulkSetActive,
    handleHealthCheck,
    disableDead,
    handleImport,
    handleDeploy,
    toggleSelect,
    toggleSelectAll,
    clearSelection,
    requestBulkDelete,
  };
}
