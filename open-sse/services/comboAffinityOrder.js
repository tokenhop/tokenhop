/**
 * Pure helpers for conversation cache affinity in handleComboChat (YAN-1211).
 * The pin store lives in cacheAffinity.js; this only decides whether a pin applies.
 */

import { comboPinKey, comboPins } from "./cacheAffinity.js";
import { effectiveComboWeight } from "./comboWeights.js";
import { CACHE_AFFINITY_STRATEGIES } from "./comboStrategy.js";

/** Pin store key for this request, or null when affinity does not apply. */
export function comboAffinityKey({
  cacheAffinity,
  conversationKey,
  comboStrategy,
  comboName,
  workspaceId = null,
  onAttempt,
}) {
  if (!cacheAffinity || !conversationKey || typeof onAttempt === "function") return null;
  if (!CACHE_AFFINITY_STRATEGIES.includes(comboStrategy)) return null;
  return comboPinKey(workspaceId, comboName, conversationKey);
}

/** The pinned member when it is still usable (in `models`; weight > 0 for weighted). */
export function validComboPin(affinityKey, models, { comboStrategy, comboWeights, headroomFn }) {
  const pin = affinityKey ? comboPins.get(affinityKey) : undefined;
  if (pin === undefined || !models.includes(pin)) return undefined;
  if (comboStrategy !== "weighted") return pin;
  let headroom = 1;
  try {
    const h = headroomFn?.(pin);
    if (Number.isFinite(h)) headroom = h;
  } catch {
    headroom = 1;
  }
  return effectiveComboWeight(pin, comboWeights, headroom) > 0 ? pin : undefined;
}
