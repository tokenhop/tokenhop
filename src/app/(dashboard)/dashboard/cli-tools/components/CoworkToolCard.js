"use client";

import { useState, useEffect } from "react";
import Button from "@/shared/components/Button";
import Checkbox from "@/shared/components/Checkbox";
import ComboFormModal from "@/shared/components/ComboFormModal";
import McpMarketplaceModal from "@/shared/components/McpMarketplaceModal";
import Modal from "@/shared/components/Modal";
import IconButton from "@/shared/components/IconButton";
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
  ManualConfigModal,
  rememberEndpoint,
  deriveToolStatus,
} from "./setupCard";

const ENDPOINT = "/api/cli-tools/cowork-settings";
const stripV1 = (url) => (url || "").replace(/\/v1\/?$/, "");
const ensureV1 = (url) => {
  const t = (url || "").replace(/\/+$/, "");
  return !t ? "" : /\/v1$/.test(t) ? t : `${t}/v1`;
};

/**
 * Claude Desktop Cowork setup panel: custom inference gateway, models
 * with combo creation, MCP plugins (bundled/marketplace/custom SSE), and
 * local stdio tools. Writes to Claude-3p/configLibrary/<appliedId>.json.
 */
export default function CoworkToolCard({
  tool,
  baseUrl,
  apiKeys = [],
  activeProviders = [],
  hasActiveProviders = false,
  cloudEnabled = false,
  cloudUrl = "",
  tunnelEnabled = false,
  tunnelPublicUrl = "",
  tailscaleEnabled = false,
  tailscaleUrl = "",
  onStatusUpdate,
}) {
  const card = useSetupCard({ statusUrl: ENDPOINT, onStatusUpdate, toolId: "cowork" });
  const { status } = card;
  const [selectedModels, setSelectedModels] = useState([]);
  const [plugins, setPlugins] = useState([]);
  const [localPlugins, setLocalPlugins] = useState([]);
  const [customPlugins, setCustomPlugins] = useState([]);
  const [comboModalOpen, setComboModalOpen] = useState(false);
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const [addMcpOpen, setAddMcpOpen] = useState(false);
  const [addMcpForm, setAddMcpForm] = useState({ name: "", url: "" });

  useEffect(() => {
    if (apiKeys?.length > 0 && !card.selectedApiKey) card.setSelectedApiKey(apiKeys[0].key);
  }, [apiKeys, card]);

  useEffect(() => {
    if (status?.cowork?.models?.length) setSelectedModels(status.cowork.models);
    if (status?.cowork?.baseUrl && !card.customBaseUrl) {
      card.setCustomBaseUrl(stripV1(status.cowork.baseUrl));
    }
    if (Array.isArray(status?.cowork?.plugins) && status.cowork.plugins.length > 0) {
      setPlugins(status.cowork.plugins);
    } else if (plugins.length === 0 && Array.isArray(status?.defaultPlugins)) {
      setPlugins(status.defaultPlugins);
    }
    if (Array.isArray(status?.cowork?.localPlugins)) setLocalPlugins(status.cowork.localPlugins);
    if (Array.isArray(status?.cowork?.customPlugins) && status.cowork.customPlugins.length > 0) {
      setCustomPlugins(status.cowork.customPlugins);
    }
  }, [status, card, plugins.length]);

  const currentBaseUrl = status?.cowork?.baseUrl || "";
  const getEffectiveBaseUrl = () => ensureV1(card.customBaseUrl || baseUrl);

  const handleApply = async () => {
    card.setMessage(null);
    if (selectedModels.length === 0) {
      card.setMessage({ type: "error", text: "Please select at least one model." });
      return;
    }
    card.setApplying(true);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: getEffectiveBaseUrl(),
          apiKey: keyFallback(card.selectedApiKey, apiKeys, cloudEnabled),
          models: selectedModels,
          plugins,
          localPlugins,
          customPlugins,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        rememberEndpoint(getEffectiveBaseUrl(), { tunnelPublicUrl, tailscaleUrl });
        card.setMessage({
          type: "success",
          text: "Settings applied. Quit & reopen Claude Desktop to load.",
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
        card.setMessage({ type: "success", text: "Settings reset successfully." });
        setSelectedModels([]);
        setPlugins(status?.defaultPlugins || []);
        setLocalPlugins([]);
        setCustomPlugins([]);
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

  const handleCreateCombo = async ({ name, models }) => {
    try {
      const res = await fetch("/api/combos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, models }),
      });
      if (!res.ok) {
        const err = await res.json();
        card.setMessage({ type: "error", text: err.error || "Failed to create combo." });
        return;
      }
      if (!selectedModels.includes(name)) setSelectedModels((prev) => [...prev, name]);
      setComboModalOpen(false);
      card.setMessage({ type: "success", text: `Combo "${name}" created and added.` });
    } catch (err) {
      card.setMessage({ type: "error", text: err.message });
    }
  };

  const exaEnabled = plugins.some((p) => p.name === "exa");
  const exaDef = (status?.defaultPlugins || []).find((d) => d.name === "exa");
  const browserDef = (status?.localStdioPlugins || []).find((p) => p.name === "browsermcp");
  const browserEnabled = localPlugins.includes("browsermcp");

  const getManualConfigs = () => {
    const modelsShown = selectedModels.length > 0 ? selectedModels : ["provider/model-id"];
    const cfg = {
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: getEffectiveBaseUrl() || "https://your-public-host/v1",
      inferenceGatewayApiKey: manualKeyFallback(card.selectedApiKey, cloudEnabled),
      inferenceModels: modelsShown.map((name) => ({ name })),
    };
    return [
      {
        filename: "~/Library/Application Support/Claude-3p/configLibrary/<appliedId>.json",
        content: JSON.stringify(cfg, null, 2),
      },
    ];
  };

  return (
    <>
      <SetupScaffold
        tool={tool}
        status={deriveToolStatus(tool, card.status)}
        checking={card.checking}
        checkingLabel="Checking Claude Cowork..."
        notInstalled={
          !card.checking && status && !status.installed ? (
            <NotInstalledBlock
              toolName="Claude Desktop (Cowork)"
              onManualConfig={() => card.setShowManualModal(true)}
              installHint="Open Claude Desktop → Help → Troubleshooting → Enable Developer mode → Configure third-party inference, then return here."
              guideOpen={card.showInstallGuide}
              onToggleGuide={() => card.setShowInstallGuide((v) => !v)}
            />
          ) : null
        }
        message={card.message}
        onApply={handleApply}
        applyDisabled={selectedModels.length === 0}
        applying={card.applying}
        onReset={handleReset}
        resetDisabled={!status?.has9Router}
        resetting={card.restoring}
        onManualConfig={() => card.setShowManualModal(true)}
        fileHint="Claude-3p/configLibrary/<appliedId>.json"
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
        <SetupRow label="Models">
          <div className="flex flex-col gap-1.5">
            <div
              className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-xl border border-line bg-raised px-2 py-1.5"
              role="listbox"
              aria-label="Selected models"
            >
              {selectedModels.length === 0 ? (
                <span className="text-xs text-muted">No models selected</span>
              ) : (
                selectedModels.map((m) => (
                  <span
                    key={m}
                    className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-transparent bg-panel px-2 py-0.5 font-mono text-xs text-muted"
                  >
                    {m}
                    <button
                      type="button"
                      onClick={() => setSelectedModels((prev) => prev.filter((x) => x !== m))}
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
              onClick={() => setComboModalOpen(true)}
              disabled={!hasActiveProviders}
              className="w-fit rounded-xl border border-line bg-raised px-3 py-2 text-xs font-semibold text-coral-ink transition-colors hover:border-coral disabled:cursor-not-allowed disabled:opacity-50"
            >
              + Combo
            </button>
          </div>
        </SetupRow>

        <SetupRow label="MCP servers">
          <div className="flex flex-col gap-1.5">
            {plugins
              .filter((p) => p.name !== "exa")
              .map((p) => (
                <div
                  key={p.name}
                  className="flex items-center gap-2 rounded-xl border border-line bg-raised px-3 py-1.5"
                >
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-text">
                    {p.title || p.name}
                  </span>
                  {p.oauth && (
                    <span className="rounded-full bg-warn-bg px-1.5 py-0.5 text-[9px] font-semibold text-warn">
                      OAuth
                    </span>
                  )}
                  <IconButton
                    icon="close"
                    label={`Remove ${p.name}`}
                    onClick={() => setPlugins((prev) => prev.filter((x) => x.name !== p.name))}
                  />
                </div>
              ))}
            {customPlugins.map((p) => (
              <div
                key={p.name}
                className="flex items-center gap-2 rounded-xl border border-line bg-raised px-3 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-text">
                  {p.name}
                </span>
                <span className="rounded-full bg-sky-bg px-1.5 py-0.5 text-[9px] font-semibold text-sky">
                  custom
                </span>
                <IconButton
                  icon="close"
                  label={`Remove ${p.name}`}
                  onClick={() => setCustomPlugins((prev) => prev.filter((x) => x.name !== p.name))}
                />
              </div>
            ))}
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => setMarketplaceOpen(true)}
                className="rounded-xl border border-line bg-raised px-3 py-1.5 text-xs font-semibold text-text transition-colors hover:border-coral"
              >
                + Browse
              </button>
              <button
                type="button"
                onClick={() => {
                  setAddMcpForm({ name: "", url: "" });
                  setAddMcpOpen(true);
                }}
                className="rounded-xl border border-line bg-raised px-3 py-1.5 text-xs font-semibold text-muted transition-colors hover:border-coral hover:text-text"
              >
                + Custom
              </button>
              <a
                href="https://mcp.so"
                target="_blank"
                rel="noopener noreferrer"
                className="ms-auto text-xs text-muted underline hover:text-text"
              >
                Find MCPs →
              </a>
            </div>
          </div>
        </SetupRow>

        <SetupRow label="Tools">
          <div className="flex flex-col gap-1.5">
            <Checkbox
              checked={exaEnabled}
              onChange={(checked) => {
                if (checked && exaDef)
                  setPlugins((prev) => [...prev.filter((p) => p.name !== "exa"), exaDef]);
                else setPlugins((prev) => prev.filter((p) => p.name !== "exa"));
              }}
              label="Web Search & Fetch (Exa)"
              description="Replaces built-in WebSearch/WebFetch. Auto-strips duplicates."
            />
            {browserDef && (
              <Checkbox
                checked={browserEnabled}
                onChange={(checked) => {
                  setLocalPlugins((prev) =>
                    checked ? [...prev, "browsermcp"] : prev.filter((n) => n !== "browsermcp"),
                  );
                }}
                label="Browser Control (Browser MCP)"
                description="Controls your running Chrome."
              />
            )}
            {(status?.localStdioPlugins || [])
              .filter((p) => p.name !== "browsermcp")
              .map((p) => (
                <Checkbox
                  key={p.name}
                  checked={localPlugins.includes(p.name)}
                  onChange={(checked) => {
                    setLocalPlugins((prev) =>
                      checked ? [...prev, p.name] : prev.filter((n) => n !== p.name),
                    );
                  }}
                  label={`${p.title || p.name} (local stdio)`}
                  description={p.description}
                />
              ))}
          </div>
        </SetupRow>
      </SetupScaffold>

      {comboModalOpen && (
        <ComboFormModal
          isOpen={comboModalOpen}
          combo={null}
          onClose={() => setComboModalOpen(false)}
          onSave={handleCreateCombo}
          activeProviders={activeProviders}
          forcePrefix="claude-"
          title="Create Cowork Combo"
        />
      )}
      <McpMarketplaceModal
        isOpen={marketplaceOpen}
        onClose={() => setMarketplaceOpen(false)}
        onAdd={(p) => {
          if (!plugins.some((x) => x.name === p.name)) setPlugins((prev) => [...prev, p]);
        }}
        addedNames={plugins.map((p) => p.name)}
      />
      <Modal
        isOpen={addMcpOpen}
        onClose={() => setAddMcpOpen(false)}
        title="Add Custom MCP"
        size="sm"
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="cowork-mcp-name" className="text-xs font-semibold text-muted">
              Name
            </label>
            <input
              id="cowork-mcp-name"
              type="text"
              placeholder="my-mcp"
              value={addMcpForm.name}
              onChange={(e) =>
                setAddMcpForm((f) => ({
                  ...f,
                  name: e.target.value.replace(/\s+/g, "-").toLowerCase(),
                }))
              }
              className="h-10 rounded-xl border border-line bg-raised px-3 text-sm text-text focus:border-coral focus:shadow-focus focus:outline-none"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="cowork-mcp-url" className="text-xs font-semibold text-muted">
              SSE URL
            </label>
            <input
              id="cowork-mcp-url"
              type="url"
              placeholder="https://example.com/sse"
              value={addMcpForm.url}
              onChange={(e) => setAddMcpForm((f) => ({ ...f, url: e.target.value }))}
              className="h-10 rounded-xl border border-line bg-raised px-3 text-sm text-text focus:border-coral focus:shadow-focus focus:outline-none"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={() => setAddMcpOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                const n = addMcpForm.name.trim();
                const u = addMcpForm.url.trim();
                if (!n || !u) return;
                setCustomPlugins((prev) => [
                  ...prev.filter((x) => x.name !== n),
                  { name: n, url: u, transport: "sse", custom: true },
                ]);
                setAddMcpOpen(false);
              }}
            >
              Add
            </Button>
          </div>
        </div>
      </Modal>
      <ManualConfigModal
        isOpen={card.showManualModal}
        onClose={() => card.setShowManualModal(false)}
        title="Claude Cowork — Manual Configuration"
        configs={getManualConfigs()}
      />
    </>
  );
}

CoworkToolCard.propTypes = setupCardPropTypes;
