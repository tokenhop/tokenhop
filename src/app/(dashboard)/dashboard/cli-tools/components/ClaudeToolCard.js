"use client";

import PropTypes from "prop-types";
import { useState, useEffect, useRef, useCallback, useMemo, useSyncExternalStore } from "react";
import Badge from "@/shared/components/Badge";
import Checkbox from "@/shared/components/Checkbox";
import SegmentedControl from "@/shared/components/SegmentedControl";
import ModelSelectModal from "@/shared/components/ModelSelectModal";
import ManualConfigModal from "@/shared/components/ManualConfigModal";
import Tooltip from "@/shared/components/Tooltip";
import ApiKeySelect from "./ApiKeySelect";
import EndpointSegmentedPicker from "./EndpointSegmentedPicker";
import SetupScaffold, { NotInstalledBlock, ModelRow } from "./SetupScaffold";
import { buildClaudeConfig } from "@/lib/cliToolConfigs/claude";
import {
  resolveApiKey,
  manualApiKey,
  toManualConfigs,
  apiKeyPatch,
  resolveSelectedApiKey,
  savedEndpointUrl,
} from "./setupCard";
import {
  rememberEndpoint,
  readKeyPresets,
  subscribeKeyPresets,
  readPresets,
  subscribePresets,
} from "./cliEndpointPresets";
import { deriveToolStatus } from "../lib/toolStatus";
import { useToolSettings } from "../hooks/useToolSettings";
import { markLocalOnly, useCliAccessStore } from "@/store/cliAccessStore";
import { isLocalOnlyResponse } from "@/shared/utils/localOnly";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";

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

// Stable snapshot for useSyncExternalStore's SSR fallback.
const EMPTY = [];

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
  const [showManualModal, setShowManualModal] = useState(false);
  const [ccFilterNaming, setCcFilterNaming] = useState(ccFilterNamingProp);
  // Endpoint the picker chose at mount; not a user edit, so it isn't saved.
  const [initUrl, setInitUrl] = useState("");
  // ponytail: only typed, unsaved keys stay in memory; saved picks persist by
  // apiKeyId (dashboard key) or apiKeyPreset (raw key preset, YAN-642).
  const [customKey, setCustomKey] = useState(null);
  const [pickerKey, setPickerKey] = useState(0);
  const keyPresets = useSyncExternalStore(subscribeKeyPresets, readKeyPresets, () => EMPTY);
  const savedPresets = useSyncExternalStore(subscribePresets, readPresets, () => EMPTY);

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

  const defaults = useMemo(
    () => ({
      models: Object.fromEntries(
        (tool.defaultModels || []).map((m) => [m.alias, m.defaultValue || ""]),
      ),
      endpoint: "",
      apiKeyId: "",
      autoCompactWindow: "",
      oneMContext: false,
      exaMcpEnabled: false,
    }),
    [tool.defaultModels],
  );

  // On the host, the installed config fills fields the user hasn't saved yet.
  const disk = useMemo(() => {
    if (!claudeStatus?.installed) return null;
    const env = claudeStatus.settings?.env || {};
    return {
      models: Object.fromEntries(
        (tool.defaultModels || []).map((m) => [m.alias, env[m.envKey] || m.defaultValue || ""]),
      ),
      endpoint: env.ANTHROPIC_BASE_URL || undefined,
      apiKeyId: apiKeys.find((k) => k.key === env.ANTHROPIC_AUTH_TOKEN)?.id,
      autoCompactWindow: env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || undefined,
      oneMContext: Boolean(tool.defaultModels?.some((m) => env[m.envKey]?.endsWith("[1m]"))),
      exaMcpEnabled: Boolean(claudeStatus.exaMcpEnabled),
    };
  }, [claudeStatus, tool.defaultModels, apiKeys]);

  const [values, setField, settings] = useToolSettings("claude", defaults, disk);
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
  // A saved endpoint follows its option's current URL (YAN-647).
  const savedEndpoint = savedEndpointUrl(values, endpointContext, savedPresets);
  const { models: modelMappings, autoCompactWindow, oneMContext, exaMcpEnabled } = values;
  const diskToken = claudeStatus?.installed
    ? claudeStatus.settings?.env?.ANTHROPIC_AUTH_TOKEN || ""
    : "";
  const selectedApiKey = resolveSelectedApiKey({
    customKey,
    apiKeys,
    keyPresets,
    values,
    fallback: diskToken,
  });

  const handleApiKeyChange = (key) => {
    const patch = apiKeyPatch(key, apiKeys, keyPresets);
    if (!patch) return setCustomKey(key);
    setCustomKey(null);
    settings.setFields(patch);
  };

  const handleEndpointChange = (url, meta) => {
    if (meta?.init) setInitUrl(url);
    else settings.setFields({ endpoint: url, endpointId: meta?.id });
  };

  const handleResetDefaults = async () => {
    if (!(await settings.reset())) return;
    setCustomKey(null);
    setInitUrl("");
    setPickerKey((k) => k + 1);
  };

  const handleLoadFromFile = () => {
    settings.loadFromDisk();
    // The saved endpoint id would keep winning over the file URL, so clear it.
    if (values.endpointId) settings.setFields({ endpointId: undefined });
    setCustomKey(null);
    setPickerKey((k) => k + 1);
  };

  const withContextMarker = (value, enabled) => {
    const { model } = stripModelContextMarker(value);
    return enabled ? `${model}[1m]` : model;
  };

  const handleOneMContextToggle = (enabled) => {
    const next = { ...modelMappings };
    tool.defaultModels?.forEach((m) => {
      if (next[m.alias]) next[m.alias] = withContextMarker(next[m.alias], enabled);
    });
    settings.setFields({ oneMContext: enabled, models: next });
  };

  const handleModelChange = (alias, val) => {
    setField("models", { ...modelMappings, [alias]: val });
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

  const getEffectiveBaseUrl = () => {
    const u = savedEndpoint || initUrl || baseUrl || "http://localhost:20128/v1";
    return u.endsWith("/v1") ? u : `${u}/v1`;
  };

  const buildEnv = (apiKey) => {
    const env = { ANTHROPIC_BASE_URL: getEffectiveBaseUrl() };
    if (apiKey) env.ANTHROPIC_AUTH_TOKEN = apiKey;
    tool.defaultModels?.forEach((m) => {
      const target = modelMappings[m.alias];
      if (target && m.envKey) env[m.envKey] = target;
    });
    return env;
  };

  const handleApply = async () => {
    setApplying(true);
    setMessage(null);
    try {
      const env = buildEnv(resolveApiKey(selectedApiKey, apiKeys, cloudEnabled));
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
        // Saved card preferences stay; "Reset to defaults" clears those.
        setMessage({ type: "success", text: "Settings reset successfully." });
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

  const getManualConfigs = () =>
    toManualConfigs(
      buildClaudeConfig({
        env: buildEnv(manualApiKey(selectedApiKey, apiKeys, cloudEnabled)),
        exaMcpEnabled,
        autoCompactWindow,
      }),
    );

  const derived = deriveToolStatus(tool, claudeStatus);
  const isCombo = (val) => {
    const { model } = stripModelContextMarker(val || "");
    return Boolean(model && (modelAliases[model] || model.startsWith("claude-")));
  };

  return (
    <>
      <SetupScaffold
        tool={tool}
        status={derived}
        version={claudeStatus?.installed ? "detected" : undefined}
        checking={checking || !settings.loaded}
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
        saveStatus={settings.status}
        onResetDefaults={settings.hasSaved ? handleResetDefaults : undefined}
        differsHint={settings.differs.length ? "~/.claude/settings.json" : undefined}
        onLoadFromFile={handleLoadFromFile}
      >
        <EndpointSegmentedPicker
          key={pickerKey}
          value={savedEndpoint || initUrl || baseUrl}
          savedUrl={savedEndpoint}
          onChange={handleEndpointChange}
          requiresExternalUrl={tool.requiresExternalUrl}
          tunnelEnabled={tunnelEnabled}
          tunnelPublicUrl={tunnelPublicUrl}
          tailscaleEnabled={tailscaleEnabled}
          tailscaleUrl={tailscaleUrl}
          cloudEnabled={cloudEnabled}
          cloudUrl={cloudUrl}
        />

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">API key</span>
          <ApiKeySelect
            value={selectedApiKey}
            onChange={handleApiKeyChange}
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
            onChange={(v) => setField("autoCompactWindow", v)}
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
            onChange={(v) => setField("exaMcpEnabled", v)}
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
