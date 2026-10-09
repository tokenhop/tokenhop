"use client";

import { useState, useEffect, useCallback } from "react";
import PropTypes from "prop-types";
import Link from "next/link";
import {
  Button,
  CopyField,
  IconButton,
  Meter,
  ModelChip,
  ProviderTile,
  SegmentedControl,
  StatusPill,
  Toggle,
  Skeleton,
} from "@/shared/components";
import { ACCOUNT_STRATEGY_OPTIONS } from "@/shared/constants/accountStrategies";
import { getProviderAlias } from "@/shared/constants/providers";
import { getModelsByProviderId } from "@/shared/constants/models";
import { fetchSuggestedModels } from "@/shared/utils/providerModelsFetcher";
import { getProviderCustomModelRows } from "@/shared/utils/providerCustomModels";
import { useNotificationStore } from "@/store/notificationStore";
import { getRelativeTime } from "@/shared/utils";
import CooldownTimer from "@/shared/components/CooldownTimer";
import { connectionHealth } from "@/shared/utils/providerHealth";
import { useSettingsScope } from "@/shared/hooks/useSettingsScope";
import { loadSettings, loadOwnedMap, onHttpError, patchSettings } from "@/shared/utils/settingsApi";
import ConnectionSharing from "./ConnectionSharing";
import { withWorkspace } from "../connectTarget";

const shortLabel = (label) => String(label).split(" — ")[0];

const AUTH_PILL_VARIANT = {
  oauth: "info",
  free: "live",
  apikey: "brand",
  compatible: "neutral",
};

const AUTH_PILL_LABEL = {
  oauth: "OAuth",
  free: "Free",
  apikey: "API key",
  compatible: "Compatible",
};

function AccountItem({ connection, index, quotaSnapshot, onToggle, onClearCooldown, onShared }) {
  const health = connectionHealth(connection);
  const until = health.until;
  const displayName = connection.name || connection.email || connection.displayName || "Account";
  const sub =
    connection.email && connection.name
      ? connection.email
      : connection.email || connection.displayName || "";
  const disabled = health.status === "off";
  const status = {
    variant: { off: "neutral", ok: "ok", warn: "warn", err: "err" }[health.status],
    label: { off: "Off", ok: "Active", warn: "Cooldown", err: "Error" }[health.status],
  };

  const windows = quotaSnapshot?.windows || [];
  const primaryWindow = windows[0];

  return (
    <div className="flex min-w-0 flex-col gap-2.5 border-t border-line py-3.5 first:border-t-0">
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden="true"
          className={`flex size-7 shrink-0 items-center justify-center rounded-full font-mono text-xs font-semibold ${
            disabled ? "bg-line text-muted" : "bg-text text-bg"
          }`}
        >
          {index + 1}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className={`truncate text-sm font-semibold ${disabled ? "text-muted" : ""}`}>
            {displayName}
          </span>
          {sub && <span className="truncate font-mono text-xs text-muted">{sub}</span>}
        </div>
        <ConnectionSharing connection={connection} onShared={onShared} />
        <StatusPill variant={status.variant} size="sm">
          {status.label}
        </StatusPill>
        <Toggle
          size="sm"
          checked={!disabled}
          onChange={(next) => onToggle(next)}
          aria-label={`${displayName} enabled`}
        />
      </div>

      {until ? (
        <div className="flex items-center gap-2 ps-9.5">
          <div className="flex-1">
            <Meter value={100} label={`${displayName} cooldown`} valueText="Rate limited" />
          </div>
          <CooldownTimer until={until} />
          <button
            type="button"
            onClick={onClearCooldown}
            className="text-xs font-semibold text-coral-ink hover:text-coral focus-visible:outline-none focus-visible:shadow-focus"
          >
            Retry
          </button>
        </div>
      ) : primaryWindow ? (
        <div className="flex items-center gap-2 ps-9.5">
          <div className="flex-1">
            <Meter
              value={Math.round((1 - primaryWindow.usedFraction) * 100)}
              label={`${displayName} quota remaining`}
              valueText={`${Math.round((1 - primaryWindow.usedFraction) * 100)}% remaining`}
            />
          </div>
          <span className="text-xs whitespace-nowrap text-muted">
            {Math.round((1 - primaryWindow.usedFraction) * 100)}% left
            {primaryWindow.resetsAt ? ` · resets ${getRelativeTime(primaryWindow.resetsAt)}` : ""}
          </span>
        </div>
      ) : null}
    </div>
  );
}

AccountItem.propTypes = {
  connection: PropTypes.object.isRequired,
  index: PropTypes.number.isRequired,
  quotaSnapshot: PropTypes.object,
  onToggle: PropTypes.func.isRequired,
  onClearCooldown: PropTypes.func.isRequired,
  onShared: PropTypes.func,
};

export default function ProviderDetailSidePanel({
  entry,
  connections,
  onClose,
  onChanged,
  onTestAccounts,
  onAddAccount,
  testingAccounts = false,
  inline = false,
}) {
  const notifySuccess = useNotificationStore((s) => s.success);
  const notifyError = useNotificationStore((s) => s.error);
  const [strategy, setStrategy] = useState(null);
  const [globalStrategy, setGlobalStrategy] = useState("fill-first");
  const [strategySaving, setStrategySaving] = useState(false);
  const [quotas, setQuotas] = useState({});
  const [customModels, setCustomModels] = useState([]);
  const [modelAliases, setModelAliases] = useState({});
  const [loading, setLoading] = useState(true);
  const { ready, scope, canManageInstance } = useSettingsScope();

  const isCompatible = entry.authGroup === "compatible";
  const alias = getProviderAlias(entry.id);

  const loadData = useCallback(async () => {
    try {
      const [data, customModelsRes, aliasesRes] = await Promise.all([
        loadSettings(scope, { canManageInstance }).catch(onHttpError(null)),
        fetch(withWorkspace("/api/models/custom", scope?.workspaceId), { cache: "no-store" }),
        fetch(withWorkspace("/api/models/alias", scope?.workspaceId), { cache: "no-store" }),
      ]);
      if (data) {
        const override = data.providerStrategies?.[entry.id] || {};
        setStrategy(override.fallbackStrategy || null);
        setGlobalStrategy(data.fallbackStrategy || "fill-first");
      }
      if (customModelsRes.ok) {
        const data = await customModelsRes.json();
        setCustomModels(data.models || []);
      }
      if (aliasesRes.ok) {
        const data = await aliasesRes.json();
        setModelAliases(data.aliases || {});
      }
      if (!isCompatible && entry.info.modelsFetcher?.url) {
        fetchSuggestedModels(entry.info.modelsFetcher).catch(() => {});
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [entry.id, entry.info.modelsFetcher, isCompatible, scope, canManageInstance]);

  useEffect(() => {
    if (ready) loadData();
  }, [ready, loadData]);

  useEffect(() => {
    let cancelled = false;
    const oauthConns = connections.filter((c) => c.authType === "oauth");
    Promise.all(
      oauthConns.map(async (c) => {
        try {
          const res = await fetch(`/api/usage/${c.id}`);
          if (!res.ok || cancelled) return;
          const data = await res.json();
          if (!cancelled) setQuotas((prev) => ({ ...prev, [c.id]: data.quotaSnapshot || null }));
        } catch {
          /* optional */
        }
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [connections]);

  const saveStrategy = async (value) => {
    setStrategySaving(true);
    try {
      const updated = await loadOwnedMap("providerStrategies", scope, [entry.id]);
      const override = { ...(updated[entry.id] || {}) };
      if (value) override.fallbackStrategy = value;
      else delete override.fallbackStrategy;
      if (Object.keys(override).length === 0) delete updated[entry.id];
      else updated[entry.id] = override;

      await patchSettings({ providerStrategies: updated }, scope);
      setStrategy(value);
      notifySuccess("Account strategy saved");
    } catch (error) {
      notifyError(error?.message || "Failed to save strategy");
    } finally {
      setStrategySaving(false);
    }
  };

  const handleToggle = async (connection, active) => {
    try {
      await fetch(`/api/providers/${connection.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: active }),
      });
      onChanged?.();
    } catch {
      notifyError("Failed to toggle connection");
    }
  };

  const handleClearCooldown = async (connection) => {
    const lockKeys = Object.keys(connection).filter(
      (k) => k.startsWith("modelLock_") && connection[k],
    );
    if (lockKeys.length === 0) return;
    const model = lockKeys[0].slice("modelLock_".length);
    try {
      const res = await fetch("/api/models/availability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clearCooldown", provider: entry.id, model }),
      });
      if (res.ok) {
        notifySuccess("Cooldown cleared");
        onChanged?.();
      } else {
        notifyError("Failed to clear cooldown");
      }
    } catch {
      notifyError("Failed to clear cooldown");
    }
  };

  const builtInModels = isCompatible
    ? []
    : getModelsByProviderId(entry.id).filter((m) => (m.kind || m.type || "llm") === "llm");
  const modelRows = isCompatible
    ? getProviderCustomModelRows({ customModels, modelAliases, providerAlias: alias })
    : [
        ...builtInModels.map((m) => ({
          id: m.id,
          fullModel: `${alias}/${m.id}`,
        })),
        ...getProviderCustomModelRows({
          customModels,
          modelAliases,
          providerAlias: alias,
          builtInModels,
        }),
      ];

  const shownModels = modelRows.slice(0, 6);
  const hiddenCount = modelRows.length - shownModels.length;
  const copyModel = modelRows[0]?.fullModel || `${alias}/model-id`;

  const authPill = {
    variant: AUTH_PILL_VARIANT[entry.authGroup] || "neutral",
    label: AUTH_PILL_LABEL[entry.authGroup] || entry.authGroup,
  };

  const content = (
    <div className="flex min-w-0 flex-col gap-5">
      {/* Header: Tile + Name + Pills + Close */}
      <div className="flex min-w-0 items-start gap-3.5">
        <ProviderTile providerId={entry.id} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h2 className="font-display text-[26px] font-bold leading-[1.1] text-text">
            {entry.info.name}
          </h2>
          <div className="flex flex-wrap gap-1.5" aria-live="polite">
            <StatusPill variant={authPill.variant} size="sm">
              {authPill.label}
            </StatusPill>
            <StatusPill
              variant={connections.length > 0 ? "ok" : "neutral"}
              size="sm"
              dot={connections.length > 0}
            >
              {connections.length > 0
                ? `${connections.length} ${connections.length === 1 ? "account" : "accounts"}`
                : "No accounts"}
            </StatusPill>
          </div>
        </div>
        {inline && (
          <IconButton icon="close" label={`Close ${entry.info.name} details`} onClick={onClose} />
        )}
      </div>

      {/* Action buttons: Test accounts + Add account */}
      <div className="flex gap-2.5">
        <Button
          size="sm"
          variant="secondary"
          className="flex-1"
          loading={testingAccounts}
          disabled={testingAccounts || connections.length === 0}
          onClick={onTestAccounts}
        >
          {testingAccounts ? "Testing…" : "Test accounts"}
        </Button>
        <Button size="sm" variant="primary" icon="add" className="flex-1" onClick={onAddAccount}>
          Add account
        </Button>
      </div>

      {/* Account strategy */}
      <div className="flex flex-col gap-2.5">
        <span
          id={`strategy-label-${entry.id}`}
          className="text-xs font-semibold tracking-[0.08em] text-muted uppercase"
        >
          When an account runs dry
        </span>
        <SegmentedControl
          aria-labelledby={`strategy-label-${entry.id}`}
          value={strategy || globalStrategy}
          onChange={saveStrategy}
          options={ACCOUNT_STRATEGY_OPTIONS.map((o) => ({
            value: o.value,
            label: shortLabel(o.label),
          }))}
        />
        {strategySaving && (
          <span className="text-xs text-muted" aria-live="polite">
            Saving…
          </span>
        )}
      </div>

      {/* Accounts list */}
      <div className="flex flex-col gap-1">
        <span className="mb-1 text-xs font-semibold tracking-[0.08em] text-muted uppercase">
          Accounts
        </span>
        {connections.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-sm text-muted">
            No accounts connected yet. Click Add account to connect.
          </p>
        ) : (
          connections.map((connection, index) => (
            <AccountItem
              key={connection.id}
              connection={connection}
              index={index}
              quotaSnapshot={quotas[connection.id]}
              onToggle={(active) => handleToggle(connection, active)}
              onClearCooldown={() => handleClearCooldown(connection)}
              onShared={onChanged}
            />
          ))
        )}
      </div>

      {/* Models section */}
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center">
          <span className="text-xs font-semibold tracking-[0.08em] text-muted uppercase">
            Models
          </span>
          <Link
            href={`/dashboard/providers/${entry.id}`}
            className="ms-auto text-[13px] font-semibold text-coral-ink hover:text-coral focus-visible:shadow-focus focus-visible:outline-none"
          >
            Manage
          </Link>
        </div>
        {loading ? (
          <Skeleton className="h-7 w-full" />
        ) : modelRows.length === 0 ? (
          <p className="text-sm text-muted">No models configured for this provider.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {shownModels.map((row) => (
              <ModelChip key={row.fullModel} model={row.fullModel} />
            ))}
            {hiddenCount > 0 && (
              <span className="font-mono text-xs text-muted">+{hiddenCount} more</span>
            )}
          </div>
        )}
      </div>

      {/* Point client at endpoint */}
      <div className="mt-auto flex flex-col gap-2 rounded-[14px] bg-raised p-3.5">
        <span className="text-[13px] text-muted">
          Point any client at your endpoint and ask for
        </span>
        <CopyField
          value={`"model": "${copyModel}"`}
          copyValue={copyModel}
          label="Copy model id snippet"
        />
      </div>

      {/* Link to full provider page */}
      <Link
        href={`/dashboard/providers/${entry.id}`}
        className="text-[13px] font-semibold text-coral-ink hover:text-coral focus-visible:shadow-focus focus-visible:outline-none"
      >
        Open full page →
      </Link>
    </div>
  );

  if (inline) {
    return (
      <aside
        aria-label={`${entry.info.name} details`}
        className="w-[400px] shrink-0 rounded-[20px] border border-line bg-panel p-6 shadow-card"
      >
        {content}
      </aside>
    );
  }

  return content;
}

ProviderDetailSidePanel.propTypes = {
  entry: PropTypes.object.isRequired,
  connections: PropTypes.array.isRequired,
  onClose: PropTypes.func.isRequired,
  onChanged: PropTypes.func,
  onTestAccounts: PropTypes.func,
  onAddAccount: PropTypes.func,
  testingAccounts: PropTypes.bool,
  inline: PropTypes.bool,
};
