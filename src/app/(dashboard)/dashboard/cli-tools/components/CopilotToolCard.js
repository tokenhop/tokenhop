"use client";

import { useState, useEffect, useRef } from "react";
import Callout from "@/shared/components/Callout";
import { useCliAccessStore } from "@/store/cliAccessStore";
import {
  useSetupCard,
  setupCardPropTypes,
  keyFallback,
  manualKeyFallback,
  ApiKeySelect,
  EndpointSegmentedPicker,
  SetupScaffold,
  SetupRow,
  ModelSelectModal,
  ManualConfigModal,
  rememberEndpoint,
  deriveToolStatus,
} from "./setupCard";

const ENDPOINT = "/api/cli-tools/copilot-settings";

/**
 * GitHub Copilot setup panel: multi-model chips written to VS Code's
 * chatLanguageModels.json. No install gate — the config lives in the
 * editor, not on this machine.
 */
export default function CopilotToolCard({
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
  const card = useSetupCard({ statusUrl: ENDPOINT, onStatusUpdate, toolId: "copilot" });
  const { status } = card;
  const [selectedModels, setSelectedModels] = useState([]);
  const selectedModelsRef = useRef([]);

  useEffect(() => {
    selectedModelsRef.current = selectedModels;
  }, [selectedModels]);

  useEffect(() => {
    if (apiKeys?.length > 0 && !card.selectedApiKey) card.setSelectedApiKey(apiKeys[0].key);
  }, [apiKeys, card]);

  useEffect(() => {
    if (status?.config && Array.isArray(status.config) && selectedModels.length === 0) {
      const entry = status.config.find((e) => e.name === "9Router");
      if (entry?.models?.length > 0) setSelectedModels(entry.models.map((m) => m.id));
    }
  }, [status, selectedModels.length]);

  const getEffectiveBaseUrl = () => {
    const fallback = card.customBaseUrl || baseUrl || "http://localhost:20128/v1";
    return fallback.endsWith("/v1") ? fallback : `${fallback}/v1`;
  };

  const postModels = async (models) => {
    await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: getEffectiveBaseUrl(),
        apiKey: keyFallback(card.selectedApiKey, apiKeys, cloudEnabled),
        models,
      }),
    }).catch(() => {});
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
          apiKey: keyFallback(card.selectedApiKey, apiKeys, cloudEnabled),
          models: selectedModels,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        rememberEndpoint(getEffectiveBaseUrl(), { tunnelPublicUrl, tailscaleUrl });
        card.setMessage({
          type: "success",
          text: data.message || "Settings applied. Reload VS Code.",
        });
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
        setSelectedModels([]);
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

  const getManualConfigs = () => {
    const modelsShown = selectedModels.length > 0 ? selectedModels : ["provider/model-id"];
    return [
      {
        filename: "~/Library/Application Support/Code/User/chatLanguageModels.json",
        content: JSON.stringify(
          [
            {
              name: "9Router",
              vendor: "azure",
              apiKey: manualKeyFallback(card.selectedApiKey, cloudEnabled),
              models: modelsShown.map((id) => ({
                id,
                name: id,
                url: `${getEffectiveBaseUrl()}/chat/completions#models.ai.azure.com`,
                toolCalling: true,
                vision: false,
                maxInputTokens: 128000,
                maxOutputTokens: 16000,
              })),
            },
          ],
          null,
          2,
        ),
      },
    ];
  };

  return (
    <>
      <SetupScaffold
        tool={tool}
        status={status ? deriveToolStatus(tool, status) : null}
        checking={card.checking}
        checkingLabel="Checking Copilot config..."
        message={card.message}
        onApply={handleApply}
        applyDisabled={selectedModels.length === 0}
        applying={card.applying}
        onReset={handleReset}
        resetDisabled={!status?.has9Router}
        resetting={card.restoring}
        onManualConfig={() => card.setShowManualModal(true)}
        manualConfigs={getManualConfigs()}
        manualDisabled={selectedModels.length === 0}
        fileHint="chatLanguageModels.json"
      >
        <Callout variant="info" title="VS Code extension">
          Writes to chatLanguageModels.json. Reload VS Code after applying for changes to take
          effect.
        </Callout>
        <EndpointSegmentedPicker
          value={card.customBaseUrl || baseUrl}
          onChange={card.setCustomBaseUrl}
          tunnelEnabled={tunnelEnabled}
          tunnelPublicUrl={tunnelPublicUrl}
          tailscaleEnabled={tailscaleEnabled}
          tailscaleUrl={tailscaleUrl}
          cloudEnabled={cloudEnabled}
          cloudUrl={cloudUrl}
          requiresExternalUrl={tool.requiresExternalUrl}
        />
        <SetupRow label="API key">
          <ApiKeySelect
            value={card.selectedApiKey}
            onChange={card.setSelectedApiKey}
            apiKeys={apiKeys}
            cloudEnabled={cloudEnabled}
          />
        </SetupRow>
        <SetupRow label="Models">
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
                    className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-transparent bg-panel px-2 py-0.5 font-mono text-xs text-muted"
                  >
                    {m}
                    <button
                      type="button"
                      onClick={() => setSelectedModels((prev) => prev.filter((x) => x !== m))}
                      aria-label={`Remove ${m}`}
                      className="flex size-6 items-center justify-center rounded-md transition-colors hover:text-err"
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
      </SetupScaffold>

      {card.modalOpen && (
        <ModelSelectModal
          isOpen={card.modalOpen}
          onClose={() => {
            card.setModalOpen(false);
            if (!useCliAccessStore.getState().localOnly) postModels(selectedModelsRef.current);
          }}
          onSelect={(m) => {
            if (!selectedModels.includes(m.value)) setSelectedModels((prev) => [...prev, m.value]);
          }}
          onDeselect={(m) => {
            setSelectedModels((prev) => prev.filter((x) => x !== m.value));
          }}
          selectedModel={null}
          activeProviders={activeProviders}
          modelAliases={card.modelAliases}
          addedModelValues={selectedModels}
          closeOnSelect={false}
          title="Add model for GitHub Copilot"
        />
      )}
      <ManualConfigModal
        isOpen={card.showManualModal}
        onClose={() => card.setShowManualModal(false)}
        title="GitHub Copilot — Manual configuration"
        configs={getManualConfigs()}
      />
    </>
  );
}

CopilotToolCard.propTypes = setupCardPropTypes;
