"use client";

import PropTypes from "prop-types";
import Button from "@/shared/components/Button";

/**
 * Bulk-action bar shown when pools are selected (or a health check runs).
 * Lime-tinted per the board; health check shows `Checking x/y` progress.
 */
export default function SelectionBar({
  selectedCount = 0,
  checking = false,
  progress = null,
  busy = false,
  hasPools = false,
  onHealthCheck,
  onActivate,
  onDeactivate,
  onDelete,
  onClear,
}) {
  const showActions = selectedCount > 0;
  const show = showActions || checking;
  if (!show) return null;

  const label = checking
    ? `Checking ${progress?.current ?? 0}/${progress?.total ?? 0}`
    : `${selectedCount} selected`;

  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-lime-bg p-2 ps-3.5"
      aria-live="polite"
    >
      <span className="me-auto text-[13px] font-semibold text-lime-ink">{label}</span>
      <Button
        size="sm"
        variant="ghost"
        icon="monitor_heart"
        loading={checking}
        disabled={checking || busy || !hasPools}
        onClick={onHealthCheck}
      >
        {checking ? "Checking…" : "Health check"}
      </Button>
      {showActions && (
        <>
          <Button
            size="sm"
            variant="ghost"
            icon="toggle_on"
            disabled={busy || checking}
            onClick={onActivate}
          >
            Activate
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="toggle_off"
            disabled={busy || checking}
            onClick={onDeactivate}
          >
            Deactivate
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon="delete"
            disabled={busy || checking}
            onClick={onDelete}
          >
            Delete
          </Button>
          <Button size="sm" variant="ghost" disabled={busy || checking} onClick={onClear}>
            Clear
          </Button>
        </>
      )}
    </div>
  );
}

SelectionBar.propTypes = {
  selectedCount: PropTypes.number,
  checking: PropTypes.bool,
  progress: PropTypes.shape({ current: PropTypes.number, total: PropTypes.number }),
  busy: PropTypes.bool,
  hasPools: PropTypes.bool,
  onHealthCheck: PropTypes.func.isRequired,
  onActivate: PropTypes.func.isRequired,
  onDeactivate: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
  onClear: PropTypes.func.isRequired,
};
