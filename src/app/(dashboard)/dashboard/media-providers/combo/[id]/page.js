"use client";

import { useEffect, useState } from "react";
import { useParams, notFound } from "next/navigation";
import {
  ModelSelectModal,
  ConfirmDialog,
  Callout,
  LoadingState,
  ErrorState,
} from "@/shared/components";
import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import { EXAMPLE_PATHS, buildCurl, getListingHref, kindLabelFor } from "./mediaComboConfig";
import { useMediaCombo } from "./useMediaCombo";
import { useComboTest } from "./useComboTest";
import ComboHeader from "./components/ComboHeader";
import ComboSettingsCard from "./components/ComboSettingsCard";
import ComboProvidersCard from "./components/ComboProvidersCard";
import ComboTestCard from "./components/ComboTestCard";
import ComboLogsCard from "./components/ComboLogsCard";

/** Media combo detail: settings, providers, probe and logs for one media combo. */
export default function ComboDetailPage() {
  const { id } = useParams();
  const state = useMediaCombo(id);
  const {
    combo,
    loading,
    loadError,
    missing,
    reload,
    name,
    setName,
    nameError,
    validateName,
    providers,
    roundRobin,
    savingStrategy,
    savingModels,
    logs,
    apiKey,
    connections,
    modelAliases,
    confirmDelete,
    setConfirmDelete,
    saveError,
    setSaveError,
    saveStatus,
    setSaveStatus,
    handleSaveName,
    handleAddModel,
    handleDeselectModel,
    handleRemoveProvider,
    handleMove,
    handleToggleRoundRobin,
    handleDelete,
  } = state;
  const [showPicker, setShowPicker] = useState(false);
  const [origin, setOrigin] = useState("");
  const { testing, testResult, testError, handleTest } = useComboTest(
    combo || { kind: "", name: "" },
    apiKey,
  );

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  if (loading) return <LoadingState lines={6} label="Loading" />;
  if (loadError)
    return <ErrorState title="Something went wrong" message={loadError} onRetry={reload} />;
  if (missing || !combo) return notFound();

  const kindLabel = kindLabelFor(combo.kind, MEDIA_PROVIDER_KINDS);
  const backHref = getListingHref(combo.kind);
  const examplePath = EXAMPLE_PATHS[combo.kind];
  const curlExample = buildCurl({ origin, kind: combo.kind, name: combo.name, apiKey });

  return (
    <div className="flex flex-col gap-6">
      {saveError && <Callout variant="err">{saveError}</Callout>}
      <ComboHeader
        kindLabel={kindLabel}
        comboName={combo.name}
        backHref={backHref}
        onDelete={() => setConfirmDelete(true)}
      />
      <ComboSettingsCard
        name={name}
        nameError={nameError}
        saveStatus={saveStatus}
        onNameChange={(value) => {
          setName(value);
          setSaveStatus("");
          validateName(value);
        }}
        onNameBlur={handleSaveName}
        roundRobin={roundRobin}
        savingStrategy={savingStrategy}
        onToggleRoundRobin={handleToggleRoundRobin}
      />
      <ComboProvidersCard
        providers={providers}
        roundRobin={roundRobin}
        savingModels={savingModels}
        onAdd={() => setShowPicker(true)}
        onMove={handleMove}
        onRemove={handleRemoveProvider}
      />
      {combo.kind && examplePath && (
        <ComboTestCard
          curlExample={curlExample}
          testing={testing}
          testResult={testResult}
          testError={testError}
          canRun={providers.length > 0}
          onRun={handleTest}
        />
      )}
      <ComboLogsCard logs={logs} />
      {showPicker && (
        <ModelSelectModal
          isOpen={showPicker}
          onClose={() => setShowPicker(false)}
          onSelect={handleAddModel}
          onDeselect={handleDeselectModel}
          activeProviders={connections}
          modelAliases={modelAliases}
          title={`Add ${kindLabel} model`}
          kindFilter={combo.kind}
          addedModelValues={providers}
          closeOnSelect={false}
        />
      )}
      <ConfirmDialog
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          try {
            await handleDelete();
          } catch (error) {
            setSaveError(error?.message || "Delete failed");
          } finally {
            setConfirmDelete(false);
          }
        }}
        title="Delete combo"
        message={`Delete combo "${combo.name}"?`}
        confirmText="Delete"
      />
    </div>
  );
}
