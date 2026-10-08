"use client";
import PropTypes from "prop-types";
import { useCallback, useContext, useState } from "react";
import SectionCard from "@/shared/components/SectionCard";
import SettingRow from "@/shared/components/SettingRow";
import Toggle from "@/shared/components/Toggle";
import ProviderTile from "@/shared/components/ProviderTile";
import Select from "@/shared/components/Select";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import CopyField from "@/shared/components/CopyField";
import { getModelsByProviderId } from "@/shared/constants/models";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { useSettingsField } from "../useSettingsField";
import { SettingsScopeContext, loadSettingsValue, patchSettings } from "../settingsApi";
import AutoPingList from "./AutoPingList";

import {
  hiddenKeysForProvider,
  providersWithThinking,
  quotaProviders,
  setProviderThinkingMode,
  setQuotaHiddenKey,
  unionThinkingLevels,
} from "./providersModelsHelpers";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";

const DEFAULT_THINKING_PROVIDERS = [
  "claude",
  "codex",
  "gemini-cli",
  "antigravity",
  "kiro",
  "cursor",
];

const AUTO_PING_PROVIDERS = [
  { id: "claude", label: "Claude Code", settingKey: "claudeAutoPing" },
  { id: "codex", label: "OpenAI Codex", settingKey: "codexAutoPing" },
];
// Client pins are env-only: read from GET /api/settings when the server
// exposes them, never writable (validateSectionSettings rejects writes).

const CLIENT_PINS = [
  { key: "CLAUDE_CLI_VERSION", label: "Claude CLI" },
  { key: "CODEX_CLI_VERSION", label: "Codex CLI" },
  { key: "GROK_CLI_VERSION", label: "Grok CLI" },
  { key: "ZED_CLIENT_VERSION", label: "Zed client" },
];

function FieldError({ error }) {
  if (!error) return null;
  return (
    <p className="py-2 text-xs text-err" role="alert">
      {error}
    </p>
  );
}
FieldError.propTypes = { error: PropTypes.string };

function thinkingModelIds(providerId) {
  try {
    return (getModelsByProviderId(providerId) || []).map((model) => model.id);
  } catch {
    return [];
  }
}

/**
 * Providers & models section: per-provider thinking defaults (union-aware,
 * same PATCH shape as providers/[id]/page.js), per-connection auto-ping
 * lists (no invented global toggle), ccFilterNaming, quotaVisibility
 * editor (same stored shape as the Usage page), mitmRouterBaseUrl and
 * read-only client pins.
 */

export default function ProvidersModelsSection({
  settings,
  onSettingsChange,
  canManageInstance = true,
}) {
  const scope = useContext(SettingsScopeContext);
  const onSaved = (key) => (value) => onSettingsChange?.({ [key]: value });
  const providerThinking = settings.providerThinking || {};
  const thinkingProviders = providersWithThinking(
    DEFAULT_THINKING_PROVIDERS,
    thinkingModelIds,
    getThinkingLevels,
  );
  const ccFilterNaming = useSettingsField("ccFilterNaming", settings.ccFilterNaming === true, {
    onSaved: onSaved("ccFilterNaming"),
  });
  const mitmUrl = useSettingsField(
    "mitmRouterBaseUrl",
    settings.mitmRouterBaseUrl ?? DEFAULT_MITM_ROUTER_BASE,
    { debounced: true, onSaved: onSaved("mitmRouterBaseUrl") },
  );
  const [thinkingUpdating, setThinkingUpdating] = useState({});
  const [thinkingErrors, setThinkingErrors] = useState({});
  const [quotaKeyDrafts, setQuotaKeyDrafts] = useState({});
  const [quotaError, setQuotaError] = useState("");
  const [quotaSaving, setQuotaSaving] = useState(false);
  const patchOneKey = useCallback(
    async (key, value) => {
      const data = await patchSettings({ [key]: value }, scope);
      return Object.hasOwn(data, key) ? data[key] : value;
    },
    [scope],
  );
  const loadFresh = useCallback(
    async (key) => (await loadSettingsValue(key, scope)) || {},
    [scope],
  );
  const saveThinkingMode = useCallback(
    async (providerId, mode) => {
      setThinkingUpdating((prev) => ({ ...prev, [providerId]: true }));
      setThinkingErrors((prev) => ({ ...prev, [providerId]: "" }));
      try {
        const updated = setProviderThinkingMode(
          await loadFresh("providerThinking"),
          providerId,
          mode,
        );
        const saved = await patchOneKey("providerThinking", updated);
        onSettingsChange?.({ providerThinking: saved });
      } catch (err) {
        setThinkingErrors((prev) => ({
          ...prev,
          [providerId]: err instanceof Error ? err.message : "Failed to save",
        }));
      } finally {
        setThinkingUpdating((prev) => ({ ...prev, [providerId]: false }));
      }
    },
    [onSettingsChange, patchOneKey, loadFresh],
  );
  const saveQuotaVisibility = useCallback(
    async (next) => {
      setQuotaSaving(true);
      setQuotaError("");
      try {
        // Whole-map PATCH after local edit (same shape as the Usage page).
        // Caller edits are authoritative for touched providers: merge the
        // fresh server map under `next` so concurrent removals elsewhere win.
        const fresh = await loadFresh("quotaVisibility");
        const merged = { ...fresh, ...next };
        // Drop empty rows only when the entry carries nothing else: extra
        // keys are preserved by the API validator, so keep them.
        for (const provider of Object.keys(merged)) {
          const entry = merged[provider];
          if (
            entry &&
            typeof entry === "object" &&
            Array.isArray(entry.hidden) &&
            entry.hidden.length === 0 &&
            Object.keys(entry).length === 1 &&
            // Only auto-delete providers the caller edited, never resurrect
            // or delete untouched server rows on a partial edit.
            Object.hasOwn(next, provider)
          ) {
            delete merged[provider];
          }
        }
        const saved = await patchOneKey("quotaVisibility", merged);
        onSettingsChange?.({ quotaVisibility: saved });
      } catch (err) {
        setQuotaError(err instanceof Error ? err.message : "Failed to save");
      } finally {
        setQuotaSaving(false);
      }
    },
    [onSettingsChange, patchOneKey, loadFresh],
  );
  const quotaVisibility = settings.quotaVisibility || {};
  const quotaProviderIds = quotaProviders(quotaVisibility);
  return (
    <div id="providers" className="scroll-mt-24 space-y-4">
      <SectionCard
        icon="dns"
        title="Providers & models"
        subtitle="Defaults that apply across providers."
      />
      <div className="rounded-2xl border border-line bg-panel p-5 shadow-card divide-y divide-line">
        <div className="py-4">
          <p className="text-[15px] font-semibold text-text">Default thinking level</p>
          <p className="mt-0.5 text-[13px] text-muted">
            Used when a request does not ask for one. Only providers with thinking levels are
            listed.
          </p>
          <p className="mt-0.5 font-mono text-[11px] text-subtle">providerThinking</p>
          {thinkingProviders.length === 0 ? (
            <p className="mt-2 text-sm text-muted">No provider with thinking levels found.</p>
          ) : (
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {thinkingProviders.map((providerId) => {
                const levels = unionThinkingLevels(
                  providerId,
                  thinkingModelIds(providerId),
                  getThinkingLevels,
                );
                const current = providerThinking[providerId]?.mode || "auto";
                return (
                  <div key={providerId}>
                    <Select
                      label={
                        <span className="inline-flex items-center gap-2">
                          <ProviderTile providerId={providerId} size="sm" />
                          {providerId}
                        </span>
                      }
                      value={current}
                      onChange={(e) => saveThinkingMode(providerId, e.target.value)}
                      disabled={thinkingUpdating[providerId] === true}
                      options={(levels || ["auto"]).map((level) => ({
                        value: level,
                        label: level === "auto" ? "Auto" : level,
                      }))}
                      error={thinkingErrors[providerId] || undefined}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="py-4">
          <p className="text-[15px] font-semibold text-text">Auto-ping quota windows</p>
          <p className="mt-0.5 text-[13px] text-muted">
            A tiny request keeps quota windows warm. Per connection only — there is no global
            switch.
          </p>
          {AUTO_PING_PROVIDERS.map(({ id, label, settingKey }) => (
            <AutoPingList
              key={id}
              providerId={id}
              label={label}
              settingKey={settingKey}
              settings={settings}
              onSettingsChange={onSettingsChange}
            />
          ))}
        </div>
        <SettingRow
          label="Filter naming requests"
          description="Drop Claude Code title-naming calls to save quota."
          settingKey="ccFilterNaming"
          control={
            <Toggle
              checked={ccFilterNaming.value === true}
              onChange={(next) => ccFilterNaming.set(next)}
              disabled={ccFilterNaming.saving}
              aria-label="Filter naming requests"
            />
          }
        />
        <FieldError error={ccFilterNaming.error} />
        <div className="py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-52 flex-1">
              <p className="text-[15px] font-semibold text-text">Quota rows shown</p>
              <p className="mt-0.5 text-[13px] text-muted">
                Pick which limits appear on the Quota page. Same store as Usage → Limits.
              </p>
              <p className="mt-0.5 font-mono text-[11px] text-subtle">quotaVisibility</p>
            </div>
            <Button variant="secondary" size="sm" icon="tune" href="/dashboard/quota">
              Choose on Quota page
            </Button>
          </div>
          {quotaError && (
            <p className="pt-2 text-xs text-err" role="alert">
              {quotaError}
            </p>
          )}
          {quotaProviderIds.length === 0 ? (
            <p className="pt-2 text-sm text-muted">
              All quota rows are shown. Hide a row below by provider and key.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {quotaProviderIds.map((providerId) => (
                <li
                  key={providerId}
                  className="rounded-lg border border-line bg-raised p-3 text-sm"
                >
                  <p className="flex items-center gap-2 font-mono text-xs text-text">
                    <ProviderTile providerId={providerId} size="sm" />
                    {providerId}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {hiddenKeysForProvider(quotaVisibility, providerId).map((key) => (
                      <span
                        key={key}
                        className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 font-mono text-xs text-muted"
                      >
                        {key}
                        <button
                          type="button"
                          aria-label={`Show ${key}`}
                          disabled={quotaSaving}
                          onClick={() =>
                            saveQuotaVisibility(
                              setQuotaHiddenKey(quotaVisibility, providerId, key, false),
                            )
                          }
                          className="text-coral-ink hover:text-coral disabled:opacity-50"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
              <Input
                label="Provider"
                value={quotaKeyDrafts.provider ?? ""}
                onChange={(e) =>
                  setQuotaKeyDrafts((prev) => ({ ...prev, provider: e.target.value }))
                }
                placeholder="claude"
                inputClassName="font-mono"
                aria-label="Quota provider"
              />
              <Input
                label="Quota key"
                value={quotaKeyDrafts.key ?? ""}
                onChange={(e) => setQuotaKeyDrafts((prev) => ({ ...prev, key: e.target.value }))}
                placeholder="weekly-5h"
                inputClassName="font-mono"
                aria-label="Quota key"
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              loading={quotaSaving}
              disabled={quotaSaving}
              onClick={() => {
                try {
                  const provider = String(quotaKeyDrafts.provider || "").trim();
                  const key = String(quotaKeyDrafts.key || "").trim();
                  const next = setQuotaHiddenKey(quotaVisibility, provider, key, true);
                  setQuotaKeyDrafts({});
                  saveQuotaVisibility(next);
                } catch (err) {
                  setQuotaError(err instanceof Error ? err.message : "Invalid quota key");
                }
              }}
            >
              Hide row
            </Button>
          </div>
        </div>
        {/* YAN-371 (D13): mitmRouterBaseUrl is an instance key; admins only. */}
        {canManageInstance && (
          <>
            <SettingRow
              label="Intercept (MITM) router URL"
              description="Base URL the MITM server routes through. Same behavior as the MITM card."
              settingKey="mitmRouterBaseUrl"
              control={
                <div className="w-full sm:min-w-72 sm:max-w-sm">
                  <Input
                    value={mitmUrl.value ?? ""}
                    onChange={(e) => mitmUrl.set(e.target.value)}
                    disabled={mitmUrl.saving}
                    placeholder={DEFAULT_MITM_ROUTER_BASE}
                    inputClassName="font-mono"
                    aria-label="Intercept router URL"
                  />
                </div>
              }
            />
            <FieldError error={mitmUrl.error} />
          </>
        )}
        <div className="py-4">
          <p className="text-[15px] font-semibold text-text">Client version pins</p>
          <p className="mt-0.5 text-[13px] text-muted">
            Read from .env at startup. Read-only here.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {CLIENT_PINS.map(({ key, label }) => (
              <div key={key}>
                <p className="mb-1 text-[13px] font-semibold text-text">{label}</p>
                <p className="mb-1 font-mono text-[11px] text-subtle">{key}</p>
                <CopyField value={settings[key] ? String(settings[key]) : "not set"} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
ProvidersModelsSection.propTypes = {
  settings: PropTypes.object.isRequired,
  onSettingsChange: PropTypes.func,
  canManageInstance: PropTypes.bool,
};
