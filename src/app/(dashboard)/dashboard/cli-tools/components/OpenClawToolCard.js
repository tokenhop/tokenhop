"use client";

import { useState, useEffect, useRef } from "react";
import {
  useSetupCard,
  setupCardPropTypes,
  resolveApiKey,
  manualApiKey,
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
  toManualConfigs,
} from "./setupCard";
import Button from "@/shared/components/Button";
import IconButton from "@/shared/components/IconButton";
import { findClientEntry, splitModelRef } from "@/lib/cliToolBrand";
import { buildOpenClawConfig } from "@/lib/cliToolConfigs/openclaw";
import { useCliAccessStore } from "@/store/cliAccessStore";

const INPUT_CLASS =
  "h-10 min-w-0 flex-1 rounded-xl border border-line bg-raised px-3 text-sm text-text focus:border-coral focus:shadow-focus focus:outline-none";

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
  // Remotely there is no on-disk agent list; the user adds rows for the snippet.
  const localOnly = useCliAccessStore((s) => s.localOnly);
  const [remoteAgents, setRemoteAgents] = useState([]);
  const [agentDraft, setAgentDraft] = useState({ id: "", agentDir: "" });
  const hasInitializedModel = useRef(false);

  useEffect(() => {
    if (apiKeys?.length > 0 && !card.selectedApiKey) card.setSelectedApiKey(apiKeys[0].key);
  }, [apiKeys, card]);

  useEffect(() => {
    if (status?.installed && !hasInitializedModel.current) {
      hasInitializedModel.current = true;
      const provider = findClientEntry(status.settings?.models?.providers);
      if (provider) {
        const primary = status.settings?.agents?.defaults?.model?.primary;
        if (primary) setSelectedModel(splitModelRef(primary)?.model ?? primary);
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

  const currentBaseUrl = findClientEntry(status?.settings?.models?.providers)?.baseUrl || "";

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
          apiKey: resolveApiKey(card.selectedApiKey, apiKeys, cloudEnabled),
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

  const agents = localOnly ? remoteAgents : (status?.agents || []).filter((a) => a.agentDir);

  const addRemoteAgent = () => {
    const id = agentDraft.id.trim();
    const agentDir = agentDraft.agentDir.trim();
    if (!id || !agentDir) return;
    setRemoteAgents((prev) => [...prev.filter((a) => a.id !== id), { id, agentDir }]);
    setAgentDraft({ id: "", agentDir: "" });
  };

  const removeRemoteAgent = (id) => {
    setRemoteAgents((prev) => prev.filter((a) => a.id !== id));
    setAgentModels(({ [id]: _, ...rest }) => rest);
  };

  const getManualConfigs = () =>
    toManualConfigs(
      buildOpenClawConfig({
        baseUrl: getEffectiveBaseUrl(),
        apiKey: manualApiKey(card.selectedApiKey, apiKeys, cloudEnabled),
        model: selectedModel,
        agents,
        agentModels,
      }),
    );

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
        resetDisabled={!status?.hasTokenhop}
        resetting={card.restoring}
        onManualConfig={() => card.setShowManualModal(true)}
        manualConfigs={getManualConfigs()}
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

        {(agents.length > 0 || localOnly) && (
          <div className="flex flex-col gap-2 pt-2 border-t border-line">
            <span className="text-[13px] font-semibold text-text">Per-agent models</span>
            {agents.map((a) => (
              <SetupRow key={a.id} label={`Agent: ${a.name || a.id}`} hint={a.agentDir}>
                <div className="flex items-center gap-1.5">
                  <div className="min-w-0 flex-1">
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
                  </div>
                  {localOnly && (
                    <IconButton
                      icon="close"
                      label={`Remove agent ${a.id}`}
                      onClick={() => removeRemoteAgent(a.id)}
                    />
                  )}
                </div>
              </SetupRow>
            ))}
            {localOnly && (
              <SetupRow label="Add agent" hint="The id and agentDir from agents.list">
                <div className="flex flex-wrap items-center gap-1.5">
                  <label htmlFor="openclaw-agent-id" className="sr-only">
                    Agent id
                  </label>
                  <input
                    id="openclaw-agent-id"
                    type="text"
                    placeholder="agent id"
                    value={agentDraft.id}
                    onChange={(e) => setAgentDraft((d) => ({ ...d, id: e.target.value }))}
                    className={INPUT_CLASS}
                  />
                  <label htmlFor="openclaw-agent-dir" className="sr-only">
                    Agent dir
                  </label>
                  <input
                    id="openclaw-agent-dir"
                    type="text"
                    placeholder="~/.openclaw/agents/<id>"
                    value={agentDraft.agentDir}
                    onChange={(e) => setAgentDraft((d) => ({ ...d, agentDir: e.target.value }))}
                    className={INPUT_CLASS}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={addRemoteAgent}
                    disabled={!agentDraft.id.trim() || !agentDraft.agentDir.trim()}
                  >
                    Add
                  </Button>
                </div>
              </SetupRow>
            )}
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
