"use client";

import { useState, useEffect } from "react";
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
import { buildCodexConfig } from "@/lib/cliToolConfigs/codex";

/**
 * Codex CLI setup panel. Single model + subagent model override.
 * Writes ~/.codex/config.toml via /api/cli-tools/codex-settings.
 */
export default function CodexToolCard({
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
  const card = useSetupCard({
    statusUrl: "/api/cli-tools/codex-settings",
    onStatusUpdate,
    toolId: "codex",
  });
  const { status } = card;
  const [selectedModel, setSelectedModel] = useState("");
  const [subagentModel, setSubagentModel] = useState("");
  const [subagentModalOpen, setSubagentModalOpen] = useState(false);

  useEffect(() => {
    if (apiKeys?.length > 0 && !card.selectedApiKey) card.setSelectedApiKey(apiKeys[0].key);
  }, [apiKeys, card]);

  useEffect(() => {
    if (status?.config) {
      const modelMatch = status.config.match(/^model\s*=\s*"([^"]+)"/m);
      if (modelMatch) setSelectedModel(modelMatch[1]);
      const subMatch = status.config.match(/^default_subagent_model\s*=\s*"([^"]+)"/m);
      if (subMatch) setSubagentModel(subMatch[1]);
    }
  }, [status]);

  const currentBaseUrl = status?.config?.match(/base_url\s*=\s*"([^"]+)"/)?.[1] || "";

  const getEffectiveBaseUrl = () => {
    const u = card.customBaseUrl || `${baseUrl}/v1`;
    return u.endsWith("/v1") ? u : `${u}/v1`;
  };

  const handleApply = async () => {
    card.setApplying(true);
    card.setMessage(null);
    try {
      const keyToUse = resolveApiKey(card.selectedApiKey, apiKeys, cloudEnabled);
      const res = await fetch("/api/cli-tools/codex-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: getEffectiveBaseUrl(),
          apiKey: keyToUse,
          model: selectedModel,
          subagentModel: subagentModel || selectedModel,
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
      const res = await fetch("/api/cli-tools/codex-settings", { method: "DELETE" });
      const data = await res.json();
      if (res.ok) {
        card.setMessage({ type: "success", text: "Settings reset successfully." });
        setSelectedModel("");
        setSubagentModel("");
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
      buildCodexConfig({
        baseUrl: getEffectiveBaseUrl(),
        apiKey: manualApiKey(card.selectedApiKey, apiKeys, cloudEnabled),
        model: selectedModel,
        subagentModel: subagentModel || selectedModel,
      }),
    );

  return (
    <>
      <SetupScaffold
        tool={tool}
        status={deriveToolStatus(tool, card.status)}
        checking={card.checking}
        checkingLabel="Checking Codex CLI..."
        notInstalled={
          !card.checking && status && !status.installed && !status.error ? (
            <NotInstalledBlock
              toolName="Codex CLI"
              onManualConfig={() => card.setShowManualModal(true)}
              installCommand="npm install -g @openai/codex"
              installHint="Codex reads custom providers from ~/.codex/config.toml. Run codex to verify."
              guideOpen={card.showInstallGuide}
              onToggleGuide={() => card.setShowInstallGuide((v) => !v)}
            />
          ) : null
        }
        message={card.message}
        onApply={handleApply}
        applyDisabled={
          (!card.selectedApiKey && cloudEnabled && apiKeys.length > 0) || !selectedModel
        }
        applying={card.applying}
        onReset={handleReset}
        resetting={card.restoring}
        onManualConfig={() => card.setShowManualModal(true)}
        manualConfigs={getManualConfigs()}
        fileHint="~/.codex/config.toml"
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
        <SetupRow label="Model">
          <SingleModelRow
            value={selectedModel}
            onChange={setSelectedModel}
            onPick={() => card.setModalOpen(true)}
            pickDisabled={!activeProviders?.length}
          />
        </SetupRow>
        <SetupRow label="Subagent model">
          <SingleModelRow
            value={subagentModel}
            onChange={setSubagentModel}
            onPick={() => setSubagentModalOpen(true)}
            pickDisabled={!activeProviders?.length}
            placeholder={selectedModel || "provider/model-id (defaults to main model)"}
          />
        </SetupRow>
      </SetupScaffold>

      {card.modalOpen && (
        <ModelSelectModal
          isOpen={card.modalOpen}
          onClose={() => card.setModalOpen(false)}
          onSelect={(m) => {
            setSelectedModel(m.value);
            if (!subagentModel) setSubagentModel(m.value);
            card.setModalOpen(false);
          }}
          selectedModel={selectedModel}
          activeProviders={activeProviders}
          modelAliases={card.modelAliases}
          title="Select model for Codex"
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
          title="Select subagent model for Codex"
        />
      )}
      <ManualConfigModal
        isOpen={card.showManualModal}
        onClose={() => card.setShowManualModal(false)}
        title="Codex CLI — Manual configuration"
        configs={getManualConfigs()}
      />
    </>
  );
}

CodexToolCard.propTypes = setupCardPropTypes;
