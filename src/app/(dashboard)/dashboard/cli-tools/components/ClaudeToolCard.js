"use client";

import PropTypes from "prop-types";
import { useState, useEffect, useRef, useCallback } from "react";
import Badge from "@/shared/components/Badge";
import Checkbox from "@/shared/components/Checkbox";
import SegmentedControl from "@/shared/components/SegmentedControl";
import ModelSelectModal from "@/shared/components/ModelSelectModal";
import ManualConfigModal from "@/shared/components/ManualConfigModal";
import Tooltip from "@/shared/components/Tooltip";
import ApiKeySelect from "./ApiKeySelect";
import EndpointSegmentedPicker from "./EndpointSegmentedPicker";
import SetupScaffold, { NotInstalledBlock, ModelRow } from "./SetupScaffold";
import { ACTIVE } from "@/shared/brand";
import { rememberEndpoint } from "./cliEndpointPresets";
import { deriveToolStatus } from "../lib/toolStatus";
import { markLocalOnly, useCliAccessStore } from "@/store/cliAccessStore";
import { isLocalOnlyResponse } from "@/shared/utils/localOnly";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import { DEFAULT_PLUGINS } from "@/shared/constants/coworkPlugins";

const EXA_PLUGIN = DEFAULT_PLUGINS.find((p) => p.name === "exa");

// Auto-compact window presets (CLAUDE_CODE_AUTO_COMPACT_WINDOW, valid 100K–1M).
// UI shows the round number; the value written is nudged down 2K to stay safely
// under the upstream hard cap.
const AUTO_COMPACT_OPTIONS = [
  { label: "Default", value: "" },
  { label: "200K", value: "198000" },
  { label: "300K", value: "298000" },
  { label: "500K", value: "498000" },
  { label: "700K", value: "698000" },
];

export default function ClaudeToolCard({
  tool,
  baseUrl,
  apiKeys = [],
  cloudEnabled = false,
  cloudUrl = "",
  tunnelEnabled = false,
  tunnelPublicUrl = "",
  tailscaleEnabled = false,
  tailscaleUrl = "",
  activeProviders = [],
  hasActiveProviders = false,
  modelAliases = {},
  ccFilterNaming: ccFilterNamingProp = false,
  onStatusUpdate,
}) {
  const [claudeStatus, setClaudeStatus] = useState(null);
  const [checking, setChecking] = useState(() => !useCliAccessStore.getState().localOnly);
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState(null);
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [currentEditingAlias, setCurrentEditingAlias] = useState(null);
  const [selectedApiKey, setSelectedApiKey] = useState("");
  const [showManualModal, setShowManualModal] = useState(false);
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [ccFilterNaming, setCcFilterNaming] = useState(ccFilterNamingProp);
  const [exaMcpEnabled, setExaMcpEnabled] = useState(false);
  const [autoCompactWindow, setAutoCompactWindow] = useState("");
  const [oneMContext, setOneMContext] = useState(false);
  const [modelMappings, setModelMappings] = useState({});
  const hasInitializedModels = useRef(false);
  const localOnly = useCliAccessStore((s) => s.localOnly);

  // Stable callback identity across renders — see setupCard.js. The latest
  // callback lives in a ref so the effect below runs once per mount.
  const onStatusUpdateRef = useRef(onStatusUpdate);
  useEffect(() => {
    onStatusUpdateRef.current = onStatusUpdate;
  }, [onStatusUpdate]);

  const fetchStatus = useCallback(async () => {
    if (useCliAccessStore.getState().localOnly) {
      setChecking(false);
      return;
    }
    setChecking(true);
    try {
      const res = await fetch("/api/cli-tools/claude-settings");
      if (await isLocalOnlyResponse(res)) return markLocalOnly();
      const data = await res.json();
      setClaudeStatus(data);
      setExaMcpEnabled(Boolean(data?.exaMcpEnabled));
      onStatusUpdateRef.current?.("claude", data);
    } catch (err) {
      setClaudeStatus({ installed: false, error: err.message });
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Shared (useToolSetupData) already loads /api/settings once; sync here.
  useEffect(() => {
    setCcFilterNaming(ccFilterNamingProp);
  }, [ccFilterNamingProp]);

  // Sync API keys and initial mappings from on-disk settings
  useEffect(() => {
    if (apiKeys?.length > 0 && !selectedApiKey) {
      setSelectedApiKey(apiKeys[0].key);
    }
  }, [apiKeys, selectedApiKey]);

  // Remotely status never loads, so seed the mappings from the tool defaults.
  useEffect(() => {
    if (!localOnly || hasInitializedModels.current) return;
    hasInitializedModels.current = true;
    const initial = {};
    tool.defaultModels?.forEach((m) => {
      if (m.envKey && m.defaultValue) initial[m.alias] = m.defaultValue;
    });
    setModelMappings(initial);
  }, [localOnly, tool.defaultModels]);

  useEffect(() => {
    if (claudeStatus?.installed && !hasInitializedModels.current) {
      hasInitializedModels.current = true;
      const env = claudeStatus.settings?.env || {};
      const initial = {};
      tool.defaultModels?.forEach((m) => {
        const v = env[m.envKey] || m.defaultValue || "";
        if (m.envKey && v) initial[m.alias] = v;
      });
      if (Object.keys(initial).length > 0) setModelMappings(initial);
      if (env.ANTHROPIC_AUTH_TOKEN) setSelectedApiKey(env.ANTHROPIC_AUTH_TOKEN);
      if (env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) {
        setAutoCompactWindow(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
      }
      setOneMContext(Boolean(tool.defaultModels?.some((m) => env[m.envKey]?.endsWith("[1m]"))));
    }
  }, [claudeStatus, tool.defaultModels]);

  const withContextMarker = (value, enabled) => {
    const { model } = stripModelContextMarker(value);
    return enabled ? `${model}[1m]` : model;
  };

  const handleOneMContextToggle = (enabled) => {
    setOneMContext(enabled);
    setModelMappings((prev) => {
      const next = { ...prev };
      tool.defaultModels?.forEach((m) => {
        if (next[m.alias]) next[m.alias] = withContextMarker(next[m.alias], enabled);
      });
      return next;
    });
  };

  const handleModelChange = (alias, val) => {
    setModelMappings((prev) => ({ ...prev, [alias]: val }));
  };

  // Picked models follow the [1m] toggle; typed values stay as typed.
  const handleModelPick = (alias, val) => {
    handleModelChange(alias, val ? withContextMarker(val, oneMContext) : val);
  };

  const handleCcFilterNamingToggle = async (checked) => {
    const prev = ccFilterNaming;
    setCcFilterNaming(checked);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ccFilterNaming: checked }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
    } catch {
      setCcFilterNaming(prev);
    }
  };

  const currentBaseUrl = claudeStatus?.settings?.env?.ANTHROPIC_BASE_URL || "";

  const getEffectiveBaseUrl = () => {
    const u = customBaseUrl || baseUrl || "http://localhost:20128/v1";
    return u.endsWith("/v1") ? u : `${u}/v1`;
  };

  const handleApply = async () => {
    setApplying(true);
    setMessage(null);
    try {
      const env = { ANTHROPIC_BASE_URL: getEffectiveBaseUrl() };
      const keyToUse =
        selectedApiKey?.trim() ||
        (apiKeys?.length > 0 ? apiKeys[0].key : null) ||
        (!cloudEnabled ? ACTIVE.defaultApiKey : null);

      if (keyToUse) env.ANTHROPIC_AUTH_TOKEN = keyToUse;

      tool.defaultModels?.forEach((m) => {
        const target = modelMappings[m.alias];
        if (target && m.envKey) env[m.envKey] = target;
      });

      if (autoCompactWindow) {
        env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = autoCompactWindow;
      }

      const res = await fetch("/api/cli-tools/claude-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ env, exaMcpEnabled, autoCompactWindow }),
      });
      const data = await res.json();
      if (res.ok) {
        rememberEndpoint(getEffectiveBaseUrl(), { tunnelPublicUrl, tailscaleUrl });
        setMessage({ type: "success", text: "Settings applied successfully." });
        await fetchStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to apply settings." });
      }
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setApplying(false);
    }
  };

  const handleReset = async () => {
    setRestoring(true);
    setMessage(null);
    try {
      const res = await fetch("/api/cli-tools/claude-settings", { method: "DELETE" });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: "Settings reset successfully." });
        const defaults = {};
        tool.defaultModels?.forEach((m) => {
          defaults[m.alias] = m.defaultValue || "";
        });
        setModelMappings(defaults);
        setSelectedApiKey("");
        setExaMcpEnabled(false);
        setAutoCompactWindow("");
        setOneMContext(false);
        await fetchStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to reset settings." });
      }
      return res.ok;
    } catch (err) {
      setMessage({ type: "error", text: err.message });
      return false;
    } finally {
      setRestoring(false);
    }
  };

  const getManualConfigs = () => {
    const keyToUse =
      selectedApiKey?.trim() || (!cloudEnabled ? ACTIVE.defaultApiKey : "<API_KEY_FROM_DASHBOARD>");
    const env = { ANTHROPIC_BASE_URL: getEffectiveBaseUrl(), ANTHROPIC_AUTH_TOKEN: keyToUse };
    tool.defaultModels?.forEach((m) => {
      const t = modelMappings[m.alias];
      if (t && m.envKey) env[m.envKey] = t;
    });
    if (autoCompactWindow) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = autoCompactWindow;

    const configs = [
      {
        filename: "~/.claude/settings.json",
        content: JSON.stringify({ hasCompletedOnboarding: true, env }, null, 2),
      },
    ];
    // Apply merges this into ~/.claude.json (see claude-settings route).
    if (exaMcpEnabled && EXA_PLUGIN) {
      configs.push({
        filename: "~/.claude.json (merge into mcpServers)",
        content: JSON.stringify(
          { mcpServers: { exa: { type: EXA_PLUGIN.transport, url: EXA_PLUGIN.url } } },
          null,
          2,
        ),
      });
    }
    return configs;
  };

  const derived = deriveToolStatus(tool, claudeStatus);
  const isCombo = (val) => Boolean(val && (modelAliases[val] || val.startsWith("claude-")));

  return (
    <>
      <SetupScaffold
        tool={tool}
        status={derived}
        version={claudeStatus?.installed ? "detected" : undefined}
        checking={checking}
        checkingLabel="Checking Claude CLI..."
        notInstalled={
          !checking && claudeStatus && !claudeStatus.installed && !claudeStatus.error ? (
            <NotInstalledBlock
              toolName="Claude Code"
              onManualConfig={() => setShowManualModal(true)}
              installCommand="npm install -g @anthropic-ai/claude-code"
              installHint="After installation, run claude in a terminal to verify."
              guideOpen={showInstallGuide}
              onToggleGuide={() => setShowInstallGuide((v) => !v)}
            />
          ) : null
        }
        message={message}
        onApply={handleApply}
        applyDisabled={!hasActiveProviders}
        applying={applying}
        onReset={handleReset}
        resetDisabled={!claudeStatus?.hasTokenhop}
        resetting={restoring}
        onManualConfig={() => setShowManualModal(true)}
        manualConfigs={getManualConfigs()}
        fileHint="~/.claude/settings.json"
      >
        <EndpointSegmentedPicker
          value={customBaseUrl || baseUrl}
          onChange={setCustomBaseUrl}
          requiresExternalUrl={tool.requiresExternalUrl}
          tunnelEnabled={tunnelEnabled}
          tunnelPublicUrl={tunnelPublicUrl}
          tailscaleEnabled={tailscaleEnabled}
          tailscaleUrl={tailscaleUrl}
          cloudEnabled={cloudEnabled}
          cloudUrl={cloudUrl}
          currentUrl={currentBaseUrl}
        />

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">API key</span>
          <ApiKeySelect
            value={selectedApiKey}
            onChange={setSelectedApiKey}
            apiKeys={apiKeys}
            cloudEnabled={cloudEnabled}
          />
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-semibold text-text">Model mapping</span>
          {tool.defaultModels?.map((m) => (
            <ModelRow
              key={m.alias}
              label={m.name.replace("Claude ", "")}
              value={modelMappings[m.alias] || ""}
              onChange={(val) => handleModelChange(m.alias, val)}
              onPick={() => {
                setCurrentEditingAlias(m.alias);
                setModalOpen(true);
              }}
              pickDisabled={!hasActiveProviders}
              pickLabel={`Pick ${m.name}`}
              isCombo={isCombo(modelMappings[m.alias])}
            />
          ))}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">
            Auto-compact at
          </span>
          <SegmentedControl
            options={AUTO_COMPACT_OPTIONS}
            value={autoCompactWindow}
            onChange={setAutoCompactWindow}
            aria-label="Auto-compact window"
            size="sm"
          />
        </div>

        <div className="flex flex-col gap-1 pt-1">
          <Checkbox
            checked={oneMContext}
            onChange={handleOneMContextToggle}
            label={
              <span className="inline-flex items-center gap-1.5">
                <span>Append [1m] to the model name</span>
                <Tooltip text="Claude Code otherwise assumes a 200K window. Only enable for models that accept 1M.">
                  <span
                    className="material-symbols-outlined text-[14px] text-subtle"
                    aria-hidden="true"
                  >
                    info
                  </span>
                </Tooltip>
              </span>
            }
          />
          <Checkbox
            checked={ccFilterNaming}
            onChange={handleCcFilterNamingToggle}
            label={
              <span className="inline-flex items-center gap-1.5">
                <span>Filter naming requests</span>
                <Badge variant="neutral" size="sm">
                  Server setting
                </Badge>
                <Tooltip text="Returns a local response to topic-naming turns, saving tokens.">
                  <span
                    className="material-symbols-outlined text-[14px] text-subtle"
                    aria-hidden="true"
                  >
                    info
                  </span>
                </Tooltip>
              </span>
            }
          />
          <Checkbox
            checked={exaMcpEnabled}
            onChange={setExaMcpEnabled}
            label={
              <span className="inline-flex items-center gap-1.5">
                <span>Add Exa MCP for web search</span>
                <Tooltip text="Injects Exa MCP into ~/.claude.json so non-Claude models gain web search.">
                  <span
                    className="material-symbols-outlined text-[14px] text-subtle"
                    aria-hidden="true"
                  >
                    info
                  </span>
                </Tooltip>
              </span>
            }
          />
        </div>
      </SetupScaffold>

      {modalOpen && (
        <ModelSelectModal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          onSelect={(m) => {
            if (currentEditingAlias) handleModelPick(currentEditingAlias, m.value);
          }}
          selectedModel={currentEditingAlias ? modelMappings[currentEditingAlias] : null}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title={`Select model for ${currentEditingAlias}`}
        />
      )}

      <ManualConfigModal
        isOpen={showManualModal}
        onClose={() => setShowManualModal(false)}
        title="Claude Code — Manual configuration"
        configs={getManualConfigs()}
      />
    </>
  );
}

ClaudeToolCard.propTypes = {
  tool: PropTypes.object.isRequired,
  baseUrl: PropTypes.string,
  apiKeys: PropTypes.array,
  cloudEnabled: PropTypes.bool,
  tunnelEnabled: PropTypes.bool,
  tunnelPublicUrl: PropTypes.string,
  tailscaleEnabled: PropTypes.bool,
  tailscaleUrl: PropTypes.string,
  activeProviders: PropTypes.array,
  hasActiveProviders: PropTypes.bool,
  modelAliases: PropTypes.object,
  ccFilterNaming: PropTypes.bool,
  onStatusUpdate: PropTypes.func,
};
