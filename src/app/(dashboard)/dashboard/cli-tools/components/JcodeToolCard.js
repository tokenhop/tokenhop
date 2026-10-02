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
import { CLIENT_KEY, findClientEntry } from "@/lib/cliToolBrand";
import { buildJcodeConfig, JCODE_DEFAULT_MODEL } from "@/lib/cliToolConfigs/jcode";

const ENDPOINT = "/api/cli-tools/jcode-settings";

/**
 * jcode setup panel. Single default model plus a usage hint.
 * Writes ~/.jcode/config.toml + ~/.config/jcode/provider-<brand>.env.
 */
export default function JcodeToolCard({
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
  const card = useSetupCard({ statusUrl: ENDPOINT, onStatusUpdate, toolId: "jcode" });
  const { status } = card;
  const defaults = useMemo(() => ({ model: JCODE_DEFAULT_MODEL, endpoint: "", apiKeyId: "" }), []);
  // On the host, the installed config fills values the user hasn't saved yet.
  const disk = useMemo(() => {
    if (!status?.installed) return null;
    const provider = findClientEntry(status.config?.providers);
    return {
      model: provider?.default_model || undefined,
      apiKeyId: apiKeys.find((k) => k.key === status.envApiKey)?.id,
    };
  }, [status, apiKeys]);
  const saved = useSetupSettings({ toolId: "jcode", apiKeys, defaults, disk });
  const selectedModel = saved.values.model;
  const setSelectedModel = (v) => saved.setField("model", v);

  const currentBaseUrl = findClientEntry(status?.config?.providers)?.base_url || "";

  const getEffectiveBaseUrl = () => {
    const u = (saved.endpoint || baseUrl || "http://127.0.0.1:20128/v1").replace(
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
          apiKey: resolveApiKey(saved.selectedApiKey, apiKeys, cloudEnabled),
          models: selectedModel ? [selectedModel] : [],
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
      buildJcodeConfig({
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
        checkingLabel="Checking jcode CLI..."
        notInstalled={
          !card.checking && status && !status.installed && !status.error ? (
            <NotInstalledBlock
              toolName="jcode"
              onManualConfig={() => card.setShowManualModal(true)}
              installCommand="curl -fsSL https://raw.githubusercontent.com/1jehuang/jcode/master/scripts/install.sh | bash"
              installHint="jcode is a Rust-based coding agent. Install it to enable automatic configuration."
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
        resetDisabled={!status?.hasTokenhop}
        resetting={card.restoring}
        onManualConfig={() => card.setShowManualModal(true)}
        manualConfigs={getManualConfigs()}
        fileHint="~/.jcode/config.toml"
        {...saved.scaffoldProps("~/.jcode/config.toml")}
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
        <SetupRow label="Default model">
          <SingleModelRow
            value={selectedModel}
            onChange={setSelectedModel}
            onPick={() => card.setModalOpen(true)}
            pickDisabled={!activeProviders?.length}
            placeholder={JCODE_DEFAULT_MODEL}
          />
        </SetupRow>
        <p className="font-mono text-xs text-muted">
          jcode --provider-profile {CLIENT_KEY}
          {selectedModel ? ` --model ${selectedModel}` : ""}
        </p>
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
          title="Select model for jcode"
        />
      )}
      <ManualConfigModal
        isOpen={card.showManualModal}
        onClose={() => card.setShowManualModal(false)}
        title="jcode — Manual Configuration"
        configs={getManualConfigs()}
      />
    </>
  );
}

JcodeToolCard.propTypes = setupCardPropTypes;
