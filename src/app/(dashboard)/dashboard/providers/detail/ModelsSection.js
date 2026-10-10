"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button, Card, Callout, Checkbox, EmptyState, Input, Select } from "@/shared/components";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import MoveToWorkspaceButton from "@/shared/components/MoveToWorkspaceButton";
import ModelRow from "../[id]/ModelRow";
import FetchModelsButton from "../[id]/FetchModelsButton";

const FILTER_THRESHOLD = 30;
const INPUT_FILTERS = [
  { value: "", label: "Any input" },
  { value: "image", label: "Image input" },
  { value: "audio", label: "Audio input" },
  { value: "video", label: "Video input" },
  { value: "file", label: "File input" },
];

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
  liveFallback = false,
  refreshLive,
  models,
  compatibleSection,
  onDisableAll,
  kind = "llm",
  title,
}) {
  const { getCaps } = useModelCaps();
  const { copied, error: copyError, copy } = useCopyToClipboard();
  const effectiveKind = kind || "llm";
  const [query, setQuery] = useState("");
  const [freeOnly, setFreeOnly] = useState(false);
  const [inputModality, setInputModality] = useState("");

  const hasActiveConnection = connections.some((entry) => entry.isActive !== false);
  // Legacy media card always showed Test; Signal gates on connections. Keep
  // the gate for llm, preserve legacy behaviour for media kinds.
  const showTestButton = effectiveKind === "llm" ? connections.length > 0 || isFreeNoAuth : true;

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

  // Hidden live entries are listed for reference, not counted or bulk-disabled.
  const activeIds = models.enabledModels.filter((model) => !model.hidden).map((model) => model.id);
  // Large live catalogs (OpenRouter lists hundreds) get search and filters.
  // Plain Input, not ToolbarSearch: its page-wide "/" shortcut belongs to page toolbars.
  const showFilters = isLiveCatalog && models.enabledModels.length > FILTER_THRESHOLD;
  const needle = query.trim().toLowerCase();
  const visibleModels = showFilters
    ? models.enabledModels.filter(
        (model) =>
          (!needle ||
            model.id.toLowerCase().includes(needle) ||
            model.name?.toLowerCase().includes(needle)) &&
          (!freeOnly || model.isFree) &&
          (!inputModality || model.inputModalities?.includes(inputModality)),
      )
    : models.enabledModels;
  const visibleLiveIds = new Set(
    isLiveCatalog && !liveFallback ? visibleModels.map((model) => model.id) : [],
  );
  const customModelRows = models.customModelRows.filter((row) => !visibleLiveIds.has(row.id));
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
      title={title || "Available models"}
      subtitle={
        isCompatible
          ? `Manual ${isAnthropic ? "Anthropic" : "OpenAI"}-compatible catalog`
          : `${activeIds.length} active${models.disabledModels.length > 0 ? ` · ${models.disabledModels.length} disabled` : ""}`
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
              Enable all
            </Button>
          ) : null}
          {!isCompatible && activeIds.length > 0 ? (
            <Button
              size="sm"
              variant="secondary"
              icon="block"
              onClick={() => models.disableAll(activeIds, onDisableAll)}
            >
              Disable all
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
        <div className="mb-3">
          <Callout variant="warn" icon={liveFallback ? "cloud_off" : undefined}>
            {liveFallback
              ? `Live model list unavailable — showing the built-in list. ${liveError}`
              : liveError}
          </Callout>
        </div>
      ) : null}
      {isCompatible ? (
        compatibleSection
      ) : (
        <div className="flex flex-col gap-4">
          {models.enabledModels.length === 0 && customModelRows.length === 0 ? (
            <EmptyState
              icon="smart_toy"
              title="No models available"
              body="Add a custom model or fetch the live catalog."
            />
          ) : (
            <>
              {showFilters ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Input
                    type="search"
                    aria-label="Search models"
                    placeholder="Search models"
                    icon="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className="min-w-[200px] flex-1"
                    inputClassName="py-1.5 text-xs sm:text-xs"
                  />
                  <Checkbox label="Free only" checked={freeOnly} onChange={setFreeOnly} />
                  <Select
                    aria-label="Filter by input type"
                    value={inputModality}
                    onChange={(event) => setInputModality(event.target.value)}
                    options={INPUT_FILTERS}
                    placeholder={null}
                    selectClassName="py-1.5 text-xs sm:text-xs"
                  />
                  <span className="text-xs text-muted" aria-live="polite">
                    {visibleModels.length} of {models.enabledModels.length}
                  </span>
                </div>
              ) : null}
              {showFilters && visibleModels.length === 0 ? (
                <p className="text-xs text-muted" aria-hidden="true">
                  No models match the filters.
                </p>
              ) : null}
              <ul className="flex min-w-0 flex-col gap-2">
                {customModelRows.map((row) => (
                  <ModelRow
                    key={`${row.source}-${row.fullModel}`}
                    model={{ id: row.id, name: row.name }}
                    fullModel={`${displayAlias}/${row.id}`}
                    copied={copied}
                    copyError={copyError}
                    onCopy={copy}
                    onDeleteAlias={() => {
                      if (row.source === "custom") {
                        models.deleteCustomModel(row.id, effectiveKind, storageAlias);
                      } else if (row.alias) {
                        models.deleteAlias(row.alias);
                      }
                    }}
                    testStatus={models.testResults[row.id]}
                    onTest={showTestButton ? () => testModel(row.id) : undefined}
                    isTesting={models.testingIds.has(row.id)}
                    isCustom
                    moveItem={
                      row.source === "custom"
                        ? {
                            type: "customModel",
                            id: `${storageAlias}|${row.id}|${effectiveKind}`,
                            label: `custom model "${row.id}"`,
                          }
                        : row.alias
                          ? { type: "alias", id: row.alias, label: `alias "${row.alias}"` }
                          : undefined
                    }
                    onMoved={models.load}
                    caps={getCaps(`${providerId}/${row.id}`)}
                    thinkingSuffix={resolveThinkingSuffix(row.id)}
                  />
                ))}
                {visibleModels.map((model) => {
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
                      onTest={showTestButton ? () => testModel(model.id) : undefined}
                      isTesting={models.testingIds.has(model.id)}
                      isFree={model.isFree}
                      onDisable={() => models.disableModel(model.id)}
                      moveItem={
                        existingAlias
                          ? { type: "alias", id: existingAlias, label: `alias "${existingAlias}"` }
                          : undefined
                      }
                      onMoved={models.load}
                      caps={{ ...getCaps(`${providerId}/${model.id}`), ...model.capabilities }}
                      thinkingSuffix={resolveThinkingSuffix(model.id)}
                    />
                  );
                })}
              </ul>
            </>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              icon="add"
              onClick={() => models.setShowAddCustomModel(true)}
            >
              Add model
            </Button>
            {isLiveCatalog && (hasActiveConnection || isFreeNoAuth) ? (
              <FetchModelsButton
                providerId={providerId}
                refresh={refreshLive}
                staticModels={staticModels}
                customModels={models.customModels}
                modelAliases={models.modelAliases}
                providerStorageAlias={storageAlias}
                onAddModel={(modelId) =>
                  models.addCustomModel(modelId, effectiveKind, storageAlias)
                }
              />
            ) : null}
          </div>
          {suggested.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted">Suggested free models (≥200k context):</p>
              <div className="flex flex-wrap gap-2">
                {suggested.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => models.addCustomModel(model.id, effectiveKind, storageAlias)}
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
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs text-muted">
                  Disabled models ({models.disabledModels.length}):
                </p>
                <MoveToWorkspaceButton
                  variant="button"
                  label="Move list"
                  items={[
                    {
                      type: "disabledModel",
                      id: storageAlias,
                      label: `disabled models for "${storageAlias}"`,
                    },
                  ]}
                  onMoved={models.load}
                />
              </div>
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
  liveFallback: PropTypes.bool,
  refreshLive: PropTypes.func,
  models: PropTypes.object.isRequired,
  compatibleSection: PropTypes.node,
  onDisableAll: PropTypes.func.isRequired,
  kind: PropTypes.string,
  title: PropTypes.string,
};
