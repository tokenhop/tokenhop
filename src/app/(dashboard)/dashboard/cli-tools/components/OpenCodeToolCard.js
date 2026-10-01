"use client";

import { useState, useEffect, useRef } from "react";
import { useCliAccessStore } from "@/store/cliAccessStore";
import {
  useSetupCard,
  setupCardPropTypes,
  resolveApiKey,
  manualApiKey,
  toManualConfigs,
  ApiKeySelect,
  EndpointSegmentedPicker,
  SetupScaffold,
  NotInstalledBlock,
  SetupRow,
  SingleModelRow,
  ModelSelectModal,
  ManualConfigModal,
  rememberEndpoint,
  deriveToolStatus,
} from "./setupCard";
import { findClientEntry, splitModelRef } from "@/lib/cliToolBrand";
import { buildOpenCodeConfig } from "@/lib/cliToolConfigs/opencode";

const ENDPOINT = "/api/cli-tools/opencode-settings";

/**
 * OpenCode setup panel: multi-model list with an active model plus subagent.
 * Writes ~/.config/opencode/opencode.json. Selecting the active chip writes
 * through immediately (PATCH clear-active / DELETE per-model), matching the
 * Apply POST for the shared config shape.
 */
export default function OpenCodeToolCard({
  tool,
  baseUrl,
  apiKeys = [],
  activeProviders = [],
  cloudEnabled = false,
  cloudUrl = "",
  tunnelEnabled = false,
  tunnelPublicUrl = "",
  tailscaleEnabled = false,
  tailscaleUrl = "",
  onStatusUpdate,
}) {
  const card = useSetupCard({ statusUrl: ENDPOINT, onStatusUpdate, toolId: "opencode" });
  const { status } = card;
  const [selectedModels, setSelectedModels] = useState([]);
  const [activeModel, setActiveModel] = useState("");
  const [subagentModel, setSubagentModel] = useState("");
  const [subagentModalOpen, setSubagentModalOpen] = useState(false);
  const selectedModelsRef = useRef([]);

  useEffect(() => {
    selectedModelsRef.current = selectedModels;
  }, [selectedModels]);

  useEffect(() => {
    if (apiKeys?.length > 0 && !card.selectedApiKey) card.setSelectedApiKey(apiKeys[0].key);
  }, [apiKeys, card]);

  useEffect(() => {
    if (status?.opencode?.models) setSelectedModels(status.opencode.models);
    if (status?.opencode?.activeModel) setActiveModel(status.opencode.activeModel);
    const subagent = splitModelRef(status?.config?.agent?.explorer?.model);
    if (subagent) setSubagentModel(subagent.model);
  }, [status]);

  const currentBaseUrl = findClientEntry(status?.config?.provider)?.options?.baseURL || "";

  const getEffectiveBaseUrl = () => {
    const u = card.customBaseUrl || baseUrl || "http://localhost:20128/v1";
    return u.endsWith("/v1") ? u : `${u}/v1`;
  };

  const postModels = async (models, explicitActive) => {
    const validActive =
      explicitActive ?? (models.includes(activeModel) ? activeModel : models[0] || "");
    await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: getEffectiveBaseUrl(),
        apiKey: resolveApiKey(card.selectedApiKey, apiKeys, cloudEnabled),
        models,
        activeModel: validActive,
        subagentModel,
      }),
    }).catch(() => {});
  };

  // Remotely these routes answer 403; edits only shape the manual snippet.
  const isLocalOnly = () => useCliAccessStore.getState().localOnly;

  const clearActiveModel = async () => {
    if (isLocalOnly()) return setActiveModel("");
    try {
      const res = await fetch(ENDPOINT, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clearActiveModel: true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to clear active model.");
      }
      setActiveModel("");
      card.fetchStatus();
    } catch (err) {
      card.setMessage({ type: "error", text: err.message });
    }
  };

  const dropModel = (model) => {
    const next = selectedModels.filter((m) => m !== model);
    setSelectedModels(next);
    if (activeModel === model) setActiveModel(next[0] || "");
  };

  const removeServerModel = async (model) => {
    if (isLocalOnly()) return dropModel(model);
    try {
      const res = await fetch(`${ENDPOINT}?model=${encodeURIComponent(model)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to remove model.");
      }
      dropModel(model);
      card.fetchStatus();
    } catch (err) {
      card.setMessage({ type: "error", text: err.message });
    }
  };

  const handleApply = async () => {
    card.setApplying(true);
    card.setMessage(null);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: getEffectiveBaseUrl(),
          apiKey: resolveApiKey(card.selectedApiKey, apiKeys, cloudEnabled),
          models: selectedModels,
          activeModel: activeModel === "" ? "" : activeModel || selectedModels[0],
          subagentModel,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        rememberEndpoint(getEffectiveBaseUrl(), { tunnelPublicUrl, tailscaleUrl });
        card.setMessage({ type: "success", text: "Settings applied successfully." });
        card.fetchStatus();
      } else {
        card.setMessage({ type: "error", text: data.error || "Failed to apply settings." });
      }
    } catch (err) {
      card.setMessage({ type: "error", text: err.message });
    } finally {
      card.setApplying(false);
    }
  };

  const handleReset = async () => {
    card.setRestoring(true);
    card.setMessage(null);
    try {
      const res = await fetch(ENDPOINT, { method: "DELETE" });
      const data = await res.json();
      if (res.ok) {
        card.setMessage({ type: "success", text: "Settings reset successfully." });
        setSubagentModel("");
        setSelectedModels([]);
        setActiveModel("");
        card.fetchStatus();
      } else {
        card.setMessage({ type: "error", text: data.error || "Failed to reset settings." });
      }
      return res.ok;
    } catch (err) {
      card.setMessage({ type: "error", text: err.message });
      return false;
    } finally {
      card.setRestoring(false);
    }
  };

  const getManualConfigs = () =>
    toManualConfigs(
      buildOpenCodeConfig({
        baseUrl: getEffectiveBaseUrl(),
        apiKey: manualApiKey(card.selectedApiKey, apiKeys, cloudEnabled),
        models: selectedModels,
        activeModel: activeModel === "" ? "" : activeModel || selectedModels[0],
        subagentModel,
      }),
    );

  return (
    <>
      <SetupScaffold
        tool={tool}
        status={deriveToolStatus(tool, card.status)}
        checking={card.checking}
        checkingLabel="Checking OpenCode CLI..."
        notInstalled={
          !card.checking && status && !status.installed && !status.error ? (
            <NotInstalledBlock
              toolName="OpenCode"
              onManualConfig={() => card.setShowManualModal(true)}
              installCommand="npm install -g opencode-ai"
              installHint="macOS / Linux. After installation, run opencode to verify."
              guideOpen={card.showInstallGuide}
              onToggleGuide={() => card.setShowInstallGuide((v) => !v)}
            />
          ) : null
        }
        message={card.message}
        onApply={handleApply}
        applyDisabled={selectedModels.length === 0}
        applying={card.applying}
        onReset={handleReset}
        resetDisabled={!status?.hasTokenhop}
        resetting={card.restoring}
        onManualConfig={() => card.setShowManualModal(true)}
        manualConfigs={getManualConfigs()}
        fileHint="~/.config/opencode/opencode.json"
      >
        <EndpointSegmentedPicker
          value={card.customBaseUrl || baseUrl}
          onChange={card.setCustomBaseUrl}
          currentUrl={currentBaseUrl}
          tunnelEnabled={tunnelEnabled}
          tunnelPublicUrl={tunnelPublicUrl}
          tailscaleEnabled={tailscaleEnabled}
          tailscaleUrl={tailscaleUrl}
          cloudEnabled={cloudEnabled}
          cloudUrl={cloudUrl}
          requiresExternalUrl={tool.requiresExternalUrl}
        />
        {currentBaseUrl && (
          <SetupRow label="Current" hint={currentBaseUrl}>
            <span className="truncate font-mono text-xs text-muted">{currentBaseUrl}</span>
          </SetupRow>
        )}
        <SetupRow label="API key">
          <ApiKeySelect
            value={card.selectedApiKey}
            onChange={card.setSelectedApiKey}
            apiKeys={apiKeys}
            cloudEnabled={cloudEnabled}
          />
        </SetupRow>
        <SetupRow
          label="Models"
          hint={
            selectedModels.length > 0 && activeModel
              ? `active: ${activeModel}`
              : "click a model to set/clear active"
          }
        >
          <div className="flex flex-col gap-1.5">
            <div
              className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-xl border border-line bg-raised px-2 py-1.5"
              role="listbox"
              aria-label="Selected models"
            >
              {selectedModels.length === 0 ? (
                <span className="text-xs text-muted">No models selected</span>
              ) : (
                selectedModels.map((m) => (
                  <span
                    key={m}
                    role="option"
                    aria-selected={m === activeModel}
                    tabIndex={0}
                    onClick={() => (m === activeModel ? clearActiveModel() : setActiveModel(m))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        if (m === activeModel) clearActiveModel();
                        else setActiveModel(m);
                      }
                    }}
                    title={
                      m === activeModel ? "Click to clear active model" : "Click to set as active"
                    }
                    className={`inline-flex min-h-8 cursor-pointer items-center gap-1 rounded-lg px-2 py-0.5 font-mono text-xs transition-colors focus-visible:outline-none focus-visible:shadow-focus ${
                      m === activeModel
                        ? "border border-coral bg-coral-bg text-coral-ink"
                        : "border border-transparent bg-panel text-muted hover:border-line"
                    }`}
                  >
                    {m === activeModel && (
                      <span className="material-symbols-outlined text-[12px]" aria-hidden="true">
                        star
                      </span>
                    )}
                    {m}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeServerModel(m);
                      }}
                      aria-label={`Remove ${m}`}
                      className="ms-0.5 flex size-6 items-center justify-center rounded-md transition-colors hover:text-err"
                    >
                      <span className="material-symbols-outlined text-[12px]" aria-hidden="true">
                        close
                      </span>
                    </button>
                  </span>
                ))
              )}
            </div>
            <button
              type="button"
              onClick={() => card.setModalOpen(true)}
              disabled={!activeProviders?.length}
              className="w-fit rounded-xl border border-line bg-raised px-3 py-2 text-xs font-semibold text-text transition-colors hover:border-coral disabled:cursor-not-allowed disabled:opacity-50"
            >
              Add model
            </button>
          </div>
        </SetupRow>
        <SetupRow label="Subagent model">
          <SingleModelRow
            value={subagentModel}
            onChange={setSubagentModel}
            onPick={() => setSubagentModalOpen(true)}
            pickDisabled={!activeProviders?.length}
            placeholder="provider/model-id (defaults to main model)"
          />
        </SetupRow>
      </SetupScaffold>

      {card.modalOpen && (
        <ModelSelectModal
          isOpen={card.modalOpen}
          onClose={() => {
            card.setModalOpen(false);
            if (!isLocalOnly()) postModels(selectedModelsRef.current);
          }}
          onSelect={(m) => {
            if (!selectedModels.includes(m.value)) {
              setSelectedModels((prev) => {
                const next = [...prev, m.value];
                if (!activeModel) setActiveModel(m.value);
                return next;
              });
            }
          }}
          onDeselect={(m) => {
            setSelectedModels((prev) => {
              const next = prev.filter((x) => x !== m.value);
              if (activeModel === m.value) setActiveModel(next[0] || "");
              return next;
            });
          }}
          selectedModel={null}
          activeProviders={activeProviders}
          modelAliases={card.modelAliases}
          addedModelValues={selectedModels}
          closeOnSelect={false}
          title="Add model for OpenCode"
        />
      )}
      {subagentModalOpen && (
        <ModelSelectModal
          isOpen={subagentModalOpen}
          onClose={() => setSubagentModalOpen(false)}
          onSelect={(m) => {
            setSubagentModel(m.value);
            setSubagentModalOpen(false);
          }}
          selectedModel={subagentModel}
          activeProviders={activeProviders}
          modelAliases={card.modelAliases}
          title="Select subagent model for OpenCode"
        />
      )}
      <ManualConfigModal
        isOpen={card.showManualModal}
        onClose={() => card.setShowManualModal(false)}
        title="OpenCode — Manual configuration"
        configs={getManualConfigs()}
      />
    </>
  );
}

OpenCodeToolCard.propTypes = setupCardPropTypes;
