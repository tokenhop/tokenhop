"use client";

import { useMemo, useState } from "react";
import {
  useSetupCard,
  useSetupSettings,
  asMap,
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
  hashedContext = false,
}) {
  const card = useSetupCard({ statusUrl: ENDPOINT, onStatusUpdate, toolId: "openclaw" });
  const { status } = card;
  // YAN-363: this route reports storage/credentialConfigured directly; the
  // shared context only breaks ties. Hashed: pasted key or omission — the
  // server preserves the disk credential for an unchanged destination.
  const hashed = status?.storage === "hashed" || hashedContext;
  const [agentModalFor, setAgentModalFor] = useState(null);
  // Remotely there is no on-disk agent list; the user adds rows for the snippet.
  const localOnly = useCliAccessStore((s) => s.localOnly);
  const [agentDraft, setAgentDraft] = useState({ id: "", agentDir: "" });
  const defaults = useMemo(
    () => ({ model: "", agentModels: {}, remoteAgents: {}, endpoint: "", apiKeyId: "" }),
    [],
  );
  // On the host, the installed config fills fields the user hasn't saved yet.
  const disk = useMemo(() => {
    if (!status?.installed) return null;
    const provider = findClientEntry(status.settings?.models?.providers);
    const primary = status.settings?.agents?.defaults?.model?.primary;
    const fromAgents = {};
    for (const a of status.agents || []) {
      if (a.currentModel) fromAgents[a.id] = a.currentModel;
    }
    return {
      model: provider && primary ? (splitModelRef(primary)?.model ?? primary) : undefined,
      apiKeyId: provider?.apiKey ? apiKeys.find((k) => k.key === provider.apiKey)?.id : undefined,
      agentModels: Object.keys(fromAgents).length ? fromAgents : undefined,
    };
  }, [status, apiKeys]);
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
  const setup = useSetupSettings({ toolId: "openclaw", apiKeys, defaults, disk, endpointContext });
  const selectedModel = setup.model;
  const agentModels = asMap(setup.values.agentModels);
  const remoteAgents = asMap(setup.values.remoteAgents);

  const currentBaseUrl = findClientEntry(status?.settings?.models?.providers)?.baseUrl || "";

  const getEffectiveBaseUrl = () => {
    const u = (setup.endpoint || baseUrl || "http://127.0.0.1:20128/v1").replace(
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
          apiKey: resolveApiKey(setup.selectedApiKey, apiKeys, cloudEnabled, { hashed }),
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

  const agents = localOnly
    ? Object.entries(remoteAgents).map(([id, agentDir]) => ({ id, agentDir }))
    : (status?.agents || []).filter((a) => a.agentDir);

  const addRemoteAgent = () => {
    const id = agentDraft.id.trim();
    const agentDir = agentDraft.agentDir.trim();
    if (!id || !agentDir) return;
    setup.setField("remoteAgents", { ...remoteAgents, [id]: agentDir });
    setAgentDraft({ id: "", agentDir: "" });
  };

  const removeRemoteAgent = (id) => {
    const { [id]: _agent, ...rest } = remoteAgents;
    const { [id]: _model, ...restModels } = agentModels;
    setup.setFields({ remoteAgents: rest, agentModels: restModels });
  };

  const getManualConfigs = () =>
    toManualConfigs(
      buildOpenClawConfig({
        baseUrl: getEffectiveBaseUrl(),
        apiKey: manualApiKey(setup.selectedApiKey, apiKeys, cloudEnabled, { hashed }),
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
        checking={card.checking || !setup.loaded}
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
        {...setup.scaffoldProps("~/.openclaw/openclaw.json")}
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
            hashed={hashed}
            existingConfigured={Boolean(status?.credentialConfigured)}
          />
          {hashed && !setup.selectedApiKey?.trim() && (
            <span className="text-[11px] text-subtle">
              Manual configuration needs a pasted key — a stored one can't be shown.
            </span>
          )}
        </SetupRow>
        <SetupRow label="Primary model">
          <SingleModelRow
            value={selectedModel}
            onChange={setup.setModel}
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
                      onChange={(val) =>
                        setup.setField("agentModels", { ...agentModels, [a.id]: val })
                      }
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
              setup.setField("agentModels", { ...agentModels, [agentModalFor]: m.value });
            } else {
              setup.setModel(m.value);
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
