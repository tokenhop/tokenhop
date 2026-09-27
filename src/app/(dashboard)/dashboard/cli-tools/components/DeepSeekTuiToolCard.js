"use client";

import { useState, useEffect, useRef } from "react";
import {
  useSetupCard,
  setupCardPropTypes,
  keyFallback,
  manualKeyFallback,
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

const ENDPOINT = "/api/cli-tools/deepseek-tui-settings";

/**
 * DeepSeek TUI setup panel. Single model in the [providers.openai] TOML
 * section. Writes ~/.deepseek/config.toml.
 */
export default function DeepSeekTuiToolCard({
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
  const card = useSetupCard({ statusUrl: ENDPOINT, onStatusUpdate, toolId: "deepseek-tui" });
  const { status } = card;
  const [selectedModel, setSelectedModel] = useState("");
  const hasInitializedModel = useRef(false);

  useEffect(() => {
    if (apiKeys?.length > 0 && !card.selectedApiKey) card.setSelectedApiKey(apiKeys[0].key);
  }, [apiKeys, card]);

  useEffect(() => {
    if (status?.installed && !hasInitializedModel.current) {
      hasInitializedModel.current = true;
      const model = status.settings?.["providers.openai"]?.model;
      if (model) setSelectedModel(model);
    }
  }, [status]);

  const currentBaseUrl = status?.settings?.["providers.openai"]?.base_url || "";

  const getEffectiveBaseUrl = () => {
    const u = (card.customBaseUrl || baseUrl || "http://127.0.0.1:20128/v1").replace(
      "://localhost",
      "://127.0.0.1",
    );
    return u.endsWith("/v1") ? u : `${u}/v1`;
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
          model: selectedModel,
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
        setSelectedModel("");
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

  const getManualConfigs = () => [
    {
      filename: "~/.deepseek/config.toml",
      content: `[providers.openai]\nbase_url = "${getEffectiveBaseUrl()}"\napi_key = "${manualKeyFallback(card.selectedApiKey, cloudEnabled)}"\nmodel = "${selectedModel || "provider/model-id"}"\n`,
    },
  ];

  return (
    <>
      <SetupScaffold
        tool={tool}
        status={deriveToolStatus(tool, card.status)}
        checking={card.checking}
        checkingLabel="Checking DeepSeek TUI..."
        notInstalled={
          !card.checking && status && !status.installed && !status.error ? (
            <NotInstalledBlock
              toolName="DeepSeek TUI"
              onManualConfig={() => card.setShowManualModal(true)}
              installCommand="npm install -g deepseek-tui"
              installHint="After installation, run deepseek to verify."
              guideOpen={card.showInstallGuide}
              onToggleGuide={() => card.setShowInstallGuide((v) => !v)}
            />
          ) : null
        }
        message={card.message}
        onApply={handleApply}
        applyDisabled={!selectedModel}
        applying={card.applying}
        onReset={handleReset}
        resetDisabled={!status?.has9Router}
        resetting={card.restoring}
        onManualConfig={() => card.setShowManualModal(true)}
        fileHint="~/.deepseek/config.toml"
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
        {tool?.notes && tool.notes.length > 0 && (
          <p className="text-xs text-muted">{tool.notes.map((n) => n.text).join(" ")}</p>
        )}
        <SetupRow label="API key">
          <ApiKeySelect
            value={card.selectedApiKey}
            onChange={card.setSelectedApiKey}
            apiKeys={apiKeys}
            cloudEnabled={cloudEnabled}
          />
        </SetupRow>
        <SetupRow label="Model">
          <SingleModelRow
            value={selectedModel}
            onChange={setSelectedModel}
            onPick={() => card.setModalOpen(true)}
            pickDisabled={!activeProviders?.length}
          />
        </SetupRow>
      </SetupScaffold>

      {card.modalOpen && (
        <ModelSelectModal
          isOpen={card.modalOpen}
          onClose={() => card.setModalOpen(false)}
          onSelect={(m) => {
            setSelectedModel(m.value);
            card.setModalOpen(false);
          }}
          selectedModel={selectedModel}
          activeProviders={activeProviders}
          modelAliases={card.modelAliases}
          title="Select model for DeepSeek TUI"
        />
      )}
      <ManualConfigModal
        isOpen={card.showManualModal}
        onClose={() => card.setShowManualModal(false)}
        title="DeepSeek TUI — Manual Configuration"
        configs={getManualConfigs()}
      />
    </>
  );
}

DeepSeekTuiToolCard.propTypes = setupCardPropTypes;
