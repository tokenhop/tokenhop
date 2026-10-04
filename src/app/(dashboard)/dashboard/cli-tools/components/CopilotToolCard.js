"use client";

import { useEffect, useMemo, useRef } from "react";
import Callout from "@/shared/components/Callout";
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
  SetupRow,
  ModelSelectModal,
  ManualConfigModal,
  rememberEndpoint,
  deriveToolStatus,
} from "./setupCard";
import { CLIENT_NAME, isClientKey } from "@/lib/cliToolBrand";
import { buildCopilotConfig } from "@/lib/cliToolConfigs/copilot";
import { useManualPlatform } from "@/store/manualSetupStore";

const ENDPOINT = "/api/cli-tools/copilot-settings";

/**
 * GitHub Copilot setup panel: multi-model chips written to VS Code's
 * chatLanguageModels.json. No install gate — the config lives in the
 * editor, not on this machine. Fields persist via `useSetupSettings`;
 * the DB write goes out before the immediate file POST.
 */
export default function CopilotToolCard({
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
  const card = useSetupCard({ statusUrl: ENDPOINT, onStatusUpdate, toolId: "copilot" });
  const platform = useManualPlatform();
  const { status } = card;
  const selectedModelsRef = useRef([]);
  // YAN-363: this route reports storage/credentialConfigured directly; the
  // shared context only breaks ties. Hashed: pasted key or omission — the
  // server preserves the disk credential for an unchanged destination.
  const hashed = status?.storage === "hashed" || hashedContext;

  const defaults = useMemo(() => ({ models: [], endpoint: "", apiKeyId: "" }), []);
  // The host's chatLanguageModels.json fills values the user hasn't saved yet.
  const disk = useMemo(() => {
    if (!Array.isArray(status?.config)) return null;
    const entry =
      status.config.find((e) => e.name === CLIENT_NAME) ||
      status.config.find((e) => isClientKey(e.name));
    return {
      models: entry?.models?.length ? entry.models.map((m) => m.id) : undefined,
      apiKeyId: apiKeys.find((k) => k.key === entry?.apiKey)?.id,
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
  const setup = useSetupSettings({ toolId: "copilot", apiKeys, defaults, disk, endpointContext });

  const models = asList(setup.values.models);

  useEffect(() => {
    selectedModelsRef.current = models;
  }, [models]);

  const getEffectiveBaseUrl = () => {
    const fallback = setup.endpoint || baseUrl || "http://localhost:20128/v1";
    return fallback.endsWith("/v1") ? fallback : `${fallback}/v1`;
  };

  const postModels = async (nextModels) => {
    await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: getEffectiveBaseUrl(),
        apiKey: resolveApiKey(setup.selectedApiKey, apiKeys, cloudEnabled, { hashed }),
        models: nextModels,
      }),
    }).catch(() => {});
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
          models,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        rememberEndpoint(getEffectiveBaseUrl(), { tunnelPublicUrl, tailscaleUrl });
        card.setMessage({
          type: "success",
          text: data.message || "Settings applied. Reload VS Code.",
        });
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
      buildCopilotConfig({
        baseUrl: getEffectiveBaseUrl(),
        apiKey: manualApiKey(setup.selectedApiKey, apiKeys, cloudEnabled, { hashed }),
        models,
        platform,
      }),
    );

  return (
    <>
      <SetupScaffold
        tool={tool}
        status={status ? deriveToolStatus(tool, status) : null}
        checking={card.checking || !setup.loaded}
        checkingLabel="Checking Copilot config..."
        message={card.message}
        onApply={handleApply}
        applyDisabled={models.length === 0}
        applying={card.applying}
        onReset={handleReset}
        resetDisabled={!status?.hasTokenhop}
        resetting={card.restoring}
        onManualConfig={() => card.setShowManualModal(true)}
        manualConfigs={getManualConfigs()}
        manualDisabled={models.length === 0}
        fileHint="chatLanguageModels.json"
        {...setup.scaffoldProps("chatLanguageModels.json")}
      >
        <Callout variant="info" title="VS Code extension">
          Writes to chatLanguageModels.json. Reload VS Code after applying for changes to take
          effect.
        </Callout>
        <EndpointSegmentedPicker
          key={setup.pickerKey}
          value={setup.endpoint || baseUrl}
          {...setup.pickerProps}
          currentUrl={status?.currentUrl?.replace(/\/chat\/completions.*$/, "") || ""}
        />
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
        <SetupRow label="Models">
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
                    className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-transparent bg-panel px-2 py-0.5 font-mono text-xs text-muted"
                  >
                    {m}
                    <button
                      type="button"
                      onClick={() =>
                        setup.setField(
                          "models",
                          models.filter((x) => x !== m),
                        )
                      }
                      aria-label={`Remove ${m}`}
                      className="flex size-6 items-center justify-center rounded-md transition-colors hover:text-err"
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
      </SetupScaffold>

      {card.modalOpen && (
        <ModelSelectModal
          isOpen={card.modalOpen}
          onClose={async () => {
            card.setModalOpen(false);
            await flushToolSettings("copilot");
            if (!useCliAccessStore.getState().localOnly) postModels(selectedModelsRef.current);
          }}
          onSelect={(m) => {
            if (!models.includes(m.value)) setup.setField("models", [...models, m.value]);
          }}
          onDeselect={(m) => {
            setup.setField(
              "models",
              models.filter((x) => x !== m.value),
            );
          }}
          selectedModel={null}
          activeProviders={activeProviders}
          modelAliases={card.modelAliases}
          addedModelValues={models}
          closeOnSelect={false}
          title="Add model for GitHub Copilot"
        />
      )}
      <ManualConfigModal
        isOpen={card.showManualModal}
        onClose={() => card.setShowManualModal(false)}
        title="GitHub Copilot — Manual configuration"
        configs={getManualConfigs()}
      />
    </>
  );
}

CopilotToolCard.propTypes = setupCardPropTypes;
