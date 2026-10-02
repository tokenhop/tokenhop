"use client";

import { useMemo, useState } from "react";
import IconButton from "@/shared/components/IconButton";
import Input from "@/shared/components/Input";
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
  ModelSelectModal,
  ManualConfigModal,
  rememberEndpoint,
  deriveToolStatus,
} from "./setupCard";
import { CUSTOM_MODEL_ID_PREFIX, isCustomModelId } from "@/lib/cliToolBrand";
import { buildDroidConfig } from "@/lib/cliToolConfigs/droid";
import { useManualPlatform } from "@/store/manualSetupStore";

const ENDPOINT = "/api/cli-tools/droid-settings";

/**
 * Factory Droid setup panel: multi-model list (first entry is active).
 * Writes ~/.factory/settings.json via /api/cli-tools/droid-settings.
 * Fields persist via `useSetupSettings` (saved wins, then on-disk, then defaults).
 */
export default function DroidToolCard({
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
  const card = useSetupCard({ statusUrl: ENDPOINT, onStatusUpdate, toolId: "droid" });
  const platform = useManualPlatform();
  const { status } = card;
  const [modelInput, setModelInput] = useState("");

  const defaults = useMemo(() => ({ models: [], endpoint: "", apiKeyId: "" }), []);
  // On the host, the installed config fills values the user hasn't saved yet.
  const disk = useMemo(() => {
    if (!status?.installed) return null;
    const custom = status.settings?.customModels || [];
    const existing = custom
      .filter((m) => isCustomModelId(m.id))
      .sort((a, b) => (a.index || 0) - (b.index || 0))
      .map((m) => m.model);
    if (existing.length === 0) {
      const legacy = custom.find((m) => m.id === `${CUSTOM_MODEL_ID_PREFIX}0`);
      if (legacy?.model) existing.push(legacy.model);
    }
    return {
      models: existing.length ? existing : undefined,
      apiKeyId: apiKeys.find((k) => k.key === custom.find((m) => isCustomModelId(m.id))?.apiKey)
        ?.id,
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
  const setup = useSetupSettings({ toolId: "droid", apiKeys, defaults, disk, endpointContext });

  const models = asList(setup.values.models);

  const currentBaseUrl =
    status?.settings?.customModels?.find((m) => isCustomModelId(m.id))?.baseUrl || "";

  const getEffectiveBaseUrl = () => {
    const u = setup.endpoint || baseUrl || "http://localhost:20128/v1";
    return u.endsWith("/v1") ? u : `${u}/v1`;
  };

  const addModel = () => {
    const val = modelInput.trim();
    if (!val || models.includes(val)) return;
    setup.setField("models", [...models, val]);
    setModelInput("");
  };

  const removeModel = (id) =>
    setup.setField(
      "models",
      models.filter((m) => m !== id),
    );

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
          activeModel: models[0] || "",
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
      buildDroidConfig({
        baseUrl: getEffectiveBaseUrl(),
        apiKey: manualApiKey(setup.selectedApiKey, apiKeys, cloudEnabled),
        models,
        activeModel: models[0] || "",
        platform,
      }),
    );

  return (
    <>
      <SetupScaffold
        tool={tool}
        status={deriveToolStatus(tool, card.status)}
        checking={card.checking || !setup.loaded}
        checkingLabel="Checking Factory Droid CLI..."
        notInstalled={
          !card.checking && status && !status.installed && !status.error ? (
            <NotInstalledBlock
              toolName="Factory Droid"
              onManualConfig={() => card.setShowManualModal(true)}
              installCommand="curl -fsSL https://app.factory.ai/cli | sh"
              installHint="After installation, run droid to verify."
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
        fileHint="~/.factory/settings.json"
        {...setup.scaffoldProps("~/.factory/settings.json")}
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
        <SetupRow label={`Models (${models.length})`} hint="first entry is active">
          <div className="flex flex-col gap-1.5">
            {models.length === 0 ? (
              <p className="text-xs text-muted">No models added yet.</p>
            ) : (
              models.map((m) => (
                <div
                  key={m}
                  className="flex items-center gap-2 rounded-xl border border-line bg-raised px-3 py-2"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-text">
                    {m}
                  </span>
                  <IconButton icon="close" label={`Remove ${m}`} onClick={() => removeModel(m)} />
                </div>
              ))
            )}
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <Input
                  value={modelInput}
                  onChange={(e) => setModelInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addModel();
                  }}
                  placeholder="provider/model-id"
                  aria-label="Add model"
                />
              </div>
              <IconButton
                icon="list"
                label="Pick model for Factory Droid"
                onClick={() => card.setModalOpen(true)}
                disabled={!activeProviders?.length}
              />
            </div>
          </div>
        </SetupRow>
      </SetupScaffold>

      {card.modalOpen && (
        <ModelSelectModal
          isOpen={card.modalOpen}
          onClose={() => card.setModalOpen(false)}
          onSelect={(m) => {
            if (m.value && !models.includes(m.value)) {
              setup.setField("models", [...models, m.value]);
            }
            card.setModalOpen(false);
          }}
          selectedModel={null}
          activeProviders={activeProviders}
          modelAliases={card.modelAliases}
          title="Select model for Factory Droid"
        />
      )}
      <ManualConfigModal
        isOpen={card.showManualModal}
        onClose={() => card.setShowManualModal(false)}
        title="Factory Droid — Manual configuration"
        configs={getManualConfigs()}
      />
    </>
  );
}

DroidToolCard.propTypes = setupCardPropTypes;
