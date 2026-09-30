// Weighted-target resolution (YAN-259). Neutral module so the usage route and the
// snapshot poller can share it without a route <-> poller import cycle.
import { getSettings, getCombos, getModelAliases } from "@/lib/localDb";
import { parseModel, resolveModelAliasFromMap } from "open-sse/services/model.js";

import { resolveComboStrategy } from "open-sse/services/comboStrategy.js";

// Weighted combos name their providers by combo model prefix; combos without a
// per-combo entry inherit settings.comboStrategy. Prefix before "/" is enough.
function comboIsWeighted(combo, settings) {
  return resolveComboStrategy(settings, combo?.name).strategy === "weighted";
}

// All combo member providers, regardless of strategy. Never throws on malformed
// models: one bad entry must not abort resolution. Bare alias members resolve
// through `aliases` (YAN-386); a member matching a combo name is a nested combo,
// resolved from its own entry (routing checks combo names before aliases).
export function comboMemberProviders(combos, aliases = {}, allCombos = combos) {
  const members = new Set();
  const comboNames = new Set((allCombos || []).map((combo) => combo?.name));
  for (const combo of combos || []) {
    for (const model of combo?.models || []) {
      try {
        const raw = typeof model === "string" ? model : (model?.model ?? model?.name);
        if (typeof raw !== "string") continue;
        const { provider, isAlias } = parseModel(raw);
        if (!isAlias && provider) members.add(provider);
        if (isAlias && !comboNames.has(raw)) {
          const resolved = resolveModelAliasFromMap(raw, aliases);
          if (resolved?.provider) members.add(resolved.provider);
        }
      } catch {
        // One malformed combo model must not abort resolution.
      }
    }
  }
  return members;
}

export function weightedProviders(settings, combos, providerIds = [], aliases = {}) {
  const direct = new Set(
    Object.entries(settings?.providerStrategies || {})
      .filter(([, strategy]) => strategy?.fallbackStrategy === "weighted")
      .map(([provider]) => provider),
  );
  if (settings?.fallbackStrategy === "weighted") {
    for (const provider of providerIds) {
      if (
        provider &&
        (settings.providerStrategies?.[provider]?.fallbackStrategy || "weighted") === "weighted"
      ) {
        direct.add(provider);
      }
    }
  }
  const weightedCombos = (combos || []).filter((combo) => comboIsWeighted(combo, settings));
  for (const provider of comboMemberProviders(weightedCombos, aliases, combos)) {
    direct.add(provider);
  }
  return direct;
}

// Never throws: any lookup failure means "not weighted".
export async function isWeightedProvider(
  provider,
  deps = { getSettings, getCombos, getModelAliases },
) {
  try {
    const settings = await deps.getSettings();
    const combos = deps.getCombos ? await deps.getCombos().catch(() => []) : [];
    const aliases = deps.getModelAliases ? await deps.getModelAliases().catch(() => ({})) : {};
    // Global weighted applies to any provider without its own override.
    return weightedProviders(settings, combos, [provider], aliases).has(provider);
  } catch {
    return false;
  }
}
