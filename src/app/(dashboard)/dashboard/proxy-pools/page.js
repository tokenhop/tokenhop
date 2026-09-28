"use client";

import Button from "@/shared/components/Button";
import Card from "@/shared/components/Card";
import Drawer from "@/shared/components/Drawer";
import Modal from "@/shared/components/Modal";
import { Skeleton } from "@/shared/components/Loading";
import RelayCards from "./components/RelayCards";
import PoolList from "./components/PoolList";
import SelectionBar from "./components/SelectionBar";
import { BatchImportModal, DeleteConfirm, ProxyForm } from "./components/ProxyForm";
import {
  CloudflareDeployModal,
  DenoDeployModal,
  VercelDeployModal,
} from "./components/RelayModals";
import useProxyPools from "./useProxyPools";

/** Signal redesign of the Proxy pools page (board `ProxyPools.dc.html`). */
export default function ProxyPoolsPage() {
  const {
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
    setImportOpen,
    setDeployModal,
    setDeleteState,
    setHealthResult,
  } = useProxyPools();

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
      onDelete={requestBulkDelete}
      onClear={clearSelection}
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
        <Button
          className="ms-auto"
          variant="secondary"
          icon="upload"
          onClick={() => setImportOpen(true)}
        >
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
              onToggleSelect={toggleSelect}
              onToggleSelectAll={toggleSelectAll}
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
