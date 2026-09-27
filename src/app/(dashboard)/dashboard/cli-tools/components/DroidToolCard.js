"use client";

import { useState, useEffect, useRef } from "react";
import IconButton from "@/shared/components/IconButton";
import Input from "@/shared/components/Input";
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
  ModelSelectModal,
  ManualConfigModal,
  rememberEndpoint,
  deriveToolStatus,
} from "./setupCard";

const ENDPOINT = "/api/cli-tools/droid-settings";

/**
 * Factory Droid setup panel: multi-model list (first entry is active).
 * Writes ~/.factory/settings.json via /api/cli-tools/droid-settings.
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
  const { status } = card;
  const [modelList, setModelList] = useState([]);
  const [modelInput, setModelInput] = useState("");
  const hasInitializedModel = useRef(false);

  useEffect(() => {
    if (apiKeys?.length > 0 && !card.selectedApiKey) card.setSelectedApiKey(apiKeys[0].key);
  }, [apiKeys, card]);

  useEffect(() => {
    if (status?.installed && !hasInitializedModel.current) {
      hasInitializedModel.current = true;
      const existing = (status.settings?.customModels || [])
        .filter((m) => m.id?.startsWith("custom:9Router"))
        .sort((a, b) => (a.index || 0) - (b.index || 0))
        .map((m) => m.model);
      if (existing.length > 0) {
        setModelList(existing);
      } else {
        const legacy = status.settings?.customModels?.find((m) => m.id === "custom:9Router-0");
        if (legacy?.model) setModelList([legacy.model]);
      }
    }
  }, [status]);

  const currentBaseUrl =
    status?.settings?.customModels?.find((m) => m.id?.startsWith("custom:9Router"))?.baseUrl || "";

  const getEffectiveBaseUrl = () => {
    const u = card.customBaseUrl || baseUrl || "http://localhost:20128/v1";
    return u.endsWith("/v1") ? u : `${u}/v1`;
  };

  const addModel = () => {
    const val = modelInput.trim();
    if (!val || modelList.includes(val)) return;
    setModelList((prev) => [...prev, val]);
    setModelInput("");
  };

  const removeModel = (id) => setModelList((prev) => prev.filter((m) => m !== id));

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
          models: modelList,
          activeModel: modelList[0] || "",
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
        setModelList([]);
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
    const settingsPath =
      typeof navigator !== "undefined" && navigator.platform?.toLowerCase().includes("win")
        ? "%USERPROFILE%\\.factory\\settings.json"
        : "~/.factory/settings.json";
    return [
      {
        filename: settingsPath,
        content: JSON.stringify(
          {
            customModels: modelList.map((m, i) => ({
              model: m,
              id: `custom:9Router-${i}`,
              index: i,
              baseUrl: getEffectiveBaseUrl(),
              apiKey: manualKeyFallback(card.selectedApiKey, cloudEnabled),
              displayName: m,
              maxOutputTokens: 131072,
              noImageSupport: false,
              provider: "openai",
            })),
          },
          null,
          2,
        ),
      },
    ];
  };

  return (
    <>
      <SetupScaffold
        tool={tool}
        status={deriveToolStatus(tool, card.status)}
        checking={card.checking}
        checkingLabel="Checking Factory Droid CLI..."
        notInstalled={
          !card.checking && status && !status.installed ? (
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
        applyDisabled={modelList.length === 0}
        applying={card.applying}
        onReset={handleReset}
        resetDisabled={!status?.has9Router}
        resetting={card.restoring}
        onManualConfig={() => card.setShowManualModal(true)}
        fileHint="~/.factory/settings.json"
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
        <SetupRow label={`Models (${modelList.length})`} hint="first entry is active">
          <div className="flex flex-col gap-1.5">
            {modelList.length === 0 ? (
              <p className="text-xs text-muted">No models added yet.</p>
            ) : (
              modelList.map((m) => (
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
            if (m.value && !modelList.includes(m.value)) {
              setModelList((prev) => [...prev, m.value]);
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
        title="Factory Droid — Manual Configuration"
        configs={getManualConfigs()}
      />
    </>
  );
}

DroidToolCard.propTypes = setupCardPropTypes;
