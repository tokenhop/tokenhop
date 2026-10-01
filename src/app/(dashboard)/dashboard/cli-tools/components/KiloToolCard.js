"use client";

import { useState, useEffect } from "react";
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

/**
 * Kilo Code setup panel. Single model; status is binary (hasTokenhop).
 * Writes ~/.local/share/kilo/auth.json via /api/cli-tools/kilo-settings.
 */
export default function KiloToolCard({
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
    statusUrl: "/api/cli-tools/kilo-settings",
    onStatusUpdate,
    toolId: "kilo",
  });
  const { status } = card;
  const [selectedModel, setSelectedModel] = useState("");

  useEffect(() => {
    if (apiKeys?.length > 0 && !card.selectedApiKey) card.setSelectedApiKey(apiKeys[0].key);
  }, [apiKeys, card]);

  const getEffectiveBaseUrl = () => {
    const u = card.customBaseUrl || `${baseUrl}/v1`;
    return u.endsWith("/v1") ? u : `${u}/v1`;
  };

  const handleApply = async () => {
    card.setApplying(true);
    card.setMessage(null);
    try {
      const res = await fetch("/api/cli-tools/kilo-settings", {
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
      const res = await fetch("/api/cli-tools/kilo-settings", { method: "DELETE" });
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
      filename: "~/.local/share/kilo/auth.json",
      content: JSON.stringify(
        {
          "openai-compatible": {
            type: "api-key",
            apiKey: manualKeyFallback(card.selectedApiKey, cloudEnabled),
            baseUrl: getEffectiveBaseUrl(),
            model: selectedModel || "provider/model-id",
          },
        },
        null,
        2,
      ),
    },
  ];

  return (
    <>
      <SetupScaffold
        tool={tool}
        status={deriveToolStatus(tool, card.status)}
        checking={card.checking}
        checkingLabel="Checking Kilo Code..."
        notInstalled={
          !card.checking && status && !status.installed && !status.error ? (
            <NotInstalledBlock
              toolName="Kilo Code"
              onManualConfig={() => card.setShowManualModal(true)}
              installHint="Install Kilo Code from kilocode.ai or the VS Code extension marketplace."
              guideOpen={card.showInstallGuide}
              onToggleGuide={() => card.setShowInstallGuide((v) => !v)}
              guideBody={
                <p className="text-[13px] text-muted">
                  Install Kilo Code from{" "}
                  <a
                    className="text-coral-ink underline"
                    href="https://kilocode.ai"
                    target="_blank"
                    rel="noreferrer"
                  >
                    kilocode.ai
                  </a>{" "}
                  or the VS Code extension marketplace.
                </p>
              }
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
        fileHint="~/.local/share/kilo/auth.json"
      >
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
          title="Select model for Kilo Code"
        />
      )}
      <ManualConfigModal
        isOpen={card.showManualModal}
        onClose={() => card.setShowManualModal(false)}
        title="Kilo Code — Manual configuration"
        configs={getManualConfigs()}
      />
    </>
  );
}

KiloToolCard.propTypes = setupCardPropTypes;
