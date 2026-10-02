"use client";

import { useMemo, useState } from "react";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import {
  useSetupCard,
  useSetupSettings,
  setupCardPropTypes,
  resolveApiKey,
  manualApiKey,
  toManualConfigs,
  asMap,
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
import { buildGrokBuildConfig } from "@/lib/cliToolConfigs/grokBuild";

const ENDPOINT = "/api/cli-tools/grok-build-settings";
const SUBAGENT_TYPES = [
  {
    id: "general-purpose",
    label: "General-purpose",
    help: "Implementation, testing, and full-capability delegated tasks",
  },
  { id: "explore", label: "Explore", help: "Read-only codebase research and investigation" },
  { id: "plan", label: "Plan", help: "Architecture and implementation planning" },
];

const subagentsFromStatus = (status) =>
  Object.fromEntries(
    SUBAGENT_TYPES.map((t) => [t.id, status?.settings?.subagentModels?.[t.id]?.model]).filter(
      ([, m]) => Boolean(m),
    ),
  );

/**
 * Grok Build setup panel: main model + three subagent model overrides with
 * per-model context windows. Writes ~/.grok/config.toml.
 */
export default function GrokBuildToolCard({
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
  const { getCaps } = useModelCaps();
  const getContextWindow = (model) => getCaps(model)?.contextWindow || null;
  const card = useSetupCard({ statusUrl: ENDPOINT, onStatusUpdate, toolId: "grok-build" });
  const { status } = card;
  const [modelTarget, setModelTarget] = useState(null);

  const defaults = useMemo(
    () => ({ model: "", subagentModels: {}, endpoint: "", apiKeyId: "" }),
    [],
  );
  // On the host, the installed config fills values the user hasn't saved yet.
  const disk = useMemo(
    () =>
      status?.installed
        ? {
            model: status.settings?.model?.model || undefined,
            subagentModels: subagentsFromStatus(status),
            apiKeyId:
              apiKeys.find((k) => k.key === status.settings?.model?.api_key)?.id || undefined,
          }
        : null,
    [status, apiKeys],
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
  const setup = useSetupSettings({
    toolId: "grok-build",
    apiKeys,
    defaults,
    disk,
    endpointContext,
  });
  const subagentModels = asMap(setup.values.subagentModels);

  const currentBaseUrl = status?.settings?.model?.base_url || "";

  const getEffectiveBaseUrl = () => {
    const u =
      setup.endpoint ||
      baseUrl ||
      (typeof window !== "undefined"
        ? window.location.origin.replace("://localhost", "://127.0.0.1")
        : "http://127.0.0.1:20128");
    return u.endsWith("/v1") ? u : `${u}/v1`;
  };

  const mapSubagents = () => {
    const mapped = {};
    for (const t of SUBAGENT_TYPES) {
      const model = subagentModels[t.id]?.trim();
      if (model) mapped[t.id] = { model, contextWindow: getContextWindow(model) };
    }
    return mapped;
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
          apiKey: resolveApiKey(setup.selectedApiKey, apiKeys, cloudEnabled),
          model: setup.model,
          contextWindow: getContextWindow(setup.model),
          subagentModels: mapSubagents(),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        rememberEndpoint(getEffectiveBaseUrl(), { tunnelPublicUrl, tailscaleUrl });
        card.setMessage({
          type: "success",
          text: "Main and subagent models applied successfully.",
        });
        const fresh = await (await fetch(ENDPOINT)).json();
        card.setStatus(fresh);
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
        const fresh = await (await fetch(ENDPOINT)).json();
        card.setStatus(fresh);
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
      buildGrokBuildConfig({
        baseUrl: getEffectiveBaseUrl(),
        apiKey: manualApiKey(setup.selectedApiKey, apiKeys, cloudEnabled),
        model: setup.model,
        contextWindow: getContextWindow(setup.model),
        subagentModels: mapSubagents(),
      }),
    );

  return (
    <>
      <SetupScaffold
        tool={tool}
        status={deriveToolStatus(tool, card.status)}
        checking={card.checking || !setup.loaded}
        checkingLabel="Checking Grok Build..."
        notInstalled={
          !card.checking && status && !status.installed && !status.error ? (
            <NotInstalledBlock
              toolName="Grok Build"
              onManualConfig={() => card.setShowManualModal(true)}
              installCommand="curl -fsSL https://x.ai/cli/install.sh | bash"
              guideOpen={card.showInstallGuide}
              onToggleGuide={() => card.setShowInstallGuide((v) => !v)}
            />
          ) : null
        }
        message={card.message}
        onApply={handleApply}
        applyDisabled={!setup.model}
        applying={card.applying}
        onReset={handleReset}
        resetDisabled={!status?.hasTokenhop}
        resetting={card.restoring}
        onManualConfig={() => card.setShowManualModal(true)}
        manualConfigs={getManualConfigs()}
        fileHint="~/.grok/config.toml"
        {...setup.scaffoldProps("~/.grok/config.toml")}
      >
        <EndpointSegmentedPicker
          key={setup.pickerKey}
          value={setup.endpoint || baseUrl}
          {...setup.pickerProps}
          currentUrl={currentBaseUrl}
        />
        {tool.notes?.length > 0 && (
          <p className="text-xs text-muted">{tool.notes.map((n) => n.text).join(" ")}</p>
        )}
        <SetupRow label="API key">
          <ApiKeySelect
            value={setup.selectedApiKey}
            onChange={setup.onApiKeyChange}
            apiKeys={apiKeys}
            cloudEnabled={cloudEnabled}
          />
        </SetupRow>
        <SetupRow label="Main model">
          <SingleModelRow
            value={setup.model}
            onChange={setup.setModel}
            onPick={() => {
              setModelTarget("main");
              card.setModalOpen(true);
            }}
            pickDisabled={!activeProviders?.length}
          />
        </SetupRow>

        <div className="flex flex-col gap-2 pt-2 border-t border-line">
          <span className="text-[13px] font-semibold text-text">Subagent model overrides</span>
          <p className="text-xs text-muted">
            Leave blank to inherit the main model. Each override keeps its own context window.
          </p>
          {SUBAGENT_TYPES.map((t) => (
            <SetupRow key={t.id} label={t.label} hint={t.help}>
              <SingleModelRow
                value={subagentModels[t.id] || ""}
                onChange={(val) =>
                  setup.setField("subagentModels", { ...subagentModels, [t.id]: val })
                }
                onPick={() => {
                  setModelTarget(t.id);
                  card.setModalOpen(true);
                }}
                pickDisabled={!activeProviders?.length}
                placeholder={`${setup.model || "Main model"} (inherit)`}
              />
            </SetupRow>
          ))}
        </div>
      </SetupScaffold>

      {card.modalOpen && (
        <ModelSelectModal
          isOpen={card.modalOpen}
          onClose={() => {
            card.setModalOpen(false);
            setModelTarget(null);
          }}
          onSelect={(m) => {
            if (modelTarget === "main") setup.setModel(m.value);
            else if (modelTarget)
              setup.setField("subagentModels", { ...subagentModels, [modelTarget]: m.value });
            card.setModalOpen(false);
            setModelTarget(null);
          }}
          selectedModel={modelTarget === "main" ? setup.model : subagentModels[modelTarget]}
          activeProviders={activeProviders}
          modelAliases={card.modelAliases}
          title={
            modelTarget === "main"
              ? "Select main model for Grok Build"
              : `Select ${modelTarget} model`
          }
        />
      )}
      <ManualConfigModal
        isOpen={card.showManualModal}
        onClose={() => card.setShowManualModal(false)}
        title="Grok Build — Manual configuration"
        configs={getManualConfigs()}
      />
    </>
  );
}

GrokBuildToolCard.propTypes = setupCardPropTypes;
