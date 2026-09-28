"use client";

import { useState } from "react";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
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

const ENDPOINT = "/api/cli-tools/grok-build-settings";
const MODEL_SLOT = "9router";
const SUBAGENT_TYPES = [
  {
    id: "general-purpose",
    label: "General-purpose",
    help: "Implementation, testing, and full-capability delegated tasks",
  },
  { id: "explore", label: "Explore", help: "Read-only codebase research and investigation" },
  { id: "plan", label: "Plan", help: "Architecture and implementation planning" },
];

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
  const [selectedModel, setSelectedModel] = useState(status?.settings?.model?.model || "");
  const [subagentModels, setSubagentModels] = useState(() =>
    Object.fromEntries(
      SUBAGENT_TYPES.map((t) => [t.id, status?.settings?.subagentModels?.[t.id]?.model]).filter(
        ([, m]) => Boolean(m),
      ),
    ),
  );
  const [modelTarget, setModelTarget] = useState(null);

  const hydrate = (next) => {
    setSelectedModel(next?.settings?.model?.model || "");
    setSubagentModels(
      Object.fromEntries(
        SUBAGENT_TYPES.map((t) => [t.id, next?.settings?.subagentModels?.[t.id]?.model]).filter(
          ([, m]) => Boolean(m),
        ),
      ),
    );
  };

  const configuredModel = status?.settings?.model;
  const currentBaseUrl = configuredModel?.base_url || "";

  const getEffectiveBaseUrl = () => {
    const u =
      card.customBaseUrl ||
      baseUrl ||
      (typeof window !== "undefined"
        ? window.location.origin.replace("://localhost", "://127.0.0.1")
        : "http://127.0.0.1:20128");
    return u.endsWith("/v1") ? u : `${u}/v1`;
  };

  const handleApply = async () => {
    card.setApplying(true);
    card.setMessage(null);
    try {
      const mappedSubagents = {};
      for (const t of SUBAGENT_TYPES) {
        const model = subagentModels[t.id]?.trim();
        if (model) mappedSubagents[t.id] = { model, contextWindow: getContextWindow(model) };
      }
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: getEffectiveBaseUrl(),
          apiKey: keyFallback(card.selectedApiKey, apiKeys, cloudEnabled),
          model: selectedModel,
          contextWindow: getContextWindow(selectedModel),
          subagentModels: mappedSubagents,
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
        hydrate(fresh);
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
        setSubagentModels({});
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

  const getManualConfigs = () => {
    const keyToUse = manualKeyFallback(card.selectedApiKey, cloudEnabled);
    const effective = getEffectiveBaseUrl();
    const mainModel = selectedModel || "provider/model-id";
    const blocks = [
      `[models]\ndefault = "${MODEL_SLOT}"`,
      `[model.${MODEL_SLOT}]\nmodel = "${mainModel}"\nbase_url = "${effective}"\nname = "9Router"\ndescription = "Routed via 9Router gateway"\napi_backend = "chat_completions"\napi_key = "${keyToUse}"\ncontext_window = ${getContextWindow(mainModel) || 200000}`,
    ];
    const mappings = [];
    for (const t of SUBAGENT_TYPES) {
      const model = subagentModels[t.id]?.trim();
      if (!model) continue;
      const slot = `${MODEL_SLOT}-${t.id}`;
      mappings.push(`${t.id} = "${slot}"`);
      blocks.push(
        `[model.${slot}]\nmodel = "${model}"\nbase_url = "${effective}"\nname = "9Router ${t.id}"\ndescription = "Routed via 9Router gateway"\napi_backend = "chat_completions"\napi_key = "${keyToUse}"\ncontext_window = ${getContextWindow(model) || 200000}`,
      );
    }
    if (mappings.length) blocks.splice(1, 0, `[subagents.models]\n${mappings.join("\n")}`);
    return [{ filename: "~/.grok/config.toml", content: `${blocks.join("\n\n")}\n` }];
  };

  return (
    <>
      <SetupScaffold
        tool={tool}
        status={deriveToolStatus(tool, card.status)}
        checking={card.checking}
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
        applyDisabled={!selectedModel}
        applying={card.applying}
        onReset={handleReset}
        resetDisabled={!status?.has9Router}
        resetting={card.restoring}
        onManualConfig={() => card.setShowManualModal(true)}
        fileHint="~/.grok/config.toml"
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
        {tool.notes?.length > 0 && (
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
        <SetupRow label="Main model">
          <SingleModelRow
            value={selectedModel}
            onChange={setSelectedModel}
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
                onChange={(val) => setSubagentModels((cur) => ({ ...cur, [t.id]: val }))}
                onPick={() => {
                  setModelTarget(t.id);
                  card.setModalOpen(true);
                }}
                pickDisabled={!activeProviders?.length}
                placeholder={`${selectedModel || "Main model"} (inherit)`}
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
            if (modelTarget === "main") setSelectedModel(m.value);
            else if (modelTarget) setSubagentModels((cur) => ({ ...cur, [modelTarget]: m.value }));
            card.setModalOpen(false);
            setModelTarget(null);
          }}
          selectedModel={modelTarget === "main" ? selectedModel : subagentModels[modelTarget]}
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
        title="Grok Build — Manual Configuration"
        configs={getManualConfigs()}
      />
    </>
  );
}

GrokBuildToolCard.propTypes = setupCardPropTypes;
