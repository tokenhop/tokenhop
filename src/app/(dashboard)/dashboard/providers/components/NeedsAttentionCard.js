"use client";

import PropTypes from "prop-types";
import { Button, ProviderTile } from "@/shared/components";
import CooldownTimer from "@/shared/components/CooldownTimer";
import { getRelativeTime } from "@/shared/utils";
import { cooldownUntil, providerHealth } from "@/shared/utils/providerHealth";

/** Attention card explains why a provider is flagged and links to its fix. */
export default function NeedsAttentionCard({
  entry,
  connections,
  testing,
  onRetry,
  onOpen,
  onReconnect,
}) {
  const enabled = connections.filter((connection) => connection.isActive !== false);
  const health = providerHealth(enabled);
  const until = health.until || cooldownUntil(enabled.find((c) => cooldownUntil(c)));
  const errorConn = [...enabled].sort(
    (a, b) => new Date(b.lastErrorAt || 0) - new Date(a.lastErrorAt || 0),
  )[0];
  const showReconnect = health.action === "reconnect";

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
          onClick={onOpen}
          className="truncate text-start text-[15px] font-semibold focus-visible:outline-none focus-visible:shadow-focus"
        >
          {entry.info.name} {health.status === "warn" ? "is cooling down" : "needs attention"}
        </button>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-muted">
          <span>{health.reason || "Requests are skipping this provider"}</span>
          {until && <CooldownTimer until={until} />}
          {errorConn?.lastErrorAt && <span>{getRelativeTime(errorConn.lastErrorAt)}</span>}
        </span>
      </div>
      <Button
        size="sm"
        variant={showReconnect ? "primary" : "secondary"}
        loading={testing}
        disabled={testing}
        onClick={showReconnect ? onReconnect : onRetry}
      >
        {testing ? "Retrying…" : showReconnect ? "Reconnect" : "Retry now"}
      </Button>
    </div>
  );
}

NeedsAttentionCard.propTypes = {
  entry: PropTypes.object.isRequired,
  connections: PropTypes.array.isRequired,
  testing: PropTypes.bool,
  onRetry: PropTypes.func.isRequired,
  onReconnect: PropTypes.func.isRequired,
  onOpen: PropTypes.func.isRequired,
};
