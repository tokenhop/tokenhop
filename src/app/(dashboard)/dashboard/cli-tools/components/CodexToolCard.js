"use client";

import { useMemo, useState } from "react";
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
  const [subagentModalOpen, setSubagentModalOpen] = useState(false);

  const defaults = useMemo(
    () => ({ model: "", subagentModel: "", endpoint: "", apiKeyId: "" }),
    [],
  );
  // On the host, the installed config fills values the user hasn't saved yet.
  const disk = useMemo(
    () =>
      status?.installed
        ? {
            model: status.config?.match(/^model\s*=\s*"([^"]+)"/m)?.[1] || undefined,
            subagentModel:
              status.config?.match(/^default_subagent_model\s*=\s*"([^"]+)"/m)?.[1] || undefined,
          }
        : null,
    [status],
  );
  const endpointContext = useMemo(
    () => ({
      tunnelEnabled,
      tunnelPublicUrl,
      tailscaleEnabled,
      tailscaleUrl,
      cloudEnabled,
      cloudUrl,
      requiresExternalUrl: tool.requiresExternalUrl,
    }),
    [
      tunnelEnabled,
      tunnelPublicUrl,
      tailscaleEnabled,
      tailscaleUrl,
      cloudEnabled,
      cloudUrl,
      tool.requiresExternalUrl,
    ],
  );
  const setup = useSetupSettings({ toolId: "codex", apiKeys, defaults, disk, endpointContext });
  const subagentModel =
    typeof setup.values.subagentModel === "string" ? setup.values.subagentModel : "";

  const currentBaseUrl = status?.config?.match(/base_url\s*=\s*"([^"]+)"/)?.[1] || "";

  const getEffectiveBaseUrl = () => {
    const u = setup.endpoint || `${baseUrl}/v1`;
    return u.endsWith("/v1") ? u : `${u}/v1`;
  };

  const handleApply = async () => {
    card.setApplying(true);
    card.setMessage(null);
    try {
      const keyToUse = resolveApiKey(setup.selectedApiKey, apiKeys, cloudEnabled);
      const res = await fetch("/api/cli-tools/codex-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: getEffectiveBaseUrl(),
          apiKey: keyToUse,
          model: setup.model,
          subagentModel: subagentModel || setup.model,
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
      buildCodexConfig({
        baseUrl: getEffectiveBaseUrl(),
        apiKey: manualApiKey(setup.selectedApiKey, apiKeys, cloudEnabled),
        model: setup.model,
        subagentModel: subagentModel || setup.model,
      }),
    );

  return (
    <>
      <SetupScaffold
        tool={tool}
        status={deriveToolStatus(tool, card.status)}
        checking={card.checking || !setup.loaded}
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
          (!setup.selectedApiKey && cloudEnabled && apiKeys.length > 0) || !setup.model
        }
        applying={card.applying}
        onReset={handleReset}
        resetting={card.restoring}
        onManualConfig={() => card.setShowManualModal(true)}
        manualConfigs={getManualConfigs()}
        fileHint="~/.codex/config.toml"
        {...setup.scaffoldProps("~/.codex/config.toml")}
      >
        <EndpointSegmentedPicker
          key={setup.pickerKey}
          value={setup.endpoint || baseUrl}
          {...setup.pickerProps}
          currentUrl={currentBaseUrl}
        />
        {currentBaseUrl && (
          <SetupRow label="Current" hint={currentBaseUrl}>
            <span className="truncate font-mono text-xs text-muted">{currentBaseUrl}</span>
          </SetupRow>
        )}
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
        <SetupRow label="Subagent model">
          <SingleModelRow
            value={subagentModel}
            onChange={(v) => setup.setField("subagentModel", v)}
            onPick={() => setSubagentModalOpen(true)}
            pickDisabled={!activeProviders?.length}
            placeholder={setup.model || "provider/model-id (defaults to main model)"}
          />
        </SetupRow>
      </SetupScaffold>

      {card.modalOpen && (
        <ModelSelectModal
          isOpen={card.modalOpen}
          onClose={() => card.setModalOpen(false)}
          onSelect={(m) => {
            setup.setFields({
              model: m.value,
              ...(subagentModel ? {} : { subagentModel: m.value }),
            });
            card.setModalOpen(false);
          }}
          selectedModel={setup.model}
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
            setup.setField("subagentModel", m.value);
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
