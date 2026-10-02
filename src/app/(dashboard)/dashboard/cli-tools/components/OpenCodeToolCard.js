"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useCliAccessStore } from "@/store/cliAccessStore";
import { flushToolSettings } from "@/store/toolSettingsStore";
import {
  useSetupCard,
  useSetupSettings,
  asList,
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
import { findClientEntry, splitModelRef } from "@/lib/cliToolBrand";
import { buildOpenCodeConfig } from "@/lib/cliToolConfigs/opencode";

const ENDPOINT = "/api/cli-tools/opencode-settings";
const FILE_HINT = "~/.config/opencode/opencode.json";

/**
 * OpenCode setup panel: multi-model list with an active model plus subagent.
 * Writes ~/.config/opencode/opencode.json. Selecting the active chip writes
 * through immediately (PATCH clear-active / DELETE per-model), matching the
 * Apply POST for the shared config shape. Fields persist via `useSetupSettings`
 * (saved wins, then on-disk, then defaults); the DB write goes out before the
 * immediate file POST.
 */
export default function OpenCodeToolCard({
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
  const card = useSetupCard({ statusUrl: ENDPOINT, onStatusUpdate, toolId: "opencode" });
  const { status } = card;
  const [subagentModalOpen, setSubagentModalOpen] = useState(false);
  const selectedModelsRef = useRef([]);

  const defaults = useMemo(
    () => ({ models: [], activeModel: "", subagentModel: "", endpoint: "", apiKeyId: "" }),
    [],
  );
  // On the host, the installed config fills values the user hasn't saved yet.
  const disk = useMemo(() => {
    if (!status?.installed) return null;
    const rawKey = findClientEntry(status.config?.provider)?.options?.apiKey;
    return {
      models: status.opencode?.models?.length ? [...status.opencode.models] : undefined,
      activeModel: status.opencode?.activeModel || undefined,
      subagentModel: splitModelRef(status.config?.agent?.explorer?.model)?.model || undefined,
      apiKeyId: apiKeys.find((k) => k.key === rawKey)?.id,
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
  const setup = useSetupSettings({ toolId: "opencode", apiKeys, defaults, disk, endpointContext });

  const models = asList(setup.values.models);
  const activeModel = typeof setup.values.activeModel === "string" ? setup.values.activeModel : "";
  const subagentModel =
    typeof setup.values.subagentModel === "string" ? setup.values.subagentModel : "";

  useEffect(() => {
    selectedModelsRef.current = models;
  }, [models]);

  const currentBaseUrl = findClientEntry(status?.config?.provider)?.options?.baseURL || "";

  const getEffectiveBaseUrl = () => {
    const u = setup.endpoint || baseUrl || "http://localhost:20128/v1";
    return u.endsWith("/v1") ? u : `${u}/v1`;
  };

  const postModels = async (nextModels, explicitActive) => {
    const validActive =
      explicitActive ?? (nextModels.includes(activeModel) ? activeModel : nextModels[0] || "");
    await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: getEffectiveBaseUrl(),
        apiKey: resolveApiKey(setup.selectedApiKey, apiKeys, cloudEnabled),
        models: nextModels,
        activeModel: validActive,
        subagentModel,
      }),
    }).catch(() => {});
  };

  // Remotely these routes answer 403; edits only shape the manual snippet.
  const isLocalOnly = () => useCliAccessStore.getState().localOnly;

  const clearActiveModel = async () => {
    if (isLocalOnly()) return setup.setField("activeModel", "");
    setup.setField("activeModel", "");
    try {
      const res = await fetch(ENDPOINT, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clearActiveModel: true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to clear active model.");
      }
      card.fetchStatus();
    } catch (err) {
      card.setMessage({ type: "error", text: err.message });
    }
  };

  const dropModel = (model) => {
    const next = models.filter((m) => m !== model);
    setup.setFields({
      models: next,
      ...(activeModel === model ? { activeModel: next[0] || "" } : {}),
    });
  };

  const removeServerModel = async (model) => {
    if (isLocalOnly()) return dropModel(model);
    dropModel(model);
    try {
      const res = await fetch(`${ENDPOINT}?model=${encodeURIComponent(model)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to remove model.");
      }
      card.fetchStatus();
    } catch (err) {
      card.setMessage({ type: "error", text: err.message });
    }
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
          models,
          activeModel: activeModel === "" ? "" : activeModel || models[0],
          subagentModel,
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
      buildOpenCodeConfig({
        baseUrl: getEffectiveBaseUrl(),
        apiKey: manualApiKey(setup.selectedApiKey, apiKeys, cloudEnabled),
        models,
        activeModel: activeModel === "" ? "" : activeModel || models[0],
        subagentModel,
      }),
    );

  return (
    <>
      <SetupScaffold
        tool={tool}
        status={deriveToolStatus(tool, card.status)}
        checking={card.checking || !setup.loaded}
        checkingLabel="Checking OpenCode CLI..."
        notInstalled={
          !card.checking && status && !status.installed && !status.error ? (
            <NotInstalledBlock
              toolName="OpenCode"
              onManualConfig={() => card.setShowManualModal(true)}
              installCommand="npm install -g opencode-ai"
              installHint="macOS / Linux. After installation, run opencode to verify."
              guideOpen={card.showInstallGuide}
              onToggleGuide={() => card.setShowInstallGuide((v) => !v)}
            />
          ) : null
        }
        message={card.message}
        onApply={handleApply}
        applyDisabled={models.length === 0}
        applying={card.applying}
        onReset={handleReset}
        resetDisabled={!status?.hasTokenhop}
        resetting={card.restoring}
        onManualConfig={() => card.setShowManualModal(true)}
        manualConfigs={getManualConfigs()}
        fileHint={FILE_HINT}
        {...setup.scaffoldProps(FILE_HINT)}
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
        <SetupRow
          label="Models"
          hint={
            models.length > 0 && activeModel
              ? `active: ${activeModel}`
              : "click a model to set/clear active"
          }
        >
          <div className="flex flex-col gap-1.5">
            <div
              className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-xl border border-line bg-raised px-2 py-1.5"
              role="listbox"
              aria-label="Selected models"
            >
              {models.length === 0 ? (
                <span className="text-xs text-muted">No models selected</span>
              ) : (
                models.map((m) => (
                  <span
                    key={m}
                    role="option"
                    aria-selected={m === activeModel}
                    tabIndex={0}
                    onClick={() =>
                      m === activeModel ? clearActiveModel() : setup.setField("activeModel", m)
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        if (m === activeModel) clearActiveModel();
                        else setup.setField("activeModel", m);
                      }
                    }}
                    title={
                      m === activeModel ? "Click to clear active model" : "Click to set as active"
                    }
                    className={`inline-flex min-h-8 cursor-pointer items-center gap-1 rounded-lg px-2 py-0.5 font-mono text-xs transition-colors focus-visible:outline-none focus-visible:shadow-focus ${
                      m === activeModel
                        ? "border border-coral bg-coral-bg text-coral-ink"
                        : "border border-transparent bg-panel text-muted hover:border-line"
                    }`}
                  >
                    {m === activeModel && (
                      <span className="material-symbols-outlined text-[12px]" aria-hidden="true">
                        star
                      </span>
                    )}
                    {m}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeServerModel(m);
                      }}
                      aria-label={`Remove ${m}`}
                      className="ms-0.5 flex size-6 items-center justify-center rounded-md transition-colors hover:text-err"
                    >
                      <span className="material-symbols-outlined text-[12px]" aria-hidden="true">
                        close
                      </span>
                    </button>
                  </span>
                ))
              )}
            </div>
            <button
              type="button"
              onClick={() => card.setModalOpen(true)}
              disabled={!activeProviders?.length}
              className="w-fit rounded-xl border border-line bg-raised px-3 py-2 text-xs font-semibold text-text transition-colors hover:border-coral disabled:cursor-not-allowed disabled:opacity-50"
            >
              Add model
            </button>
          </div>
        </SetupRow>
        <SetupRow label="Subagent model">
          <SingleModelRow
            value={subagentModel}
            onChange={(v) => setup.setField("subagentModel", v)}
            onPick={() => setSubagentModalOpen(true)}
            pickDisabled={!activeProviders?.length}
            placeholder="provider/model-id (defaults to main model)"
          />
        </SetupRow>
      </SetupScaffold>

      {card.modalOpen && (
        <ModelSelectModal
          isOpen={card.modalOpen}
          onClose={async () => {
            card.setModalOpen(false);
            await flushToolSettings("opencode");
            if (!isLocalOnly()) postModels(selectedModelsRef.current);
          }}
          onSelect={(m) => {
            if (!models.includes(m.value)) {
              setup.setFields({
                models: [...models, m.value],
                ...(activeModel ? {} : { activeModel: m.value }),
              });
            }
          }}
          onDeselect={(m) => {
            const next = models.filter((x) => x !== m.value);
            setup.setFields({
              models: next,
              ...(activeModel === m.value ? { activeModel: next[0] || "" } : {}),
            });
          }}
          selectedModel={null}
          activeProviders={activeProviders}
          modelAliases={card.modelAliases}
          addedModelValues={models}
          closeOnSelect={false}
          title="Add model for OpenCode"
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
          title="Select subagent model for OpenCode"
        />
      )}
      <ManualConfigModal
        isOpen={card.showManualModal}
        onClose={() => card.setShowManualModal(false)}
        title="OpenCode — Manual configuration"
        configs={getManualConfigs()}
      />
    </>
  );
}

OpenCodeToolCard.propTypes = setupCardPropTypes;
