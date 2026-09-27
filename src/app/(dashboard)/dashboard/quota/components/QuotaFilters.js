"use client";

import PropTypes from "prop-types";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { QUOTA_SORT_OPTIONS } from "@/app/(dashboard)/dashboard/quota/lib/quotaUtils.js";
import Button from "@/shared/components/Button";
import SegmentedControl from "@/shared/components/SegmentedControl";
import ProviderTile from "@/shared/components/ProviderTile";

const STATUS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Off" },
];

/**
 * Signal filters row for the Quota page:
 * - Provider segmented control (All providers + connected providers)
 * - All / Active / Off account status segmented control
 * - Expiring first toggle button
 * - Bulk actions: Turn off empty (destructive -> ConfirmDialog) / Turn on available
 *
 * @param {object} props
 */
export default function QuotaFilters({
  providerFilter,
  onProviderChange,
  providerOptions = [],
  accountFilter,
  onAccountFilterChange,
  quotaSortMode = "default",
  onQuotaSortModeChange,
  expiringFirst,
  onToggleExpiringFirst,
  onTurnOffEmpty,
  onTurnOnAvailable,
  bulkBusy = false,
  emptyCount = 0,
  availableCount = 0,
}) {
  const providerControlOptions = [
    { value: "all", label: "All providers" },
    ...providerOptions.map((provider) => ({
      value: provider,
      label: (
        <span className="inline-flex items-center gap-1.5">
          <ProviderTile providerId={provider} size="sm" />
          {AI_PROVIDERS[provider]?.name || provider}
        </span>
      ),
    })),
  ];

  return (
    <nav className="flex flex-wrap items-center gap-3" aria-label="Quota filters">
      <SegmentedControl
        options={providerControlOptions}
        value={providerFilter}
        onChange={onProviderChange}
        size="sm"
        aria-label="Filter by provider"
      />

      {/* Account status filter */}
      <SegmentedControl
        options={STATUS_OPTIONS}
        value={accountFilter}
        onChange={onAccountFilterChange}
        size="sm"
        aria-label="Filter accounts by status"
      />

      {/* Codex-specific remaining sort select (preserved from legacy) */}
      {providerFilter === "codex" && typeof onQuotaSortModeChange === "function" && (
        <select
          value={quotaSortMode}
          onChange={(e) => onQuotaSortModeChange(e.target.value)}
          aria-label="Sort Codex quotas by remaining"
          className="h-9 rounded-lg border border-line bg-raised px-2.5 text-xs font-semibold text-text outline-none transition-colors hover:bg-line/60 focus-visible:shadow-focus"
        >
          {QUOTA_SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      )}

      {/* Expiring first toggle */}
      <button
        type="button"
        onClick={onToggleExpiringFirst}
        aria-pressed={expiringFirst}
        className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors duration-150 focus-visible:shadow-focus ${
          expiringFirst
            ? "border-warn/40 bg-warn-bg text-warn"
            : "border-line bg-raised text-text hover:bg-line/60"
        }`}
        title="Sort accounts by earliest quota reset time"
      >
        <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
          hourglass_top
        </span>
        <span>Expiring first</span>
      </button>

      <div className="flex-1" />

      {/* Bulk actions */}
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={bulkBusy || emptyCount === 0}
          onClick={onTurnOffEmpty}
          title="Disable connections with depleted quota on the current page"
        >
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
            block
          </span>
          <span>Turn off empty</span>
          {emptyCount > 0 && (
            <span className="font-mono text-[11px] opacity-70">({emptyCount})</span>
          )}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          disabled={bulkBusy || availableCount === 0}
          onClick={onTurnOnAvailable}
          title="Enable connections that still have quota on the current page"
        >
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
            check_circle
          </span>
          <span>Turn on available</span>
          {availableCount > 0 && (
            <span className="font-mono text-[11px] opacity-70">({availableCount})</span>
          )}
        </Button>
      </div>
    </nav>
  );
}

QuotaFilters.propTypes = {
  providerFilter: PropTypes.string.isRequired,
  onProviderChange: PropTypes.func.isRequired,
  providerOptions: PropTypes.arrayOf(PropTypes.string),
  accountFilter: PropTypes.string.isRequired,
  onAccountFilterChange: PropTypes.func.isRequired,
  quotaSortMode: PropTypes.string,
  onQuotaSortModeChange: PropTypes.func,
  expiringFirst: PropTypes.bool.isRequired,
  onToggleExpiringFirst: PropTypes.func.isRequired,
  onTurnOffEmpty: PropTypes.func.isRequired,
  onTurnOnAvailable: PropTypes.func.isRequired,
  bulkBusy: PropTypes.bool,
  emptyCount: PropTypes.number,
  availableCount: PropTypes.number,
};
