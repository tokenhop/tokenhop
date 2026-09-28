"use client";

import { useCallback, useEffect, useReducer, useState } from "react";
import Button from "@/shared/components/Button";
import Card from "@/shared/components/Card";
import Drawer from "@/shared/components/Drawer";
import Modal from "@/shared/components/Modal";
import { Skeleton } from "@/shared/components/Loading";
import { useNotificationStore } from "@/store/notificationStore";
import { SELECTION_INITIAL, selectionReducer, validateProxyUrl } from "@/shared/utils/proxyPools";
import RelayCards from "./components/RelayCards";
import PoolList from "./components/PoolList";
import SelectionBar from "./components/SelectionBar";
import { BatchImportModal, DeleteConfirm, ProxyForm } from "./components/ProxyForm";
import {
  CloudflareDeployModal,
  DenoDeployModal,
  VercelDeployModal,
} from "./components/RelayModals";

async function apiJson(path, options) {
  const res = await fetch(path, options);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { res, data };
}

/** Signal redesign of the Proxy pools page (board `ProxyPools.dc.html`). */
export default function ProxyPoolsPage() {
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
  const notify = useNotificationStore();

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

  const openAdd = useCallback(() => {
    setEditing(null);
    setFormError(null);
    setFormKey((k) => k + 1);
    setPanelOpen(true);
  }, []);

  const openEdit = useCallback((pool) => {
    setEditing(pool);
    setFormError(null);
    setFormKey((k) => k + 1);
    setPanelOpen(true);
  }, []);

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
            headers: { "Content-Type": "application/json" },
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
        notify.success(isEdit ? "Proxy pool updated" : "Proxy pool created");
      } catch {
        setFormError("Failed to save proxy pool");
      } finally {
        setSaving(false);
      }
    },
    [editing, fetchPools, notify],
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
            notify.error(data?.error || "Proxy test failed");
            return;
          }
          notify.success(data?.ok ? "Proxy test passed" : "Proxy test failed");
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
    [editing, fetchPools, notify],
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
        try {
          const { res } = await apiJson(`/api/proxy-pools/${id}`, { method: "DELETE" });
          if (res.ok) ok += 1;
          else if (res.status === 409) blocked += 1;
          else failed += 1;
        } catch {
          failed += 1;
        }
      }
      await fetchPools();
      dispatchSelection({ type: "clear" });
      setDeleteState(null);
      const parts = [`Deleted ${ok}`];
      if (blocked) parts.push(`${blocked} still bound`);
      if (failed) parts.push(`${failed} failed`);
      if (ok > 0) notify.success(parts.join(", "));
      else notify.warning(parts.join(", "));
    } finally {
      setBulkBusy(false);
    }
  }, [deleteState, selection.selectedIds, fetchPools, notify]);

  const handleTest = useCallback(
    async (pool) => {
      setTestingId(pool.id);
      try {
        const { res, data } = await apiJson(`/api/proxy-pools/${pool.id}/test`, {
          method: "POST",
        });
        await fetchPools();
        if (!res.ok) notify.error(data?.error || "Proxy test failed");
        else notify.success(data?.ok ? "Proxy test passed" : "Proxy test failed");
      } catch {
        notify.error("Proxy test failed");
      } finally {
        setTestingId(null);
      }
    },
    [fetchPools, notify],
  );

  const handleToggleActive = useCallback(
    async (pool) => {
      const next = !pool.isActive;
      setPools((prev) => prev.map((p) => (p.id === pool.id ? { ...p, isActive: next } : p)));
      try {
        const { res } = await apiJson(`/api/proxy-pools/${pool.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive: next }),
        });
        if (!res.ok) {
          setPools((prev) =>
            prev.map((p) => (p.id === pool.id ? { ...p, isActive: pool.isActive } : p)),
          );
          notify.error("Failed to update active state");
        }
      } catch {
        setPools((prev) =>
          prev.map((p) => (p.id === pool.id ? { ...p, isActive: pool.isActive } : p)),
        );
        notify.error("Failed to update active state");
      }
    },
    [notify],
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
          try {
            const { res } = await apiJson(`/api/proxy-pools/${id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ isActive }),
            });
            if (res.ok) ok += 1;
            else failed += 1;
          } catch {
            failed += 1;
          }
        }
        await fetchPools();
        notify.success(
          `${isActive ? "Activated" : "Deactivated"} ${ok}${failed ? `, ${failed} failed` : ""}`,
        );
      } finally {
        setBulkBusy(false);
      }
    },
    [selection.selectedIds, fetchPools, notify],
  );

  const handleHealthCheck = useCallback(async () => {
    const targets =
      selection.selectedIds.length > 0
        ? pools.filter((p) => selection.selectedIds.includes(p.id))
        : pools;
    if (targets.length === 0) return;
    dispatchSelection({ type: "check-start", total: targets.length });
    let alive = 0;
    let done = 0;
    const deadIds = [];
    const queue = [...targets];
    const worker = async () => {
      while (queue.length > 0) {
        const pool = queue.shift();
        if (!pool) break;
        try {
          const { res, data } = await apiJson(`/api/proxy-pools/${pool.id}/test`, {
            method: "POST",
          });
          if (res.ok && data?.ok) alive += 1;
          else deadIds.push(pool.id);
        } catch {
          deadIds.push(pool.id);
        } finally {
          done += 1;
          dispatchSelection({ type: "check-progress", current: done });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(10, targets.length) }, () => worker()));
    await fetchPools();
    dispatchSelection({ type: "check-done" });
    if (deadIds.length > 0) {
      setHealthResult({ alive, deadIds });
    } else {
      notify.success(`Health check done. Alive: ${alive}, Dead: 0`);
    }
  }, [selection.selectedIds, pools, fetchPools, notify]);

  const disableDead = useCallback(async () => {
    const deadIds = healthResult?.deadIds || [];
    setBulkBusy(true);
    try {
      for (const id of deadIds) {
        try {
          await apiJson(`/api/proxy-pools/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ isActive: false }),
          });
        } catch {
          // Per-pool failure leaves that pool active; the summary still reports.
        }
      }
      await fetchPools();
      notify.success(`Disabled ${deadIds.length} dead proxies`);
    } finally {
      setBulkBusy(false);
      setHealthResult(null);
    }
  }, [healthResult, fetchPools, notify]);

  const handleImport = useCallback(
    async (entries) => {
      setImporting(true);
      try {
        const existingKeys = new Set(
          pools.map((pool) => `${(pool.proxyUrl || "").trim()}|||${(pool.noProxy || "").trim()}`),
        );
        let created = 0;
        let skipped = 0;
        let failed = 0;
        for (const entry of entries) {
          const dedupeKey = `${entry.proxyUrl}|||`;
          if (existingKeys.has(dedupeKey)) {
            skipped += 1;
            continue;
          }
          try {
            const { res } = await apiJson("/api/proxy-pools", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: entry.name,
                proxyUrl: entry.proxyUrl,
                noProxy: "",
                isActive: true,
              }),
            });
            if (res.ok) {
              created += 1;
              existingKeys.add(dedupeKey);
            } else {
              failed += 1;
            }
          } catch {
            failed += 1;
          }
        }
        await fetchPools();
        setImportOpen(false);
        notify.success(
          `Batch import completed: Created ${created}, Skipped ${skipped}, Failed ${failed}`,
        );
      } finally {
        setImporting(false);
      }
    },
    [pools, fetchPools, notify],
  );

  const handleDeploy = useCallback(
    async (form) => {
      const endpoint =
        deployModal === "cloudflare"
          ? "/api/proxy-pools/cloudflare-deploy"
          : deployModal === "vercel"
            ? "/api/proxy-pools/vercel-deploy"
            : "/api/proxy-pools/deno-deploy";
      setDeploying(true);
      try {
        const { res, data } = await apiJson(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        });
        if (res.ok) {
          await fetchPools();
          setDeployModal(null);
          notify.success(`Deployed: ${data.deployUrl}`);
        } else {
          notify.error(data?.error || "Deploy failed");
        }
      } catch {
        notify.error("Deploy failed");
      } finally {
        setDeploying(false);
      }
    },
    [deployModal, fetchPools, notify],
  );

  const allSelected = pools.length > 0 && selection.selectedIds.length === pools.length;
  const someSelected =
    selection.selectedIds.length > 0 && selection.selectedIds.length < pools.length;

  const selectionBar = (
    <SelectionBar
      selectedCount={selection.selectedIds.length}
      checking={selection.checking}
      progress={selection.progress}
      busy={bulkBusy}
      hasPools={pools.length > 0}
      onHealthCheck={handleHealthCheck}
      onActivate={() => bulkSetActive(true)}
      onDeactivate={() => bulkSetActive(false)}
      onDelete={() =>
        setDeleteState({ count: selection.selectedIds.length, ids: selection.selectedIds })
      }
      onClear={() => dispatchSelection({ type: "clear" })}
    />
  );

  const panelTitle = editing ? "Edit proxy" : "Add proxy";
  const panelBody = (
    <ProxyForm
      key={formKey}
      initial={editing || {}}
      saving={saving}
      testing={formTesting}
      serverError={formError}
      submitLabel={editing ? "Save changes" : "Save proxy"}
      onSave={handleSave}
      onTest={handleFormTest}
      onCancel={panelNarrow ? closePanel : null}
    />
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <header className="flex flex-wrap items-center gap-3">
        <div className="me-auto flex min-w-0 flex-col gap-1">
          <p className="text-sm font-medium text-muted">
            Send provider traffic out through your proxies or free relays.
          </p>
        </div>
        <Button variant="secondary" icon="upload" onClick={() => setImportOpen(true)}>
          Batch import
        </Button>
        <Button variant="primary" icon="add" onClick={openAdd}>
          Add proxy
        </Button>
      </header>

      <RelayCards onDeploy={setDeployModal} />

      <div className="flex flex-col items-start gap-6 xl:flex-row">
        <div className="min-w-0 flex-1 self-stretch">
          {loading ? (
            <Card padding="md" role="status" aria-busy="true" aria-label="Loading proxy pools">
              <div className="flex flex-col gap-3">
                {["sk-1", "sk-2", "sk-3", "sk-4"].map((key) => (
                  <Skeleton key={key} className="h-16 w-full" />
                ))}
              </div>
            </Card>
          ) : (
            <PoolList
              pools={pools}
              loading={false}
              error={loadError}
              selectedIds={selection.selectedIds}
              onToggleSelect={(id) => dispatchSelection({ type: "toggle", id })}
              onToggleSelectAll={() =>
                dispatchSelection({
                  type: allSelected ? "clear" : "select-all",
                  ids: pools.map((p) => p.id),
                })
              }
              allSelected={allSelected}
              someSelected={someSelected}
              selectionBar={selectionBar}
              onToggleActive={handleToggleActive}
              onTest={handleTest}
              testingId={testingId}
              onEdit={openEdit}
              onDelete={handleDelete}
              onAdd={openAdd}
            />
          )}
        </div>

        {!panelNarrow && panelOpen ? (
          <Card
            padding="md"
            className="w-[380px] shrink-0 self-start"
            aria-label={panelTitle}
            title={panelTitle}
            action={
              <Button variant="ghost" size="sm" icon="close" onClick={closePanel}>
                Close
              </Button>
            }
          >
            {panelBody}
          </Card>
        ) : null}
      </div>

      <Drawer isOpen={panelNarrow && panelOpen} onClose={closePanel} title={panelTitle} size="md">
        {panelNarrow && panelOpen ? panelBody : null}
      </Drawer>

      <BatchImportModal
        isOpen={importOpen}
        onClose={() => setImportOpen(false)}
        importing={importing}
        onImport={handleImport}
      />

      <CloudflareDeployModal
        isOpen={deployModal === "cloudflare"}
        onClose={() => setDeployModal(null)}
        deploying={deploying}
        onDeploy={handleDeploy}
      />
      <VercelDeployModal
        isOpen={deployModal === "vercel"}
        onClose={() => setDeployModal(null)}
        deploying={deploying}
        onDeploy={handleDeploy}
      />
      <DenoDeployModal
        isOpen={deployModal === "deno"}
        onClose={() => setDeployModal(null)}
        deploying={deploying}
        onDeploy={handleDeploy}
      />

      <DeleteConfirm
        state={deleteState}
        busy={bulkBusy}
        onClose={() => setDeleteState(null)}
        onConfirm={confirmDelete}
      />

      <Modal
        isOpen={Boolean(healthResult)}
        onClose={() => setHealthResult(null)}
        title="Disable dead proxies"
        size="sm"
      >
        <Modal.Body>
          <p className="text-sm text-muted">
            Alive: {healthResult?.alive ?? 0}, dead: {healthResult?.deadIds.length ?? 0}. Disable
            the dead proxies?
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onClick={() => setHealthResult(null)} disabled={bulkBusy}>
            Keep all
          </Button>
          <Button variant="danger" loading={bulkBusy} onClick={disableDead}>
            Disable dead
          </Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
}
