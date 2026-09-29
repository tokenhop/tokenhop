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

const ENDPOINT = "/api/cli-tools/openclaw-settings";

/**
 * Open Claw setup panel: primary model + optional per-agent overrides.
 * Writes ~/.openclaw/openclaw.json via /api/cli-tools/openclaw-settings.
 */
export default function OpenClawToolCard({
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
  const card = useSetupCard({ statusUrl: ENDPOINT, onStatusUpdate, toolId: "openclaw" });
  const { status } = card;
  const [selectedModel, setSelectedModel] = useState("");
  const [agentModels, setAgentModels] = useState({});
  const [agentModalFor, setAgentModalFor] = useState(null);
  const hasInitializedModel = useRef(false);

  useEffect(() => {
    if (apiKeys?.length > 0 && !card.selectedApiKey) card.setSelectedApiKey(apiKeys[0].key);
  }, [apiKeys, card]);

  useEffect(() => {
    if (status?.installed && !hasInitializedModel.current) {
      hasInitializedModel.current = true;
      const provider = status.settings?.models?.providers?.["9router"];
      if (provider) {
        const primary = status.settings?.agents?.defaults?.model?.primary;
        if (primary) setSelectedModel(primary.replace("9router/", ""));
        if (provider.apiKey && apiKeys?.some((k) => k.key === provider.apiKey)) {
          card.setSelectedApiKey(provider.apiKey);
        }
      }
      const initAgents = {};
      (status.agents || []).forEach((a) => {
        if (a.currentModel) initAgents[a.id] = a.currentModel;
      });
      setAgentModels(initAgents);
    }
  }, [status, apiKeys, card]);

  const currentBaseUrl = status?.settings?.models?.providers?.["9router"]?.baseUrl || "";

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
          agentModels,
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
        setAgentModels({});
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

  const agents = (status?.agents || []).filter((a) => a.agentDir);

  const getManualConfigs = () => {
    const keyToUse = manualKeyFallback(card.selectedApiKey, cloudEnabled);
    const content = {
      agents: {
        defaults: {
          model: { primary: `9router/${selectedModel || "provider/model-id"}` },
        },
      },
      models: {
        providers: {
          "9router": {
            baseUrl: getEffectiveBaseUrl(),
            apiKey: keyToUse,
            api: "openai-completions",
            models: [
              {
                id: selectedModel || "provider/model-id",
                name: (selectedModel || "provider/model-id").split("/").pop(),
              },
            ],
          },
        },
      },
    };
    return [{ filename: "~/.openclaw/openclaw.json", content: JSON.stringify(content, null, 2) }];
  };

  return (
    <>
      <SetupScaffold
        tool={tool}
        status={deriveToolStatus(tool, card.status)}
        checking={card.checking}
        checkingLabel="Checking Open Claw CLI..."
        notInstalled={
          !card.checking && status && !status.installed && !status.error ? (
            <NotInstalledBlock
              toolName="Open Claw"
              onManualConfig={() => card.setShowManualModal(true)}
              installHint="Open Claw runs as an agent CLI — install it and return here."
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
        fileHint="~/.openclaw/openclaw.json"
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
        <SetupRow label="Primary model">
          <SingleModelRow
            value={selectedModel}
            onChange={setSelectedModel}
            onPick={() => {
              setAgentModalFor(null);
              card.setModalOpen(true);
            }}
            pickDisabled={!activeProviders?.length}
          />
        </SetupRow>

        {agents.length > 0 && (
          <div className="flex flex-col gap-2 pt-2 border-t border-line">
            <span className="text-[13px] font-semibold text-text">Per-agent models</span>
            {agents.map((a) => (
              <SetupRow key={a.id} label={`Agent: ${a.name || a.id}`}>
                <SingleModelRow
                  value={agentModels[a.id]}
                  onChange={(val) => setAgentModels((prev) => ({ ...prev, [a.id]: val }))}
                  onPick={() => {
                    setAgentModalFor(a.id);
                    card.setModalOpen(true);
                  }}
                  pickDisabled={!activeProviders?.length}
                  placeholder={`default (${selectedModel || "provider/model-id"})`}
                />
              </SetupRow>
            ))}
          </div>
        )}
      </SetupScaffold>

      {card.modalOpen && (
        <ModelSelectModal
          isOpen={card.modalOpen}
          onClose={() => {
            card.setModalOpen(false);
            setAgentModalFor(null);
          }}
          onSelect={(m) => {
            if (agentModalFor) {
              setAgentModels((prev) => ({ ...prev, [agentModalFor]: m.value }));
            } else {
              setSelectedModel(m.value);
            }
            card.setModalOpen(false);
            setAgentModalFor(null);
          }}
          selectedModel={agentModalFor ? agentModels[agentModalFor] : selectedModel}
          activeProviders={activeProviders}
          modelAliases={card.modelAliases}
          title={
            agentModalFor ? `Select model for agent ${agentModalFor}` : "Select model for Open Claw"
          }
        />
      )}
      <ManualConfigModal
        isOpen={card.showManualModal}
        onClose={() => card.setShowManualModal(false)}
        title="Open Claw — Manual configuration"
        configs={getManualConfigs()}
      />
    </>
  );
}

OpenClawToolCard.propTypes = setupCardPropTypes;
