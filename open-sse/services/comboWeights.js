/**
 * Weighted-share math shared by the router (`services/combo.js`) and the
 * Combos editor (YAN-411). Pure and dependency-free so the dashboard client
 * can import it without pulling engine modules.
 *
 * Rules (exactly what `getWeightedModels` applies):
 * - base weight: `weights[model]` when a finite number >= 0, else 1
 * - headroom: a finite number >= 0, else 1 (fail-open — unknown quota never
 *   reads as exhausted)
 * - effective weight = base × headroom; only weight > 0 candidates get traffic
 * - duplicate models count once (the router dedupes weighted candidates)
 */

/** Configured weight for a combo member, defaulting to 1 like the router. */
export function comboBaseWeight(model, weights) {
  return weights &&
    Object.hasOwn(weights, model) &&
    Number.isFinite(weights[model]) &&
    weights[model] >= 0
    ? weights[model]
    : 1;
}

/** Headroom clamped to the router's rules: a finite number >= 0, else 1. */
export function comboQuotaHeadroom(raw) {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 1;
}

/** Read the effective weight the router uses for one combo member. */
export function effectiveComboWeight(model, weights, headroom) {
  return comboBaseWeight(model, weights) * comboQuotaHeadroom(headroom);
}

/**
 * Percent share (1 decimal) each combo member gets under the weighted
 * strategy. Per model: duplicate rows show the same share because the router
 * dedupes weighted candidates.
 */
export function comboShares(models, weights, headroomByModel) {
  const shareByModel = new Map();
  let total = 0;
  for (const model of models || []) {
    if (typeof model !== "string" || shareByModel.has(model)) continue;
    const weight = effectiveComboWeight(model, weights, headroomByModel?.[model]);
    shareByModel.set(model, weight);
    total += weight;
  }
  return (models || []).map((model) => {
    const weight = shareByModel.get(model) ?? 0;
    return total > 0 ? Math.round((weight / total) * 1000) / 10 : 0;
  });
}
