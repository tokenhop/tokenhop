"use client";

import PropTypes from "prop-types";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getAccountStatus } from "../quotaSummary";
import { getConnectionLabel, getConnectionSecondaryLabel } from "../quotaLabels";
import { getQuotaVisibilityKey } from "@/app/(dashboard)/dashboard/quota/lib/quotaUtils.js";
import Card from "@/shared/components/Card";
import IconButton from "@/shared/components/IconButton";
import ProviderTile from "@/shared/components/ProviderTile";
import StatusPill from "@/shared/components/StatusPill";
import Toggle from "@/shared/components/Toggle";
import { Skeleton } from "@/shared/components/Loading";
import { memo } from "react";
import Menu, { MenuItem } from "@/shared/components/Menu";
import QuotaRow from "./QuotaRow";

/**
 * Signal account card: tile + provider + account label, a status pill,
 * enable toggle, refresh / edit / delete actions, quota rows with the
 * shared `Meter`, and the hidden-row restore strip.
 *
 * @param {object} props
 */
function QuotaAccountCard({
  connection,
  quotas,
  hiddenQuotaRows,
  loading,
  error,
  message,
  rowBusy,
  autoPing,
  canAutoPing,
  codexResetCredits,
  canResetCodex,
  quotaSortLabel,
  onRefresh,
  onEdit,
  onDelete,
  onToggle,
  onToggleAutoPing,
  onResetCodex,
  onViewCodexCredits,
  onHideQuota,
  onShowQuota,
}) {
  const providerName = AI_PROVIDERS[connection.provider]?.name || connection.provider;
  const label = getConnectionLabel(connection);
  const secondaryLabel = getConnectionSecondaryLabel(connection);
  const status = getAccountStatus({ isActive: connection.isActive, quotas, error, loading });

  return (
    <Card padding="none" className="flex min-w-0 flex-col p-5" data-testid="quota-account-card">
      {/* Header: tile + labels + enable toggle */}
      <div className="flex items-center gap-3">
        <ProviderTile
          providerId={connection.provider}
          status={
            status.variant === "ok"
              ? "ok"
              : status.variant === "warn"
                ? "warn"
                : status.variant === "err"
                  ? "err"
                  : "neutral"
          }
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[15px] font-semibold text-text">{providerName}</span>
          {label && <span className="truncate text-xs text-muted">{label}</span>}
          {secondaryLabel && (
            <span className="truncate text-[11px] text-subtle">{secondaryLabel}</span>
          )}
        </div>
        <Toggle
          checked={connection.isActive ?? true}
          disabled={rowBusy}
          onChange={(next) => onToggle(connection.id, next)}
          aria-label={`${connection.isActive === false ? "Enable" : "Disable"} ${label || providerName} account`}
          title={(connection.isActive ?? true) ? "Disable connection" : "Enable connection"}
        />
      </div>

      {/* Status + actions */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <StatusPill variant={status.variant}>{status.label}</StatusPill>
        <div className="flex-1" />
        <IconButton
          icon="refresh"
          label="Refresh quota"
          loading={loading}
          disabled={rowBusy}
          onClick={() => onRefresh(connection.id, connection.provider)}
        />
        <Menu
          trigger={
            <IconButton
              icon="more_vert"
              label={`More actions for ${label || providerName}`}
              disabled={rowBusy}
            />
          }
        >
          <MenuItem icon="edit" onSelect={() => onEdit(connection)} disabled={rowBusy}>
            Edit connection
          </MenuItem>
          {connection.provider === "codex" && (
            <MenuItem
              icon="restart_alt"
              onSelect={() => onResetCodex(connection)}
              disabled={!canResetCodex || loading || rowBusy}
            >
              Use reset credit ({codexResetCredits} available)
            </MenuItem>
          )}
          {connection.provider === "codex" && (
            <MenuItem
              icon="schedule"
              onSelect={() => onViewCodexCredits(connection)}
              disabled={loading || rowBusy}
            >
              View reset credit expiry
            </MenuItem>
          )}
          {canAutoPing && (
            <MenuItem
              icon="bolt"
              onSelect={() => onToggleAutoPing(connection.id, connection.provider, !autoPing)}
              disabled={rowBusy}
              title="Auto-ping keeps OAuth sessions active. Quota refresh runs separately."
            >
              {autoPing ? "Disable auto-ping" : "Enable auto-ping"}
            </MenuItem>
          )}
          <MenuItem
            icon="delete"
            danger
            onSelect={() => onDelete(connection.id)}
            disabled={rowBusy}
          >
            Delete connection
          </MenuItem>
        </Menu>
      </div>

      {/* Quota rows */}
      <div className="mt-4 flex min-w-0 flex-1 flex-col gap-4">
        {loading ? (
          <div className="flex flex-col gap-3" role="status" aria-label="Loading quotas">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-1.5 py-5 text-center" role="alert">
            <span className="material-symbols-outlined text-[28px] text-err" aria-hidden="true">
              error
            </span>
            <p className="text-xs text-muted">{error}</p>
            <button
              type="button"
              onClick={() => onRefresh(connection.id, connection.provider)}
              className="min-h-10 rounded-lg border border-line bg-raised px-3 text-xs font-semibold text-text hover:bg-line/60 focus-visible:shadow-focus"
            >
              Retry refresh
            </button>
          </div>
        ) : message ? (
          <p className="py-5 text-center text-xs text-muted">{message}</p>
        ) : quotas.length === 0 ? (
          <p className="py-5 text-center text-xs text-muted">No quota data available.</p>
        ) : (
          <>
            {quotaSortLabel && (
              <span className="self-start rounded-md border border-line bg-raised px-2 py-1 text-[10px] text-muted">
                Sorted by account remaining
              </span>
            )}
            {quotas.map((quota) => (
              <QuotaRow
                key={`${quota.name}-${quota.modelKey || ""}-${getQuotaVisibilityKey(quota)}`}
                quota={quota}
                compact
                onHide={onHideQuota ? (row) => onHideQuota(connection.provider, row) : undefined}
              />
            ))}
          </>
        )}

        {hiddenQuotaRows?.length > 0 && (
          <div className="mt-auto flex min-w-0 items-center gap-1 border-t border-line pt-2 text-[10px] text-muted">
            <span className="material-symbols-outlined shrink-0 text-[14px]" aria-hidden="true">
              visibility_off
            </span>
            <span className="shrink-0">Hidden:</span>
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap pb-1">
              {hiddenQuotaRows.map((quotaRow) => (
                <button
                  key={getQuotaVisibilityKey(quotaRow)}
                  type="button"
                  onClick={() => onShowQuota(connection.provider, quotaRow)}
                  className="shrink-0 rounded-md border border-line px-1.5 py-0.5 transition-colors hover:bg-raised hover:text-text focus-visible:shadow-focus"
                  title="Show this quota row"
                >
                  {quotaRow.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

QuotaAccountCard.propTypes = {
  connection: PropTypes.shape({
    id: PropTypes.string.isRequired,
    provider: PropTypes.string.isRequired,
    name: PropTypes.string,
    email: PropTypes.string,
    displayName: PropTypes.string,
    isActive: PropTypes.bool,
    authType: PropTypes.string,
  }).isRequired,
  quotas: PropTypes.arrayOf(PropTypes.object).isRequired,
  hiddenQuotaRows: PropTypes.arrayOf(PropTypes.object),
  loading: PropTypes.bool,
  error: PropTypes.string,
  message: PropTypes.string,
  rowBusy: PropTypes.bool,
  autoPing: PropTypes.bool,
  canAutoPing: PropTypes.bool,
  codexResetCredits: PropTypes.number,
  canResetCodex: PropTypes.bool,
  quotaSortLabel: PropTypes.bool,
  onRefresh: PropTypes.func.isRequired,
  onEdit: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
  onToggle: PropTypes.func.isRequired,
  onToggleAutoPing: PropTypes.func.isRequired,
  onResetCodex: PropTypes.func.isRequired,
  onViewCodexCredits: PropTypes.func.isRequired,
  onHideQuota: PropTypes.func,
  onShowQuota: PropTypes.func,
};

export default memo(QuotaAccountCard);
