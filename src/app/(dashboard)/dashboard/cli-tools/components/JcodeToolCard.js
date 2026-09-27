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

const ENDPOINT = "/api/cli-tools/jcode-settings";

/**
 * jcode setup panel. Single default model plus a usage hint.
 * Writes ~/.jcode/config.toml + ~/.config/jcode/provider-9router.env.
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
  const [selectedModel, setSelectedModel] = useState("");
  const hasInitializedModel = useRef(false);

  useEffect(() => {
    if (apiKeys?.length > 0 && !card.selectedApiKey) card.setSelectedApiKey(apiKeys[0].key);
  }, [apiKeys, card]);

  useEffect(() => {
    if (status?.installed && !hasInitializedModel.current) {
      hasInitializedModel.current = true;
      const provider = status.config?.providers?.["9router"];
      if (provider) {
        if (provider.default_model) setSelectedModel(provider.default_model);
        const envKey = status.envApiKey;
        if (envKey && apiKeys?.some((k) => k.key === envKey)) card.setSelectedApiKey(envKey);
      }
    }
  }, [status, apiKeys, card]);

  const currentBaseUrl = status?.config?.providers?.["9router"]?.base_url || "";

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
        card.setMessage({ type: "success", text: "Settings reset successfully." });
        setSelectedModel("");
        card.setSelectedApiKey("");
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
    const model = selectedModel || "cc/claude-opus-4-7";
    const toml = `[providers.9router]\ntype = "openai-compatible"\nbase_url = "${getEffectiveBaseUrl()}"\nauth = "bearer"\napi_key_env = "JCODE_9ROUTER_API_KEY"\nenv_file = "provider-9router.env"\ndefault_model = "${model}"\nrequires_api_key = true\n\n[[providers.9router.models]]\nid = "${model}"`;
    return [
      { filename: "~/.jcode/config.toml", content: toml },
      {
        filename: "~/.config/jcode/provider-9router.env",
        content: `JCODE_9ROUTER_API_KEY="${manualKeyFallback(card.selectedApiKey, cloudEnabled)}"`,
      },
    ];
  };

  return (
    <>
      <SetupScaffold
        tool={tool}
        status={deriveToolStatus(tool, card.status)}
        checking={card.checking}
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
        resetDisabled={!status?.has9Router}
        resetting={card.restoring}
        onManualConfig={() => card.setShowManualModal(true)}
        fileHint="~/.jcode/config.toml"
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
        <SetupRow label="Default model">
          <SingleModelRow
            value={selectedModel}
            onChange={setSelectedModel}
            onPick={() => card.setModalOpen(true)}
            pickDisabled={!activeProviders?.length}
            placeholder="cc/claude-opus-4-7"
          />
        </SetupRow>
        <p className="font-mono text-xs text-muted">
          jcode --provider-profile 9router
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
