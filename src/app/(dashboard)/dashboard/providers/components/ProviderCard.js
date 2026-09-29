"use client";

import PropTypes from "prop-types";
import { memo } from "react";
import { ProviderTile, StatusPill, Toggle } from "@/shared/components";
import { providerHealth } from "@/shared/utils/providerHealth";
import { getAccountSegments } from "../utils";

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

function tileStatus(entry, connections) {
  if (entry.stats.allDisabled) return "neutral";
  const health = providerHealth(entry.isNoAuth ? [] : connections);
  if (health.status === "err") return "err";
  if (health.status === "warn") return "warn";
  if (health.connected) return "ok";
  return "neutral";
}

function statusForEntry(entry, connections) {
  if (entry.isNoAuth) return { variant: "ok", label: "Ready", dot: true };
  if (entry.stats.allDisabled) return { variant: "neutral", label: "Disabled", dot: false };
  const health = providerHealth(connections);
  if (health.status === "warn" && health.until) {
    return { variant: "warn", label: "Cooldown", dot: true };
  }
  if (health.status === "err") {
    const errCount = health.counts.err;
    const errText = entry.stats.errorCode
      ? `${errCount} Error (${entry.stats.errorCode})`
      : `${errCount} Error`;
    return { variant: "err", label: errText, dot: true };
  }
  if (health.status === "warn" && health.reason) {
    return { variant: "warn", label: health.reason, dot: true };
  }
  if (entry.stats.connected > 0) return { variant: "ok", label: "Connected", dot: true };
  const isKey = entry.authGroup === "apikey" || entry.authGroup === "compatible";
  return { variant: "neutral", label: isKey ? "Add key" : "Connect", dot: false };
}

const SEGMENT_FILL = {
  ok: "bg-ok",
  warn: "bg-warn",
  err: "bg-err",
  none: "bg-line",
};

function SegmentedHealthBarDisplay({ segments }) {
  return (
    <div
      role="img"
      aria-label={`Account health: ${segments.map((s) => s.label).join(", ")}`}
      className="grid min-w-0 flex-1 auto-cols-fr grid-flow-col gap-1"
    >
      {segments.map((segment, index) => (
        <span
          key={`${segment.label}-${index}`}
          title={segment.label}
          className="h-1.5 overflow-hidden rounded-sm bg-raised shadow-[inset_0_0_0_1px_var(--signal-line)]"
        >
          <span
            className={`block h-full rounded-sm ${SEGMENT_FILL[segment.kind] || "bg-line"}`}
            style={{ width: `${Math.min(100, Math.max(0, segment.value))}%` }}
          />
        </span>
      ))}
    </div>
  );
}

SegmentedHealthBarDisplay.propTypes = {
  segments: PropTypes.arrayOf(
    PropTypes.shape({
      value: PropTypes.number.isRequired,
      kind: PropTypes.oneOf(["ok", "warn", "err", "none"]).isRequired,
      label: PropTypes.string.isRequired,
    }),
  ).isRequired,
};

/** Compact catalog card for one provider entry. Memoised: props stay stable across list re-renders. */
const ProviderCard = memo(function ProviderCard({
  entry,
  connections,
  selected = false,
  modelCount = null,
  onSelect,
  onToggle,
}) {
  const { info, stats } = entry;
  const segments = getAccountSegments(connections);
  const status = statusForEntry(entry, connections);

  const authPill = entry.compatibleType
    ? {
        variant: "neutral",
        label:
          entry.compatibleType === "anthropic"
            ? "Messages"
            : info.apiType === "responses"
              ? "Responses"
              : "Chat",
      }
    : {
        variant: AUTH_PILL_VARIANT[entry.authGroup] || "neutral",
        label: AUTH_PILL_LABEL[entry.authGroup] || entry.authGroup,
      };

  return (
    <div
      className={`group relative flex min-w-0 flex-col gap-3.5 rounded-2xl border bg-panel p-4 shadow-card transition-colors hover:border-subtle focus-within:border-subtle ${
        selected ? "border-coral shadow-[0_0_0_3px_var(--signal-coral-bg)]" : "border-line"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-expanded={selected}
        aria-label={selected ? `Close ${info.name} details` : `Open ${info.name} details`}
        className="absolute inset-0 z-0 rounded-2xl focus-visible:outline-none focus-visible:shadow-focus"
      />

      {/* Top row: Tile + Name/Pill + Hover/focus toggle */}
      <div className="pointer-events-none flex min-w-0 items-center gap-3">
        <ProviderTile providerId={entry.id} size="md" status={tileStatus(entry, connections)} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-[15px] font-semibold">{info.name}</span>
          <span className="flex items-center gap-1.5">
            <StatusPill variant={authPill.variant} size="sm">
              {authPill.label}
            </StatusPill>
            {entry.compatibleLabel && (
              <StatusPill variant="neutral" size="sm">
                {entry.compatibleLabel}
              </StatusPill>
            )}
          </span>
        </div>
        {stats.total > 0 && (
          <span className="pointer-events-auto relative z-10 shrink-0 opacity-100 transition-opacity lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100">
            <Toggle
              size="sm"
              checked={!stats.allDisabled}
              onChange={(next) => onToggle(next)}
              title={stats.allDisabled ? "Enable provider" : "Disable provider"}
              aria-label={stats.allDisabled ? `Enable ${info.name}` : `Disable ${info.name}`}
            />
          </span>
        )}
      </div>

      {/* Health bar: per-account segments */}
      {connections.length > 0 && (
        <div className="pointer-events-none flex gap-1">
          <SegmentedHealthBarDisplay segments={segments} />
        </div>
      )}

      {/* Bottom counts and status */}
      <div className="pointer-events-none flex min-w-0 items-center gap-1.5 text-xs text-muted">
        <span>
          {connections.length === 0
            ? "Not connected"
            : `${connections.length} ${connections.length === 1 ? "account" : "accounts"}`}
        </span>
        {modelCount > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span>
              {modelCount} {modelCount === 1 ? "model" : "models"}
            </span>
          </>
        )}
        <span className="ms-auto">
          <StatusPill variant={status.variant} size="sm" dot={status.dot}>
            {status.label}
          </StatusPill>
        </span>
      </div>

      {stats.errorTime && stats.error > 0 && (
        <span className="pointer-events-none text-xs text-muted">{stats.errorTime}</span>
      )}
    </div>
  );
});

ProviderCard.propTypes = {
  entry: PropTypes.shape({
    id: PropTypes.string.isRequired,
    info: PropTypes.object.isRequired,
    stats: PropTypes.object.isRequired,
    authGroup: PropTypes.string.isRequired,
    authTypes: PropTypes.arrayOf(PropTypes.string).isRequired,
    compatibleType: PropTypes.string,
    compatibleLabel: PropTypes.string,
    isNoAuth: PropTypes.bool,
  }).isRequired,
  connections: PropTypes.array.isRequired,
  selected: PropTypes.bool,
  modelCount: PropTypes.number,
  onSelect: PropTypes.func.isRequired,
  onToggle: PropTypes.func.isRequired,
};

export default ProviderCard;
