"use client";

import PropTypes from "prop-types";
import { useCallback, useContext, useState } from "react";
import Link from "next/link";
import Button from "@/shared/components/Button";
import Toggle from "@/shared/components/Toggle";
import { autoPingConnections } from "./providersModelsHelpers";
import ProviderTile from "@/shared/components/ProviderTile";
import { SettingsScopeContext, loadSettingsValue, patchSettings } from "../settingsApi";

/**
 * Per-connection auto-ping list for one provider family.
 * @param {object} props
 * @param {string} props.providerId Provider family ("claude" | "codex").
 * @param {string} props.label Human label.
 * @param {string} props.settingKey Stored key (claudeAutoPing | codexAutoPing).
 * @param {object} props.settings Settings payload from GET /api/settings.
 * @param {(patch: object) => void} [props.onSettingsChange] Saved-value reporter.
 */

export default function AutoPingList({
  providerId,
  label,
  settingKey,
  settings,
  onSettingsChange,
}) {
  const [connections, setConnections] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState({});
  const scope = useContext(SettingsScopeContext);
  const load = useCallback(async () => {
    setLoadError("");
    try {
      const res = await fetch("/api/providers", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setConnections((data.connections || []).filter((conn) => conn.provider === providerId));
    } catch {
      setLoadError("Could not load connections");
      setConnections([]);
    }
  }, [providerId]);
  const map = autoPingConnections(settings[settingKey]);
  const toggle = useCallback(
    async (connectionId, on) => {
      setSaving((prev) => ({ ...prev, [connectionId]: true }));
      try {
        const raw = await loadSettingsValue(settingKey, scope);
        const next = {
          ...(raw || {}),
          connections: { ...autoPingConnections(raw), [connectionId]: on },
        };
        const saved = await patchSettings({ [settingKey]: next }, scope);
        onSettingsChange?.({ [settingKey]: saved[settingKey] ?? next });
      } catch {
        setLoadError("Could not save auto-ping");
      } finally {
        setSaving((prev) => ({ ...prev, [connectionId]: false }));
      }
    },
    [onSettingsChange, scope, settingKey],
  );
  return (
    <div className="mt-3 rounded-xl border border-line bg-raised p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <ProviderTile providerId={providerId} size="md" />
          <div>
            <p className="text-sm font-semibold text-text">Auto-ping · {label}</p>
            <p className="font-mono text-[11px] text-subtle">{settingKey}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/dashboard/providers/${providerId}`}
            className="text-[13px] font-semibold text-coral-ink hover:text-coral"
          >
            Open {label}{" "}
            <span aria-hidden="true" className="inline-block rtl:-scale-x-100">
              →
            </span>
          </Link>
          <Button variant="ghost" size="sm" onClick={load}>
            Load connections
          </Button>
        </div>
      </div>
      {loadError && (
        <p className="pt-2 text-xs text-err" role="alert">
          {loadError}
        </p>
      )}
      {connections === null ? (
        <p className="pt-2 text-[13px] text-muted">
          Per-connection switches live on the provider page too. Load the list to edit them here.
        </p>
      ) : connections.length === 0 ? (
        <p className="pt-2 text-[13px] text-muted">
          No {label} connections yet.{" "}
          <Link
            href={`/dashboard/providers/${providerId}`}
            className="font-semibold text-coral-ink hover:text-coral"
          >
            Add one on the Providers page
          </Link>
          .
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {connections.map((conn) => (
            <li key={conn.id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-text">
                {conn.name || conn.id}
              </span>
              <Toggle
                checked={map[conn.id] === true}
                onChange={(next) => toggle(conn.id, next)}
                disabled={saving[conn.id] === true}
                aria-label={`Auto-ping ${conn.name || conn.id}`}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
AutoPingList.propTypes = {
  providerId: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
  settingKey: PropTypes.string.isRequired,
  settings: PropTypes.object.isRequired,
  onSettingsChange: PropTypes.func,
};
