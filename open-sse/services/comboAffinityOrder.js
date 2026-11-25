/**
 * Pure helpers for conversation cache affinity in handleComboChat (YAN-1211).
 * The pin store lives in cacheAffinity.js; this only decides whether a pin applies.
 */

import { comboPinKey, comboPins } from "./cacheAffinity.js";
import { comboBaseWeight } from "./comboWeights.js";
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

/**
 * The pinned member when it is still usable: still a combo member and, for
 * weighted, a configured weight > 0. Live quota headroom is deliberately not
 * checked (YAN-2467): an exhausted pinned model answers with its own error
 * instead of moving the conversation to another model.
 */
export function validComboPin(affinityKey, models, { comboStrategy, comboWeights } = {}) {
  const pin = affinityKey ? comboPins.get(affinityKey) : undefined;
  if (pin === undefined || !models.includes(pin)) return undefined;
  if (comboStrategy !== "weighted") return pin;
  return comboBaseWeight(pin, comboWeights) > 0 ? pin : undefined;
}

/** Upstream model id of a `provider/model` member; null for a bare member (nested combo name). */
function upstreamModelId(member) {
  const slash = typeof member === "string" ? member.indexOf("/") : -1;
  return slash > 0 ? member.slice(slash + 1) : null;
}

/**
 * Members a pinned turn may try (YAN-2467): the pin first, then other members
 * serving the same upstream model id through another provider (`cx/gpt-x` →
 * `openai/gpt-x`), in combo order. A bare pin (nested combo) matches only itself.
 * Never a different model, never an excluded (capacity-adapter) member: a
 * conversation must not move to another model mid-session, since the next
 * model would receive the first one's turns.
 * @param {string[]} models
 * @param {string} pin
 * @param {Set<string>} [exclude]
 * @returns {string[]}
 */
export function pinnedCandidates(models, pin, exclude = new Set()) {
  const id = upstreamModelId(pin);
  const same = models.filter(
    (m) => m !== pin && !exclude.has(m) && id !== null && upstreamModelId(m) === id,
  );
  return [pin, ...new Set(same)];
}
