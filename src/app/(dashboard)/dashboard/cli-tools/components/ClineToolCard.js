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
import { buildClineConfig } from "@/lib/cliToolConfigs/cline";

/**
 * Cline setup panel. Single model; writes openAiBaseUrl without trailing
 * /v1 to ~/.cline/data/globalState.json via /api/cli-tools/cline-settings.
 */
export default function ClineToolCard({
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
    statusUrl: "/api/cli-tools/cline-settings",
    onStatusUpdate,
    toolId: "cline",
  });
  const { status } = card;
  const defaults = useMemo(() => ({ model: "", endpoint: "", apiKeyId: "" }), []);
  // On the host, the installed config fills a model the user hasn't saved yet.
  const disk = useMemo(
    () => (status?.installed ? { model: status.settings?.openAiModelId || undefined } : null),
    [status],
  );
  const saved = useSetupSettings({ toolId: "cline", apiKeys, defaults, disk });
  const selectedModel = saved.values.model;
  const setSelectedModel = (v) => saved.setField("model", v);

  const currentBaseUrl = status?.settings?.openAiBaseUrl || "";

  const getEffectiveBaseUrl = () => {
    const u = saved.endpoint || `${baseUrl}/v1`;
    return u.endsWith("/v1") ? u : `${u}/v1`;
  };

  const handleApply = async () => {
    card.setApplying(true);
    card.setMessage(null);
    try {
      const res = await fetch("/api/cli-tools/cline-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: getEffectiveBaseUrl(),
          apiKey: resolveApiKey(saved.selectedApiKey, apiKeys, cloudEnabled),
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
      const res = await fetch("/api/cli-tools/cline-settings", { method: "DELETE" });
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
      buildClineConfig({
        baseUrl: getEffectiveBaseUrl(),
        apiKey: manualApiKey(saved.selectedApiKey, apiKeys, cloudEnabled),
        model: selectedModel,
      }),
    );

  return (
    <>
      <SetupScaffold
        tool={tool}
        status={deriveToolStatus(tool, card.status)}
        checking={card.checking || !saved.loaded}
        checkingLabel="Checking Cline..."
        notInstalled={
          !card.checking && status && !status.installed && !status.error ? (
            <NotInstalledBlock
              toolName="Cline"
              onManualConfig={() => card.setShowManualModal(true)}
              installHint="Install the Cline VS Code extension or CLI from docs.cline.bot."
              guideOpen={card.showInstallGuide}
              onToggleGuide={() => card.setShowInstallGuide((v) => !v)}
              guideBody={
                <p className="text-[13px] text-muted">
                  Install Cline from{" "}
                  <a
                    className="text-coral-ink underline"
                    href="https://docs.cline.bot/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    docs.cline.bot
                  </a>
                  .
                </p>
              }
            />
          ) : null
        }
        message={card.message}
        onApply={handleApply}
        applyDisabled={
          (!saved.selectedApiKey && cloudEnabled && apiKeys.length > 0) || !selectedModel
        }
        applying={card.applying}
        onReset={handleReset}
        resetting={card.restoring}
        onManualConfig={() => card.setShowManualModal(true)}
        manualConfigs={getManualConfigs()}
        fileHint="~/.cline/data/globalState.json"
        {...saved.scaffoldProps("~/.cline/data/globalState.json")}
      >
        <EndpointSegmentedPicker
          key={saved.pickerKey}
          value={saved.endpoint || baseUrl}
          {...saved.pickerProps}
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
            value={saved.selectedApiKey}
            onChange={saved.onApiKeyChange}
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
          title="Select model for Cline"
        />
      )}
      <ManualConfigModal
        isOpen={card.showManualModal}
        onClose={() => card.setShowManualModal(false)}
        title="Cline — Manual configuration"
        configs={getManualConfigs()}
      />
    </>
  );
}

ClineToolCard.propTypes = setupCardPropTypes;
