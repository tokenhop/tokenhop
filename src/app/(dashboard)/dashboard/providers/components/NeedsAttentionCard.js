"use client";

import { memo } from "react";
import PropTypes from "prop-types";
import { Button, ProviderTile } from "@/shared/components";
import CooldownTimer from "@/shared/components/CooldownTimer";
import { getRelativeTime } from "@/shared/utils";
import { connectionHealth, cooldownUntil, providerHealth } from "@/shared/utils/providerHealth";

/**
 * Attention card explains why a provider is flagged and links to its fix.
 * Memoized: the shell passes stable entry-scoped callbacks so list
 * re-renders skip cards whose props did not change.
 *
 * @param {object} props
 * @param {object} props.entry
 * @param {object[]} props.connections
 * @param {boolean} props.testing
 * @param {(entry: object) => void} props.onRetry
 * @param {(entry: object, connection: object) => void} props.onRepair
 * @param {(entry: object) => void} props.onOpen
 * @param {() => void} [props.onCooldownExpired]
 */
function NeedsAttentionCard({
  entry,
  connections,
  testing,
  onRetry,
  onRepair,
  onOpen,
  onCooldownExpired,
}) {
  const enabled = connections.filter((connection) => connection.isActive !== false);
  const health = providerHealth(enabled);
  const until = health.until || cooldownUntil(enabled.find((c) => cooldownUntil(c)));
  const errorConn = [...enabled].sort(
    (a, b) => new Date(b.lastErrorAt || 0) - new Date(a.lastErrorAt || 0),
  )[0];
  // Open imported credentials in the provider detail; only replaceable
  // credentials get a Reconnect action.
  const repairConn = enabled.find((c) => connectionHealth(c).action === "reconnect");
  const showRepair = Boolean(repairConn);
  const showOpen = health.action === "open";

  return (
    <div
      className={`flex items-center gap-3.5 rounded-2xl border p-4 ${
        health.status === "warn" ? "border-warn bg-warn-bg" : "border-err bg-err-bg"
      }`}
    >
      <ProviderTile providerId={entry.id} size="md" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <button
          type="button"
          onClick={() => onOpen(entry)}
          className="truncate text-start text-[15px] font-semibold focus-visible:outline-none focus-visible:shadow-focus"
        >
          {entry.info.name} {health.status === "warn" ? "is cooling down" : "needs attention"}
        </button>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-muted">
          <span>{health.reason || "Requests are skipping this provider"}</span>
          {until && <CooldownTimer until={until} onExpire={onCooldownExpired} />}
          {errorConn?.lastErrorAt && <span>{getRelativeTime(errorConn.lastErrorAt)}</span>}
        </span>
      </div>
      <Button
        size="sm"
        variant={showRepair ? "primary" : "secondary"}
        loading={testing}
        disabled={testing}
        onClick={
          showRepair
            ? () => onRepair(entry, repairConn)
            : showOpen
              ? () => onOpen(entry)
              : () => onRetry(entry)
        }
        aria-label={
          showRepair
            ? `Reconnect ${repairConn.name || repairConn.email || entry.info.name}`
            : undefined
        }
      >
        {testing
          ? "Retrying…"
          : showRepair
            ? "Reconnect"
            : showOpen
              ? "Open provider"
              : "Retry now"}
      </Button>
    </div>
  );
}

NeedsAttentionCard.propTypes = {
  entry: PropTypes.object.isRequired,
  connections: PropTypes.array.isRequired,
  testing: PropTypes.bool,
  onRetry: PropTypes.func.isRequired,
  onRepair: PropTypes.func.isRequired,
  onOpen: PropTypes.func.isRequired,
  onCooldownExpired: PropTypes.func,
};

export default memo(NeedsAttentionCard);
