"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import ModelChip from "@/shared/components/ModelChip";
import StatusPill from "@/shared/components/StatusPill";
import { pickTopCombos } from "@/shared/utils/commandCenter";
import { formatCompact } from "./format";
import { WidgetEmpty, WidgetError, WidgetSkeleton } from "./WidgetStates";

/** Fallback strategies the routing layer understands: anything else falls back to Fallback. */
export const KNOWN_FALLBACK_STRATEGIES = new Set(["fallback", "round-robin", "weighted", "fusion"]);

/**
 * Strategy pill variant: fallback brand, round-robin info, weighted/others neutral.
 * @param {string} strategy
 * @returns {string}
 */
export function strategyVariant(strategy) {
  if (!KNOWN_FALLBACK_STRATEGIES.has(strategy))
    throw new Error(`strategyVariant: unknown strategy "${strategy}"`);
  if (strategy === "round-robin") return "info";
  return strategy === "fallback" ? "brand" : "neutral";
}

/**
 * Strategy label in words, not slugs.
 * @param {string} strategy
 * @returns {string}
 */
export function strategyLabel(strategy) {
  if (!KNOWN_FALLBACK_STRATEGIES.has(strategy))
    throw new Error(`strategyVariant: unknown strategy "${strategy}"`);
  return strategy === "round-robin"
    ? "Round robin"
    : `${strategy.charAt(0).toUpperCase()}${strategy.slice(1)}`;
}

/**
 * Count combo usage from usage-stats `byEndpoint` keys shaped like
 * "endpoint|model|provider", where endpoint may be the plain combo name.
 * @param {object} byEndpoint
 * @returns {Map<string, number>} combo name -> requests
 */
export function comboUsageFromByEndpoint(byEndpoint) {
  const counts = new Map();
  if (!byEndpoint || typeof byEndpoint !== "object") return counts;
  for (const [key, entry] of Object.entries(byEndpoint)) {
    const endpoint = entry?.endpoint ?? String(key).split("|")[0];
    if (!endpoint || endpoint === "Unknown") continue;
    counts.set(endpoint, (counts.get(endpoint) || 0) + (Number(entry?.requests) || 0));
  }
  return counts;
}

/**
 * Top 2 combos with strategy pill and model chain.
 *
 * @param {object} props
 * @param {Array<object>} props.combos combo records (each `{ name, models }`)
 * @param {object} props.strategies settings.comboStrategies map
 * @param {Map<string, number>|null} props.usageByCombo combo name -> requests
 * @param {boolean} props.loading
 * @param {string|null} props.error
 * @param {() => void} props.onRetry
 */
export default function CombosTop({ combos, strategies, usageByCombo, loading, error, onRetry }) {
  if (loading) return <WidgetSkeleton lines={3} label="Loading combos" />;
  if (error) return <WidgetError message={error} onRetry={onRetry} />;
  if (combos.length === 0) {
    return (
      <WidgetEmpty
        icon="layers"
        title="No combos yet"
        body="Chain models into a route so one name survives outages."
        actionLabel="Create your first combo"
        actionHref="/dashboard/combos"
      />
    );
  }

  const lookupCount = (name) => {
    if (usageByCombo instanceof Map) return usageByCombo.get(name) ?? 0;
    if (usageByCombo && typeof usageByCombo === "object") return usageByCombo[name] ?? 0;
    return 0;
  };

  const withUsage = combos.map((combo) => ({
    ...combo,
    requests: lookupCount(combo.name),
  }));
  const top = pickTopCombos(withUsage);

  return (
    <ul className="flex min-w-0 flex-col gap-3" aria-label="Most used combos">
      {top.map((combo) => {
        const rawStrategy = strategies?.[combo.name]?.fallbackStrategy || "fallback";
        const strategy = KNOWN_FALLBACK_STRATEGIES.has(rawStrategy) ? rawStrategy : "fallback";
        const models = Array.isArray(combo.models) ? combo.models : [];
        return (
          <li key={`combo-${combo.name}`} className="min-w-0 rounded-xl bg-raised p-3.5">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate font-mono text-[15px] font-semibold text-text">
                {combo.name}
              </span>
              <StatusPill variant={strategyVariant(strategy)}>{strategyLabel(strategy)}</StatusPill>
              <span className="ms-auto shrink-0 text-xs text-muted">
                {combo.requests > 0
                  ? `${formatCompact(combo.requests)} in period`
                  : "unused in period"}
              </span>
            </div>
            {models.length > 0 ? (
              <p className="mt-2.5 flex flex-wrap items-center gap-1.5">
                {models.map((model, position) => (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: duplicate model ids repeat across combos; position disambiguates.
                    key={`${combo.name}-${position}-${model}`}
                    className="flex items-center gap-1.5"
                  >
                    {position > 0 ? (
                      <span aria-hidden="true" className="text-muted">
                        {strategy === "round-robin" ? "⇄" : "→"}
                      </span>
                    ) : null}
                    <ModelChip model={model} />
                  </span>
                ))}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

CombosTop.propTypes = {
  combos: PropTypes.arrayOf(PropTypes.object),
  strategies: PropTypes.object,
  usageByCombo: PropTypes.oneOfType([PropTypes.instanceOf(Map), PropTypes.object]),
  loading: PropTypes.bool,
  error: PropTypes.string,
  onRetry: PropTypes.func.isRequired,
};

/** Card wrapper so the page grid stays dumb. */
export function CombosTopCard(props) {
  return (
    <Card
      className="min-w-0"
      title="Combos"
      action={
        <a
          href="/dashboard/combos"
          className="text-[13px] font-semibold text-coral-ink hover:text-coral"
        >
          All combos →
        </a>
      }
    >
      <CombosTop {...props} />
    </Card>
  );
}
