"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button, EmptyState, Input } from "@/shared/components";
import { getProviderCustomModelRows } from "@/shared/utils/providerCustomModels";
import ModelRow from "../[id]/ModelRow";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

/**
 * Signal compatible-provider models card: manual add, /models import,
 * test/copy/remove rows and the no-connection hint.
 */
export default function CompatibleModelsSection({
  isFreeNoAuth,
  storageAlias,
  displayAlias,
  isAnthropic,
  connections,
  models,
  actions,
}) {
  const { copied, error: copyError, copy } = useCopyToClipboard();
  const [newModel, setNewModel] = useState("");
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [testingId, setTestingId] = useState(null);
  const [testResults, setTestResults] = useState({});

  const allModels = getProviderCustomModelRows({
    customModels: models.customModels,
    modelAliases: models.modelAliases,
    providerAlias: storageAlias,
    type: "llm",
  });
  const canImport = connections.some((entry) => entry.isActive !== false);

  const testModel = async (modelId) => {
    if (testingId) return;
    setTestingId(modelId);
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${storageAlias}/${modelId}` }),
      });
      const data = await res.json().catch(() => ({}));
      const passed = res.ok && data.ok;
      setTestResults((prev) => ({ ...prev, [modelId]: passed ? "ok" : "error" }));
      if (!passed) actions.notifyError(data.error || "Model not reachable");
    } catch {
      setTestResults((prev) => ({ ...prev, [modelId]: "error" }));
      actions.notifyError("Network error");
    } finally {
      setTestingId(null);
    }
  };

  const handleAdd = async () => {
    const modelId = newModel.trim();
    if (!modelId || adding) return;
    if (allModels.some((row) => row.id === modelId)) {
      actions.notifyError("Model already exists for this provider.");
      return;
    }
    setAdding(true);
    try {
      if (await models.addCustomModel(modelId, "llm", storageAlias)) setNewModel("");
    } finally {
      setAdding(false);
    }
  };

  const handleImport = async () => {
    if (importing) return;
    const activeConnection = connections.find((entry) => entry.isActive !== false);
    if (!activeConnection) return;
    setImporting(true);
    try {
      const res = await fetch(`/api/providers/${activeConnection.id}/models`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        actions.notifyError(data.error || "Failed to import models");
        return;
      }
      const listed = data.models || [];
      if (listed.length === 0) {
        actions.notifyError("No models returned from /models.");
        return;
      }
      let importedCount = 0;
      for (const model of listed) {
        const modelId = model.id || model.name || model.model;
        if (!modelId) continue;
        if (allModels.some((row) => row.id === modelId)) continue;
        if (await models.addCustomModel(modelId, "llm", storageAlias)) importedCount += 1;
      }
      if (importedCount === 0) actions.notifyError("No new models were added.");
      else
        actions.notifySuccess(`Imported ${importedCount} model${importedCount === 1 ? "" : "s"}.`);
    } catch (error) {
      actions.notifyError(error instanceof Error ? error.message : "Failed to import models");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Add {isAnthropic ? "Anthropic" : "OpenAI"}-compatible models manually or import them from
        the /models endpoint.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Input
          label="Model ID"
          id="new-compatible-model-input"
          value={newModel}
          onChange={(event) => setNewModel(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && handleAdd()}
          placeholder={isAnthropic ? "claude-3-opus-20240229" : "gpt-4o"}
          className="min-w-60 flex-1"
        />
        <Button size="sm" icon="add" onClick={handleAdd} disabled={!newModel.trim() || adding}>
          {adding ? "Adding…" : "Add"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon="download"
          onClick={handleImport}
          disabled={!canImport || importing}
          loading={importing}
        >
          {importing ? "Importing…" : "Import from /models"}
        </Button>
      </div>
      {!canImport ? (
        <p className="text-xs text-muted">Add a connection to enable importing models.</p>
      ) : null}
      {allModels.length > 0 ? (
        <ul className="flex min-w-0 flex-col gap-2">
          {allModels.map(({ id, alias, source }) => (
            <ModelRow
              key={`${source}-${storageAlias}/${id}`}
              model={{ id }}
              fullModel={`${displayAlias}/${id}`}
              copied={copied}
              copyError={copyError}
              onCopy={copy}
              onDeleteAlias={() =>
                source === "custom"
                  ? models.deleteCustomModel(id, "llm", storageAlias)
                  : models.deleteAlias(alias)
              }
              onTest={connections.length > 0 || isFreeNoAuth ? () => testModel(id) : undefined}
              testStatus={testResults[id]}
              isTesting={testingId === id}
              isCustom
            />
          ))}
        </ul>
      ) : (
        <EmptyState
          icon="smart_toy"
          title="No models yet"
          body="Add a model id above or import the provider /models catalog."
        />
      )}
    </div>
  );
}

CompatibleModelsSection.propTypes = {
  isFreeNoAuth: PropTypes.bool.isRequired,
  storageAlias: PropTypes.string.isRequired,
  displayAlias: PropTypes.string.isRequired,
  isAnthropic: PropTypes.bool.isRequired,
  connections: PropTypes.array.isRequired,
  models: PropTypes.object.isRequired,
  actions: PropTypes.shape({
    notifyError: PropTypes.func.isRequired,
    notifySuccess: PropTypes.func.isRequired,
  }).isRequired,
};
