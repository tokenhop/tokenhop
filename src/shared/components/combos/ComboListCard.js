"use client";

import PropTypes from "prop-types";
import ProviderTile from "@/shared/components/ProviderTile";
import StatusPill from "@/shared/components/StatusPill";

/**
 * One combo in the route-builder list: mono name, strategy pill, overlapping
 * provider tile stack, "N models · X today". A button (not a link) so the
 * selected state stays keyboard-operable without navigation.
 *
 * @param {object} props
 * @param {{ id: string, name: string, models?: string[] }} props.combo
 * @param {string} [props.strategy] Effective strategy id.
 * @param {string} props.strategyLabel Human label for the strategy pill.
 * @param {"brand"|"info"|"live"|"warn"} [props.strategyVariant] Pill color.
 * @param {number} [props.usageToday] Requests served today.
 * @param {boolean} [props.selected]
 * @param {(id: string) => void} props.onSelect
 */
export default function ComboListCard({
  combo,
  strategy = "fallback",
  strategyLabel,
  strategyVariant = "brand",
  usageToday = 0,
  selected = false,
  onSelect,
}) {
  const models = combo?.models || [];
  const tiles = models.slice(0, 3).map((m, i) => ({ key: `${m}-${i}`, short: m }));
  return (
    <button
      type="button"
      onClick={() => onSelect?.(combo.id)}
      aria-pressed={selected}
      aria-label={`${combo.name} combo, ${strategyLabel || strategy}, ${models.length} models`}
      className={`flex w-full flex-col gap-2 rounded-2xl border bg-panel p-4 text-start transition-colors focus-visible:shadow-focus focus-visible:outline-none ${
        selected
          ? "border-coral shadow-[0_0_0_3px_var(--signal-coral-bg)]"
          : "border-line hover:border-subtle"
      }`}
    >
      <span className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate font-mono text-base font-semibold text-text">
          {combo.name}
        </code>
        <StatusPill variant={strategyVariant} size="sm">
          {strategyLabel || strategy}
        </StatusPill>
      </span>
      <span className="flex items-center">
        {tiles.map((t, i) => (
          <span
            key={t.key}
            title={t.short}
            style={{ zIndex: 3 - i, marginInlineStart: i === 0 ? 0 : -6 }}
            className="relative inline-flex rounded-md shadow-[0_0_0_2px_var(--signal-panel)]"
          >
            <ProviderTile providerId={t.short} size="sm" />
          </span>
        ))}
        <span className="ms-3 text-xs text-muted">
          {models.length} models · {formatToday(usageToday)}
        </span>
      </span>
    </button>
  );
}

/** "812 today" / "1.1k today" compact count. */
export function formatToday(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 today";
  if (n >= 1000) {
    const v = n / 1000;
    return `${v >= 10 || Number.isInteger(v * 10) ? v.toFixed(v >= 10 ? 0 : 1).replace(/\.0$/, "") : v.toFixed(1)}k today`;
  }
  return `${n} today`;
}

ComboListCard.propTypes = {
  combo: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    models: PropTypes.arrayOf(PropTypes.string),
  }).isRequired,
  strategy: PropTypes.string,
  strategyLabel: PropTypes.string,
  strategyVariant: PropTypes.oneOf(["brand", "info", "live", "warn"]),
  usageToday: PropTypes.number,
  selected: PropTypes.bool,
  onSelect: PropTypes.func,
};
