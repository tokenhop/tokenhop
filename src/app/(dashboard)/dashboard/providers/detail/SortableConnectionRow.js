"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Toggle, StatusPill, Menu, MenuItem, Tooltip, Spinner } from "@/shared/components";
import CooldownTimer from "@/shared/components/CooldownTimer";
import { cooldownUntil, connectionHealth } from "@/shared/utils/providerHealth";
import { formatCooldownRemaining, weightSharePct } from "../detailUtils";

function formatWeight(value) {
  return Number.isFinite(value) ? String(Number(value.toFixed(2))) : "?";
}

function AuthIcon({ authType }) {
  const icon = authType === "cookie" ? "cookie" : authType === "oauth" ? "lock" : "key";
  return (
    <span className="material-symbols-outlined shrink-0 text-base text-muted" aria-hidden="true">
      {icon}
    </span>
  );
}

AuthIcon.propTypes = { authType: PropTypes.string.isRequired };

/**
 * Signal connection row with @dnd-kit sortable drag handle, priority bubble,
 * auth icon, status/auth/proxy/cooldown/weight pills, last error, test tags,
 * proxy menu, auto-ping, edit/delete and enable toggle. The up/down fallback
 * remains keyboard available.
 */
export default function SortableConnectionRow({
  connection,
  index,
  total,
  showHandle,
  proxyPools,
  isOAuth,
  showWeighted,
  totalWeight,
  activeCount,
  oneByOneStatus,
  autoPing,
  selected,
  onSelect,
  onToggleActive,
  onUpdateProxy,
  onEdit,
  onDelete,
  onMove,
}) {
  const [proxyUpdating, setProxyUpdating] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: connection.id,
  });
  const reducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const style = {
    transform: CSS.Transform.toString(transform),
    transition: reducedMotion ? undefined : transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  const proxyPoolMap = new Map((proxyPools || []).map((pool) => [pool.id, pool]));
  const boundProxyPoolId = connection.providerSpecificData?.proxyPoolId || null;
  const boundProxyPool = boundProxyPoolId ? proxyPoolMap.get(boundProxyPoolId) : null;
  const hasLegacyProxy =
    connection.providerSpecificData?.connectionProxyEnabled === true &&
    !!connection.providerSpecificData?.connectionProxyUrl;
  const hasAnyProxy = !!boundProxyPoolId || hasLegacyProxy;
  const proxyDisplayText = boundProxyPool
    ? `Pool: ${boundProxyPool.name}`
    : boundProxyPoolId
      ? `Pool: ${boundProxyPoolId} (inactive/missing)`
      : hasLegacyProxy
        ? `Legacy: ${connection.providerSpecificData?.connectionProxyUrl}`
        : "";
  const autoPingTooltip =
    autoPing?.provider === "codex"
      ? "Auto-starts the next 5h Codex window after reset by sending a tiny gpt-5.5 request. Consumes a small amount of quota."
      : "When your 5h quota runs out, auto-sends a request the moment it resets so a new window starts right away.";

  let maskedProxyUrl = "";
  const rawProxyUrl =
    boundProxyPool?.proxyUrl || connection.providerSpecificData?.connectionProxyUrl;
  if (rawProxyUrl) {
    try {
      const parsed = new URL(rawProxyUrl);
      maskedProxyUrl = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
    } catch {
      maskedProxyUrl = rawProxyUrl;
    }
  }
  const noProxyText =
    boundProxyPool?.noProxy || connection.providerSpecificData?.connectionNoProxy || "";
  const proxyVariant = boundProxyPool?.isActive === true ? "ok" : hasAnyProxy ? "err" : "neutral";

  const rowAuthType = connection.authType || (isOAuth ? "oauth" : "apikey");
  const authLabel =
    rowAuthType === "oauth" ? "OAuth" : rowAuthType === "cookie" ? "Cookie" : "API key";
  const displayName =
    connection.name?.trim() ||
    connection.email?.trim() ||
    connection.displayName?.trim() ||
    (rowAuthType === "oauth"
      ? "OAuth Account"
      : rowAuthType === "cookie"
        ? "Cookie Account"
        : "API key");
  const secondaryDisplayName =
    connection.name?.trim() &&
    connection.email?.trim() &&
    connection.name.trim() !== connection.email.trim()
      ? connection.email.trim()
      : connection.name?.trim() &&
          connection.displayName?.trim() &&
          connection.name.trim() !== connection.displayName.trim()
        ? connection.displayName.trim()
        : null;

  const health = connectionHealth(connection);
  const modelLockUntil = cooldownUntil(connection);
  const isCooldown = !!modelLockUntil;
  const statusPillVariant = { off: "neutral", ok: "ok", warn: "warn", err: "err" }[health.status];
  const statusLabel = health.status === "ok" ? "active" : health.reason;
  const disabled = health.status === "off";
  const weightInfo =
    showWeighted && !disabled
      ? {
          weight: Math.max(0, connection.effectiveWeight?.weight || 0),
          sharePct: weightSharePct(connection.effectiveWeight, totalWeight, activeCount),
          base: connection.effectiveWeight?.base,
          baseSource: connection.effectiveWeight?.baseSource || "default",
          headroom: connection.effectiveWeight?.headroom,
          headroomSource: connection.effectiveWeight?.headroomSource || "static",
          belowFloor: connection.effectiveWeight?.belowFloor === true,
          allExhausted: !(totalWeight > 0),
        }
      : null;

  const oneByOneVariant = !oneByOneStatus
    ? null
    : oneByOneStatus.state === "success"
      ? "ok"
      : oneByOneStatus.state === "failed"
        ? "err"
        : oneByOneStatus.state === "testing"
          ? "info"
          : "neutral";
  const oneByOneLabel = !oneByOneStatus
    ? null
    : oneByOneStatus.state === "queued"
      ? "queued"
      : oneByOneStatus.state === "testing"
        ? "testing"
        : oneByOneStatus.state === "success"
          ? "success"
          : oneByOneStatus.state === "failed"
            ? oneByOneStatus.error
              ? `failed: ${oneByOneStatus.error}`
              : "failed"
            : null;

  const handleSelectProxy = async (poolId) => {
    setProxyUpdating(true);
    try {
      await onUpdateProxy(poolId === "__none__" ? null : poolId);
    } finally {
      setProxyUpdating(false);
    }
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      aria-label={`${displayName}, priority ${index + 1} of ${total}`}
      className={`flex min-w-0 flex-col gap-3 rounded-xl border border-transparent p-2 transition-colors sm:flex-row sm:items-center sm:justify-between ${
        isDragging ? "border-coral shadow-card" : selected ? "bg-coral-bg" : ""
      } ${disabled ? "opacity-60" : ""}`}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2 sm:items-center sm:gap-3">
        {showHandle ? (
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={`Reorder ${displayName}, position ${index + 1}`}
            title="Drag to reorder"
            className="inline-flex size-10 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-muted transition-colors hover:text-text focus-visible:shadow-focus focus-visible:outline-none active:cursor-grabbing"
          >
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
              drag_indicator
            </span>
          </button>
        ) : null}
        <fieldset className="m-0 flex shrink-0 flex-col border-0 p-0">
          <legend className="sr-only">{`Priority for ${displayName}`}</legend>
          <button
            type="button"
            onClick={() => onMove(index, index - 1)}
            disabled={index === 0}
            aria-label={`Move ${displayName} up`}
            className={`rounded p-0.5 ${index === 0 ? "cursor-not-allowed text-muted/30" : "text-muted hover:text-text"}`}
          >
            <span className="material-symbols-outlined text-sm" aria-hidden="true">
              keyboard_arrow_up
            </span>
          </button>
          <button
            type="button"
            onClick={() => onMove(index, index + 1)}
            disabled={index === total - 1}
            aria-label={`Move ${displayName} down`}
            className={`rounded p-0.5 ${index === total - 1 ? "cursor-not-allowed text-muted/30" : "text-muted hover:text-text"}`}
          >
            <span className="material-symbols-outlined text-sm" aria-hidden="true">
              keyboard_arrow_down
            </span>
          </button>
        </fieldset>
        <span
          aria-hidden="true"
          className={`flex size-7 shrink-0 items-center justify-center rounded-full font-mono text-xs font-semibold ${
            disabled ? "bg-line text-muted" : "bg-text text-bg"
          }`}
        >
          {index + 1}
        </span>
        <input
          type="checkbox"
          checked={!!selected}
          onChange={() => onSelect(connection.id)}
          aria-label={`Select ${displayName}`}
          className="size-4 shrink-0 accent-[var(--signal-coral)]"
        />
        <AuthIcon authType={rowAuthType} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{displayName}</p>
          {secondaryDisplayName ? (
            <p className="truncate text-xs text-muted">{secondaryDisplayName}</p>
          ) : null}
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 sm:gap-2">
            <StatusPill variant={statusPillVariant} dot>
              {disabled ? "disabled" : statusLabel}
            </StatusPill>
            <StatusPill variant="neutral">{authLabel}</StatusPill>
            {hasAnyProxy ? <StatusPill variant={proxyVariant}>Proxy</StatusPill> : null}
            {isCooldown && !disabled ? <CooldownTimer until={modelLockUntil} /> : null}
            {connection.lastError && !disabled ? (
              <span
                className="max-w-full truncate text-xs text-err sm:max-w-[300px]"
                title={connection.lastError}
              >
                {connection.lastError}
              </span>
            ) : null}
            <span className="font-mono text-xs text-muted">#{connection.priority}</span>
            {connection.globalPriority ? (
              <span className="text-xs text-muted">Auto: {connection.globalPriority}</span>
            ) : null}
            {weightInfo ? (
              <span
                className="max-w-full"
                title={`Base ${formatWeight(weightInfo.base)} (${weightInfo.baseSource}) × headroom ${formatWeight(weightInfo.headroom)} (${weightInfo.headroomSource}). Share is an estimate across active accounts; model-specific quotas may differ.`}
              >
                <StatusPill variant="neutral">
                  {`Weight ${formatWeight(weightInfo.weight)} · ~${weightInfo.sharePct.toFixed(1)}% share`}
                </StatusPill>
              </span>
            ) : null}
            {oneByOneLabel ? (
              <StatusPill variant={oneByOneVariant}>{oneByOneLabel}</StatusPill>
            ) : null}
          </div>
          {hasAnyProxy ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span
                className="max-w-full truncate text-[11px] text-muted sm:max-w-[420px]"
                title={proxyDisplayText}
              >
                {proxyDisplayText}
              </span>
              {maskedProxyUrl ? (
                <code className="max-w-full truncate rounded bg-raised px-1 py-0.5 font-mono text-[10px] text-muted sm:max-w-[260px]">
                  {maskedProxyUrl}
                </code>
              ) : null}
              {noProxyText ? (
                <span
                  className="max-w-full truncate text-[11px] text-muted sm:max-w-[320px]"
                  title={noProxyText}
                >
                  no_proxy: {noProxyText}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-end">
        <div className="grid flex-1 grid-cols-3 gap-1 sm:flex sm:flex-none">
          {(proxyPools || []).length > 0 ? (
            <Menu
              trigger={
                <button
                  type="button"
                  disabled={proxyUpdating}
                  aria-label={`Proxy for ${displayName}${boundProxyPool ? `: ${boundProxyPool.name}` : ""}`}
                  className={`flex w-full flex-col items-center rounded px-2 py-1 transition-colors ${
                    hasAnyProxy ? "text-coral-ink" : "text-muted hover:text-text"
                  }`}
                >
                  {proxyUpdating ? (
                    <Spinner size="sm" className="text-[18px]" />
                  ) : (
                    <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                      lan
                    </span>
                  )}
                  <span className="text-[10px] leading-tight">Proxy</span>
                </button>
              }
            >
              <MenuItem
                label="None"
                selected={!boundProxyPoolId}
                onSelect={() => handleSelectProxy("__none__")}
              >
                None
              </MenuItem>
              {(proxyPools || []).map((pool) => (
                <MenuItem
                  key={pool.id}
                  label={pool.name}
                  selected={boundProxyPoolId === pool.id}
                  onSelect={() => handleSelectProxy(pool.id)}
                >
                  {pool.name}
                </MenuItem>
              ))}
            </Menu>
          ) : null}
          {autoPing ? (
            <Tooltip text={autoPingTooltip}>
              <button
                type="button"
                onClick={() => autoPing.onToggle(!autoPing.on)}
                aria-pressed={autoPing.on}
                aria-label={`Auto-ping for ${displayName}`}
                className={`flex w-full flex-col items-center rounded px-2 py-1 transition-colors ${
                  autoPing.on ? "text-coral-ink" : "text-muted hover:text-text"
                }`}
              >
                <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                  bolt
                </span>
                <span className="text-[10px] leading-tight">Auto-ping</span>
              </button>
            </Tooltip>
          ) : null}
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit ${displayName}`}
            className="flex flex-col items-center rounded px-2 py-1 text-muted hover:text-text"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
              edit
            </span>
            <span className="text-[10px] leading-tight">Edit</span>
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete ${displayName}`}
            className="flex flex-col items-center rounded px-2 py-1 text-err hover:bg-err-bg"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
              delete
            </span>
            <span className="text-[10px] leading-tight">Delete</span>
          </button>
        </div>
        <Toggle
          checked={connection.isActive ?? true}
          onChange={onToggleActive}
          aria-label={`${displayName} enabled`}
        />
      </div>
      <span aria-live="off" className="sr-only">
        {isCooldown && !disabled ? `Cooldown ${formatCooldownRemaining(modelLockUntil)} left` : ""}
      </span>
    </li>
  );
}

SortableConnectionRow.propTypes = {
  connection: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    email: PropTypes.string,
    displayName: PropTypes.string,
    testStatus: PropTypes.string,
    authType: PropTypes.string,
    isActive: PropTypes.bool,
    lastError: PropTypes.string,
    priority: PropTypes.number,
    globalPriority: PropTypes.number,
    effectiveWeight: PropTypes.object,
    providerSpecificData: PropTypes.object,
  }).isRequired,
  index: PropTypes.number.isRequired,
  total: PropTypes.number.isRequired,
  showHandle: PropTypes.bool,
  proxyPools: PropTypes.array,
  isOAuth: PropTypes.bool.isRequired,
  showWeighted: PropTypes.bool,
  totalWeight: PropTypes.number,
  activeCount: PropTypes.number,
  oneByOneStatus: PropTypes.shape({
    state: PropTypes.string,
    error: PropTypes.string,
  }),
  autoPing: PropTypes.shape({
    on: PropTypes.bool,
    onToggle: PropTypes.func,
    provider: PropTypes.string,
  }),
  selected: PropTypes.bool,
  onSelect: PropTypes.func.isRequired,
  onToggleActive: PropTypes.func.isRequired,
  onUpdateProxy: PropTypes.func.isRequired,
  onEdit: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
  onMove: PropTypes.func.isRequired,
};
