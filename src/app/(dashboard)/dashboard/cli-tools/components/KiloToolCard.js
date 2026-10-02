"use client";

import { useMemo } from "react";
import {
  useSetupCard,
  useSetupSettings,
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
import { buildKiloConfig } from "@/lib/cliToolConfigs/kilo";

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
  const defaults = useMemo(() => ({ model: "", endpoint: "", apiKeyId: "" }), []);
  const setup = useSetupSettings({ toolId: "kilo", apiKeys, defaults });

  const getEffectiveBaseUrl = () => {
    const u = setup.endpoint || `${baseUrl}/v1`;
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
          apiKey: resolveApiKey(setup.selectedApiKey, apiKeys, cloudEnabled),
          model: setup.model,
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
        // Saved card preferences stay; "Reset to defaults" clears those.
        card.setMessage({ type: "success", text: "Settings reset successfully." });
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
      buildKiloConfig({
        baseUrl: getEffectiveBaseUrl(),
        apiKey: manualApiKey(setup.selectedApiKey, apiKeys, cloudEnabled),
        model: setup.model,
      }),
    );

  return (
    <>
      <SetupScaffold
        tool={tool}
        status={deriveToolStatus(tool, card.status)}
        checking={card.checking || !setup.loaded}
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
          (!setup.selectedApiKey && cloudEnabled && apiKeys.length > 0) || !setup.model
        }
        applying={card.applying}
        onReset={handleReset}
        resetting={card.restoring}
        onManualConfig={() => card.setShowManualModal(true)}
        manualConfigs={getManualConfigs()}
        fileHint="~/.local/share/kilo/auth.json"
        {...setup.scaffoldProps("~/.local/share/kilo/auth.json")}
      >
        <EndpointSegmentedPicker
          key={setup.pickerKey}
          value={setup.endpoint || baseUrl}
          {...setup.pickerProps}
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
            value={setup.selectedApiKey}
            onChange={setup.onApiKeyChange}
            apiKeys={apiKeys}
            cloudEnabled={cloudEnabled}
          />
        </SetupRow>
        <SetupRow label="Model">
          <SingleModelRow
            value={setup.model}
            onChange={setup.setModel}
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
            setup.setModel(m.value);
            card.setModalOpen(false);
          }}
          selectedModel={setup.model}
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
