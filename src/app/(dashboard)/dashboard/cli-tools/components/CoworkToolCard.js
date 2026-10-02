"use client";

import { useState, useEffect, useMemo } from "react";
import { refreshShellStatus } from "@/shared/hooks/useShellStatus";
import Button from "@/shared/components/Button";
import Checkbox from "@/shared/components/Checkbox";
import ComboFormModal from "@/shared/components/ComboFormModal";
import McpMarketplaceModal from "@/shared/components/McpMarketplaceModal";
import Modal from "@/shared/components/Modal";
import IconButton from "@/shared/components/IconButton";
import {
  useSetupCard,
  useSetupSettings,
  asList,
  asObjectList,
  setupCardPropTypes,
  resolveApiKey,
  manualApiKey,
  ApiKeySelect,
  EndpointSegmentedPicker,
  SetupScaffold,
  NotInstalledBlock,
  SetupRow,
  ManualConfigModal,
  rememberEndpoint,
  deriveToolStatus,
  toManualConfigs,
} from "./setupCard";
import { DEFAULT_PLUGINS } from "@/shared/constants/coworkPlugins";
import { buildCoworkConfig, buildCoworkMcpServers } from "@/lib/cliToolConfigs/cowork";
import { useManualPlatform } from "@/store/manualSetupStore";

const ENDPOINT = "/api/cli-tools/cowork-settings";
const FILE_HINT = "Claude-3p/configLibrary + claude_desktop_config.json";
// crypto.randomUUID needs a secure context; remote dashboards are often plain HTTP.
const uuid = () =>
  crypto.randomUUID?.() ??
  "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16),
  );
const ensureV1 = (url) => {
  const t = (url || "").replace(/\/+$/, "");
  return !t ? "" : /\/v1$/.test(t) ? t : `${t}/v1`;
};

/**
 * Claude Desktop Cowork setup panel: custom inference gateway, models
 * with combo creation, MCP plugins (bundled/marketplace/custom SSE), and
 * local stdio tools. Writes to Claude-3p/configLibrary/<appliedId>.json.
 * Fields persist via `useSetupSettings` (saved wins, then on-disk, then
 * defaults); the file POST only ever sends the merged values.
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
  const platform = useManualPlatform();
  const { status } = card;
  const [comboModalOpen, setComboModalOpen] = useState(false);
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const [addMcpOpen, setAddMcpOpen] = useState(false);
  const [addMcpForm, setAddMcpForm] = useState({ name: "", url: "" });
  // Snippet id when the host has none yet (remote, or never applied); stable per mount.
  // Set after mount so server and client render the same markup.
  const [draftAppliedId, setDraftAppliedId] = useState("<appliedId>");
  useEffect(() => setDraftAppliedId(uuid()), []);

  const defaults = useMemo(
    () => ({
      models: [],
      plugins: DEFAULT_PLUGINS,
      localPlugins: [],
      customPlugins: [],
      endpoint: "",
      apiKeyId: "",
    }),
    [],
  );
  // On the host, the installed config fills fields the user hasn't saved yet.
  // Raw secrets stay out: only status.cowork lists and the key id cross over.
  const disk = useMemo(() => {
    if (!status?.installed) return null;
    return {
      models: status.cowork?.models?.length ? [...status.cowork.models] : undefined,
      plugins:
        Array.isArray(status.cowork?.plugins) && status.cowork.plugins.length
          ? status.cowork.plugins
          : undefined,
      localPlugins: Array.isArray(status.cowork?.localPlugins)
        ? status.cowork.localPlugins
        : undefined,
      customPlugins:
        Array.isArray(status.cowork?.customPlugins) && status.cowork.customPlugins.length
          ? status.cowork.customPlugins
          : undefined,
      apiKeyId: apiKeys.find((k) => k.key === status.config?.inferenceGatewayApiKey)?.id,
      endpoint: status.cowork?.baseUrl || undefined,
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
  const setup = useSetupSettings({ toolId: "cowork", apiKeys, defaults, disk, endpointContext });

  // Saved values are read back untrusted; plugin lists keep plain objects with a name and url.
  const selectedModels = asList(setup.values.models);
  const plugins = asObjectList(setup.values.plugins);
  const localPlugins = asList(setup.values.localPlugins);
  const customPlugins = asObjectList(setup.values.customPlugins);

  const currentBaseUrl = status?.cowork?.baseUrl || "";
  const getEffectiveBaseUrl = () => ensureV1(setup.endpoint || baseUrl);

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
          apiKey: resolveApiKey(setup.selectedApiKey, apiKeys, cloudEnabled),
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
      refreshShellStatus();
      if (!selectedModels.includes(name)) setup.setField("models", [...selectedModels, name]);
      setComboModalOpen(false);
      card.setMessage({ type: "success", text: `Combo "${name}" created and added.` });
    } catch (err) {
      card.setMessage({ type: "error", text: err.message });
    }
  };

  const exaEnabled = plugins.some((p) => p.name === "exa");
  const exaDef = DEFAULT_PLUGINS.find((d) => d.name === "exa");
  const browserDef = (status?.localStdioPlugins || []).find((p) => p.name === "browsermcp");
  const browserEnabled = localPlugins.includes("browsermcp");

  // Local stdio bridges are left out: they need this host and its CLI token.
  const getManualConfigs = () =>
    toManualConfigs(
      buildCoworkConfig({
        baseUrl: getEffectiveBaseUrl(),
        apiKey: manualApiKey(setup.selectedApiKey, apiKeys, cloudEnabled),
        models: selectedModels,
        managedMcpServers: buildCoworkMcpServers({ plugins, customPlugins }),
        appliedId: status?.cowork?.appliedId || draftAppliedId,
        platform,
      }),
    );

  return (
    <>
      <SetupScaffold
        tool={tool}
        status={deriveToolStatus(tool, card.status)}
        checking={card.checking || !setup.loaded}
        checkingLabel="Checking Claude Cowork..."
        notInstalled={
          !card.checking && status && !status.installed && !status.error ? (
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
                      onClick={() =>
                        setup.setField(
                          "models",
                          selectedModels.filter((x) => x !== m),
                        )
                      }
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
                    onClick={() =>
                      setup.setField(
                        "plugins",
                        plugins.filter((x) => x.name !== p.name),
                      )
                    }
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
                  onClick={() =>
                    setup.setField(
                      "customPlugins",
                      customPlugins.filter((x) => x.name !== p.name),
                    )
                  }
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
                  setup.setField("plugins", [...plugins.filter((p) => p.name !== "exa"), exaDef]);
                else
                  setup.setField(
                    "plugins",
                    plugins.filter((p) => p.name !== "exa"),
                  );
              }}
              label="Web search & fetch (Exa)"
              description="Replaces built-in WebSearch/WebFetch. Auto-strips duplicates."
            />
            {browserDef && (
              <Checkbox
                checked={browserEnabled}
                onChange={(checked) => {
                  setup.setField(
                    "localPlugins",
                    checked
                      ? [...localPlugins, "browsermcp"]
                      : localPlugins.filter((n) => n !== "browsermcp"),
                  );
                }}
                label="Browser control (Browser MCP)"
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
                    setup.setField(
                      "localPlugins",
                      checked
                        ? [...localPlugins, p.name]
                        : localPlugins.filter((n) => n !== p.name),
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
          title="Create Cowork combo"
        />
      )}
      <McpMarketplaceModal
        isOpen={marketplaceOpen}
        onClose={() => setMarketplaceOpen(false)}
        onAdd={(p) => {
          // Saved plugins reach autosave/validation, so keep flat scalars only.
          if (plugins.some((x) => x.name === p.name)) return;
          setup.setField("plugins", [
            ...plugins,
            {
              name: p.name,
              title: p.title,
              url: p.url,
              transport: p.transport,
              oauth: Boolean(p.oauth),
              toolNames: Array.isArray(p.toolNames)
                ? p.toolNames.filter((t) => typeof t === "string")
                : [],
            },
          ]);
        }}
        addedNames={plugins.map((p) => p.name)}
      />
      <Modal
        isOpen={addMcpOpen}
        onClose={() => setAddMcpOpen(false)}
        title="Add custom MCP"
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
                setup.setField("customPlugins", [
                  ...customPlugins.filter((x) => x.name !== n),
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
        title="Claude Cowork — Manual configuration"
        configs={getManualConfigs()}
      />
    </>
  );
}

CoworkToolCard.propTypes = setupCardPropTypes;
