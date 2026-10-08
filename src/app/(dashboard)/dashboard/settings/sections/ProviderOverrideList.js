"use client";

import PropTypes from "prop-types";
import { useContext, useEffect, useMemo, useState } from "react";
import { SettingsScopeContext } from "@/shared/hooks/settingsScopeContext";
import { loadSettingsValue, patchSettings } from "@/shared/utils/settingsApi";
import Button from "@/shared/components/Button";
import Select from "@/shared/components/Select";
import NumberStepper from "@/shared/components/NumberStepper";
import ProviderTile from "@/shared/components/ProviderTile";
import Modal from "@/shared/components/Modal";
import { applyProviderOverride, removeProviderOverride } from "./routingSettings";

const ROW_STRATEGY_OPTIONS = [
  { value: "fill-first", label: "Fill first" },
  { value: "round-robin", label: "Round robin" },
  { value: "weighted", label: "Weighted" },
];

const ADD_STRATEGY_OPTIONS = ROW_STRATEGY_OPTIONS;

/**
 * Pick a provider display name from /api/providers connections (human name)
 * or /api/provider-nodes (node name). Falls back to the raw id.
 * @param {object} entry Provider/node entry.
 * @returns {string} Display name.
 */
export function providerDisplayName(entry) {
  if (!entry || typeof entry !== "object") return "";
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (name && name !== entry.id) return name;
  if (typeof entry.displayName === "string" && entry.displayName.trim()) {
    return entry.displayName.trim();
  }
  return entry.id || "";
}

/**
 * Per-provider routing overrides: list with inline strategy/sticky editing,
 * add modal with a real provider picker, remove. PATCHes the whole map but
 * always applies the edit to a freshly GET map, so concurrent edits from the
 * provider page or proxy-pool card are preserved.
 */
export default function ProviderOverrideList({ overrides, onOverridesChange }) {
  const [providers, setProviders] = useState([]);
  const [providersError, setProvidersError] = useState("");
  const [saving, setSaving] = useState(false);
  const [mapError, setMapError] = useState("");
  const [adding, setAdding] = useState(false);
  const [newProvider, setNewProvider] = useState("");
  const [newStrategy, setNewStrategy] = useState("round-robin");
  const [newSticky, setNewSticky] = useState(1);
  const [addError, setAddError] = useState("");
  const scope = useContext(SettingsScopeContext);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [connectionsRes, nodesRes] = await Promise.all([
          fetch("/api/providers", { cache: "no-store" }),
          fetch("/api/provider-nodes", { cache: "no-store" }),
        ]);
        const seen = new Map();
        if (connectionsRes.ok) {
          const { connections } = await connectionsRes.json();
          for (const c of connections || []) {
            if (c?.provider && !seen.has(c.provider)) {
              seen.set(c.provider, { id: c.provider, name: c.name || c.provider });
            }
          }
        }
        if (nodesRes.ok) {
          const { nodes } = await nodesRes.json();
          for (const n of nodes || []) {
            if (n?.id && !seen.has(n.id)) seen.set(n.id, { id: n.id, name: n.name || n.id });
          }
        }
        if (!cancelled) {
          setProviders([...seen.values()].sort((a, b) => a.id.localeCompare(b.id)));
          setProvidersError("");
        }
      } catch {
        if (!cancelled) setProvidersError("Could not load providers.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const availableProviders = useMemo(() => {
    const listed = providers.map((p) => ({
      value: p.id,
      label: providerDisplayName(p) === p.id ? p.id : `${providerDisplayName(p)} (${p.id})`,
    }));
    const known = new Set(listed.map((p) => p.value));
    for (const id of Object.keys(overrides)) {
      if (!known.has(id)) listed.push({ value: id, label: id });
    }
    return listed.sort((a, b) => a.value.localeCompare(b.value));
  }, [providers, overrides]);

  /**
   * Apply an edit to the latest server map, then PATCH the whole map.
   * @param {(current: Record<string, object>) => Record<string, object>} update
   */
  const saveMap = async (update) => {
    setSaving(true);
    setMapError("");
    const previous = overrides;
    try {
      let loaded;
      try {
        loaded = await loadSettingsValue("providerStrategies", scope);
      } catch {
        throw new Error("Could not load current overrides.");
      }
      const current = loaded && typeof loaded === "object" ? loaded : {};
      const next = update(current);
      onOverridesChange?.(next);
      let saved;
      try {
        saved = await patchSettings({ providerStrategies: next }, scope);
      } catch (err) {
        throw new Error(
          err instanceof Error && err.message !== "Failed to save setting"
            ? err.message
            : "Could not save overrides.",
        );
      }
      onOverridesChange?.(saved.providerStrategies ?? next);
    } catch (err) {
      onOverridesChange?.(previous);
      setMapError(err instanceof Error ? err.message : "Could not save overrides.");
    } finally {
      setSaving(false);
    }
  };

  const handleRowChange = (providerId, key, raw) => {
    const base = overrides[providerId] || {};
    saveMap((current) =>
      applyProviderOverride(
        current,
        providerId,
        key === "strategy"
          ? {
              fallbackStrategy: raw || "",
              stickyRoundRobinLimit: base.stickyRoundRobinLimit ?? "",
            }
          : {
              fallbackStrategy: base.fallbackStrategy || "",
              stickyRoundRobinLimit: raw === "" ? "" : Number(raw),
            },
      ),
    );
  };

  const handleRemove = (providerId) => {
    saveMap((current) => removeProviderOverride(current, providerId));
  };

  const openAdd = () => {
    setNewProvider("");
    setNewStrategy("round-robin");
    setNewSticky(1);
    setAddError("");
    setAdding(true);
  };

  const handleAdd = () => {
    if (!newProvider) {
      setAddError("Pick a provider.");
      return;
    }
    if (Object.hasOwn(overrides, newProvider)) {
      setAddError("That provider already has an override — edit it instead.");
      return;
    }
    setAdding(false);
    saveMap((current) =>
      applyProviderOverride(current, newProvider, {
        fallbackStrategy: newStrategy,
        stickyRoundRobinLimit: newSticky,
      }),
    );
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="min-w-52 flex-1">
          <p className="text-[15px] font-semibold text-text">Per-provider overrides</p>
          <p className="mt-0.5 text-[13px] text-muted">
            Beat the global strategy for one provider.
          </p>
          <p className="mt-0.5 font-mono text-[11px] text-subtle">providerStrategies</p>
        </div>
        <Button variant="secondary" size="sm" icon="add" onClick={openAdd}>
          Add
        </Button>
      </div>
      {providersError && (
        <p className="pt-2 text-xs text-err" role="alert">
          {providersError}
        </p>
      )}
      {mapError && (
        <p className="pt-2 text-xs text-err" role="alert">
          {mapError}
        </p>
      )}
      <div className="pt-3">
        {Object.keys(overrides).length === 0 ? (
          <p className="text-sm text-muted">
            No overrides yet. Every provider follows the global strategy above.
          </p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {Object.keys(overrides)
              .sort()
              .map((providerId) => {
                const entry = overrides[providerId] || {};
                const label =
                  availableProviders.find((p) => p.value === providerId)?.label || providerId;
                return (
                  <li key={providerId} className="flex flex-wrap items-center gap-3 p-3">
                    <ProviderTile providerId={providerId} size="md" />
                    <div className="min-w-40 flex-1">
                      <p className="text-sm font-semibold text-text">{label}</p>
                      <p className="font-mono text-[11px] text-subtle">{providerId}</p>
                    </div>
                    <Select
                      label="Override strategy"
                      value={entry.fallbackStrategy || ""}
                      onChange={(e) => handleRowChange(providerId, "strategy", e.target.value)}
                      options={ROW_STRATEGY_OPTIONS}
                      placeholder="Inherit global"
                      disabled={saving}
                      className="w-44"
                    />
                    <NumberStepper
                      label="Override sticky"
                      value={entry.stickyRoundRobinLimit ?? ""}
                      onChange={(next) => handleRowChange(providerId, "sticky", next)}
                      min={1}
                      max={100}
                      disabled={saving}
                      aria-label={`Sticky limit for ${providerId}`}
                      className="w-40"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="delete"
                      onClick={() => handleRemove(providerId)}
                      disabled={saving}
                      aria-label={`Remove override for ${providerId}`}
                    >
                      Remove
                    </Button>
                  </li>
                );
              })}
          </ul>
        )}
      </div>

      <Modal
        isOpen={adding}
        onClose={() => setAdding(false)}
        title="Add provider override"
        description="Beat the global strategy for one provider."
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button onClick={handleAdd} disabled={!newProvider || saving}>
              Add override
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Select
            label="Provider"
            value={newProvider}
            onChange={(e) => setNewProvider(e.target.value)}
            options={availableProviders.filter((p) => !Object.hasOwn(overrides, p.value))}
            placeholder={providers.length === 0 ? "No providers found" : "Pick a provider"}
            error={addError}
          />
          <Select
            label="Strategy"
            value={newStrategy}
            onChange={(e) => setNewStrategy(e.target.value)}
            options={ADD_STRATEGY_OPTIONS}
          />
          <NumberStepper
            label="Sticky limit"
            value={newSticky}
            onChange={(next) => setNewSticky(Number(next) || 1)}
            min={1}
            max={100}
            hint="Calls per account before rotating."
          />
        </div>
      </Modal>
    </div>
  );
}

ProviderOverrideList.propTypes = {
  overrides: PropTypes.object.isRequired,
  onOverridesChange: PropTypes.func,
};
