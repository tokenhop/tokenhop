"use client";

import PropTypes from "prop-types";
import { Button, Card, Callout, EmptyState, Select } from "@/shared/components";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import ModelRow from "../[id]/ModelRow";
import FetchModelsButton from "../[id]/FetchModelsButton";

/**
 * Signal available-models card: thinking level, Active/Disable all,
 * test/copy/remove rows, add-model entry, fetch/import and suggested plus
 * restorable disabled models. Compatible providers keep their manual catalog.
 */
export default function ModelsSection({
  providerId,
  storageAlias,
  displayAlias,
  isLiveCatalog,
  isCompatible,
  isAnthropic,
  isFreeNoAuth,
  connections,
  catalogModels,
  staticModels,
  liveError,
  refreshLive,
  models,
  extraAddButtons,
  compatibleSection,
  onDisableAll,
}) {
  const { getCaps } = useModelCaps();
  const { copied, error: copyError, copy } = useCopyToClipboard();

  const hasActiveConnection = connections.some((entry) => entry.isActive !== false);

  const thinkingLevels = (() => {
    const levels = new Set();
    const seen = new Set();
    const add = (modelId) => {
      if (!modelId || seen.has(modelId)) return;
      seen.add(modelId);
      const found = getThinkingLevels(providerId, modelId);
      for (const level of found || []) if (level !== "none") levels.add(level);
    };
    for (const model of catalogModels) add(model.id);
    for (const row of models.customModelRows) add(row.id);
    return levels.size ? ["auto", ...levels] : null;
  })();

  const resolveThinkingSuffix = (modelId) => {
    if (!models.thinkingMode || models.thinkingMode === "auto") return null;
    const levels = getThinkingLevels(providerId, modelId);
    return levels?.includes(models.thinkingMode) ? models.thinkingMode : null;
  };

  const testModel = (modelId) => models.testModel(modelId);

  const regionLink = (() => {
    if (
      typeof models.testError !== "string" ||
      !/RegionError|hosted in China|regionNotAllowed/i.test(models.testError)
    ) {
      return null;
    }
    const text = models.testError;
    const linkMatch = text.match(/https:\/\/opencode\.ai\/workspace\/[^\s"')]+/);
    const workMatch = text.match(/wrk_[0-9A-Za-z]+/);
    if (linkMatch) return linkMatch[0].endsWith("/go") ? linkMatch[0] : `${linkMatch[0]}/go`;
    if (workMatch) return `https://opencode.ai/workspace/${workMatch[0]}/go`;
    return "https://opencode.ai";
  })();

  const activeIds = models.enabledModels.map((model) => model.id);
  const addedFullModels = new Set([
    ...Object.values(models.modelAliases),
    ...models.customModelRows.map((row) => row.fullModel),
  ]);
  const hardcodedIds = new Set(catalogModels.map((model) => model.id));
  const suggested = models.suggestedModels.filter(
    (model) => !addedFullModels.has(`${storageAlias}/${model.id}`) && !hardcodedIds.has(model.id),
  );

  return (
    <Card
      title="Available Models"
      subtitle={
        isCompatible
          ? `Manual ${isAnthropic ? "Anthropic" : "OpenAI"}-compatible catalog`
          : `${models.enabledModels.length} active${models.disabledModels.length > 0 ? ` · ${models.disabledModels.length} disabled` : ""}`
      }
      action={
        <div className="flex flex-wrap items-center gap-2">
          {thinkingLevels ? (
            <Select
              aria-label="Thinking level for copied model names"
              value={models.thinkingMode}
              onChange={(event) => models.changeThinking(event.target.value)}
              options={thinkingLevels.map((level) => ({
                value: level,
                label: `Thinking: ${level.charAt(0).toUpperCase() + level.slice(1)}`,
              }))}
              selectClassName="py-1.5 text-xs sm:text-xs"
            />
          ) : null}
          {!isCompatible && models.disabledModelIds.length > 0 ? (
            <Button size="sm" variant="secondary" icon="restart_alt" onClick={models.enableAll}>
              Active All
            </Button>
          ) : null}
          {!isCompatible && activeIds.length > 0 ? (
            <Button
              size="sm"
              variant="secondary"
              icon="block"
              onClick={() => models.disableAll(activeIds, onDisableAll)}
            >
              Disable All
            </Button>
          ) : null}
        </div>
      }
    >
      {!!models.testError && (
        <div className="mb-3">
          <Callout variant="err">{models.testError}</Callout>
          {regionLink ? (
            <a
              href={regionLink}
              target="_blank"
              rel="noreferrer"
              className="mt-1.5 inline-flex items-center gap-1 rounded-lg bg-warn-bg px-2 py-0.5 text-xs font-medium text-warn"
            >
              <span>Allow China-hosted models</span>
              <span className="material-symbols-outlined text-[13px]" aria-hidden="true">
                open_in_new
              </span>
            </a>
          ) : null}
        </div>
      )}
      {isLiveCatalog && liveError ? (
        <p className="mb-3 text-xs break-words text-err">{liveError}</p>
      ) : null}
      {isCompatible ? (
        compatibleSection
      ) : (
        <div className="flex flex-col gap-4">
          {models.enabledModels.length === 0 && models.customModelRows.length === 0 ? (
            <EmptyState
              icon="smart_toy"
              title="No models available"
              body="Add a custom model or fetch the live catalog."
            />
          ) : (
            <ul className="flex min-w-0 flex-col gap-2">
              {models.customModelRows.map((row) => (
                <ModelRow
                  key={`${row.source}-${row.fullModel}`}
                  model={{ id: row.id, name: row.name }}
                  fullModel={`${displayAlias}/${row.id}`}
                  copied={copied}
                  copyError={copyError}
                  onCopy={copy}
                  onDeleteAlias={() => {
                    if (row.source === "custom") {
                      models.deleteCustomModel(row.id, "llm", storageAlias);
                    } else if (row.alias) {
                      models.deleteAlias(row.alias);
                    }
                  }}
                  testStatus={models.testResults[row.id]}
                  onTest={
                    connections.length > 0 || isFreeNoAuth ? () => testModel(row.id) : undefined
                  }
                  isTesting={models.testingIds.has(row.id)}
                  isCustom
                  caps={getCaps(`${providerId}/${row.id}`)}
                  thinkingSuffix={resolveThinkingSuffix(row.id)}
                />
              ))}
              {models.enabledModels.map((model) => {
                const fullModel = `${storageAlias}/${model.id}`;
                const oldFormatModel = `${providerId}/${model.id}`;
                const existingAlias = Object.entries(models.modelAliases).find(
                  ([, target]) => target === fullModel || target === oldFormatModel,
                )?.[0];
                return (
                  <ModelRow
                    key={model.id}
                    model={model}
                    fullModel={`${displayAlias}/${model.id}`}
                    alias={existingAlias}
                    copied={copied}
                    copyError={copyError}
                    onCopy={copy}
                    onSetAlias={(next) => models.setAlias(model.id, next, storageAlias)}
                    onDeleteAlias={
                      existingAlias ? () => models.deleteAlias(existingAlias) : undefined
                    }
                    testStatus={models.testResults[model.id]}
                    onTest={
                      connections.length > 0 || isFreeNoAuth ? () => testModel(model.id) : undefined
                    }
                    isTesting={models.testingIds.has(model.id)}
                    isFree={model.isFree}
                    onDisable={() => models.disableModel(model.id)}
                    caps={getCaps(`${providerId}/${model.id}`)}
                    thinkingSuffix={resolveThinkingSuffix(model.id)}
                  />
                );
              })}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              icon="add"
              onClick={() => models.setShowAddCustomModel(true)}
            >
              Add Model
            </Button>
            {isLiveCatalog && hasActiveConnection ? (
              <FetchModelsButton
                providerId={providerId}
                refresh={refreshLive}
                staticModels={staticModels}
                customModels={models.customModels}
                modelAliases={models.modelAliases}
                providerStorageAlias={storageAlias}
                onAddModel={(modelId) => models.addCustomModel(modelId, "llm", storageAlias)}
              />
            ) : null}
            {extraAddButtons}
          </div>
          {suggested.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted">Suggested free models (≥200k context):</p>
              <div className="flex flex-wrap gap-2">
                {suggested.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => models.addCustomModel(model.id, "llm", storageAlias)}
                    className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted transition-colors hover:border-coral hover:text-text"
                    title={`${model.name} · ${(model.contextLength / 1000).toFixed(0)}k ctx`}
                  >
                    <span className="material-symbols-outlined text-[13px]" aria-hidden="true">
                      add
                    </span>
                    {model.id.split("/").pop()}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {models.disabledModels.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted">
                Disabled models ({models.disabledModels.length}):
              </p>
              <div className="flex flex-wrap gap-2" aria-live="polite">
                {models.disabledModels.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => models.enableModel(model.id)}
                    className="flex items-center gap-1 rounded-lg border border-dashed border-line px-2.5 py-1.5 text-xs text-muted transition-colors hover:border-coral hover:text-text"
                    title="Restore model"
                  >
                    <span className="material-symbols-outlined text-[13px]" aria-hidden="true">
                      add
                    </span>
                    {model.id}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}

ModelsSection.propTypes = {
  providerId: PropTypes.string.isRequired,
  storageAlias: PropTypes.string.isRequired,
  displayAlias: PropTypes.string.isRequired,
  isLiveCatalog: PropTypes.bool.isRequired,
  isCompatible: PropTypes.bool.isRequired,
  isAnthropic: PropTypes.bool.isRequired,
  isFreeNoAuth: PropTypes.bool.isRequired,
  connections: PropTypes.array.isRequired,
  catalogModels: PropTypes.array.isRequired,
  staticModels: PropTypes.array.isRequired,
  liveError: PropTypes.string,
  refreshLive: PropTypes.func,
  models: PropTypes.object.isRequired,
  extraAddButtons: PropTypes.node,
  compatibleSection: PropTypes.node,
  onDisableAll: PropTypes.func.isRequired,
};
