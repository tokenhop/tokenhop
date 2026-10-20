import { getModelInfo, getComboModels, getComboByName } from "../services/model.js";

// Resolved lookups are shared by every attempt of one request (and concurrent
// hedged attempts), so they are handed out frozen: no attempt can alter what a
// sibling or the authorization walk sees. Deep-frozen; callers only read them.
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * Per-request routing lookups for the chat handler. One instance lives for one
 * handleChat call (never module-level, never shared across requests), so combo
 * and model resolution that the handler repeats for the same name (outer combo,
 * authorization walk, leaf attempt, every fallback hop) hits storage once.
 * In-flight promises are shared so concurrent hedged attempts also coalesce;
 * a rejected lookup is dropped so the next call retries instead of replaying
 * the failure. Authorization (authorizeGatewayTarget) and the live key /
 * disabled-model rechecks are NOT memoized here: they always run per call.
 */
export function createChatLookups(gateway) {
  const principalOpts = { principal: gateway };
  const modelOpts = gateway ? principalOpts : {};
  const caches = { combo: new Map(), models: new Map(), info: new Map() };

  const memo = (cache, key, load) => {
    let hit = cache.get(key);
    if (!hit) {
      hit = load().then(deepFreeze);
      cache.set(key, hit);
      hit.catch(() => {
        if (cache.get(key) === hit) cache.delete(key);
      });
    }
    return hit;
  };

  return {
    gateway,
    comboByName: (name) => memo(caches.combo, name, () => getComboByName(name, principalOpts)),
    comboModels: (name) => memo(caches.models, name, () => getComboModels(name, principalOpts)),
    modelInfo: (name) => memo(caches.info, name, () => getModelInfo(name, modelOpts)),
  };
}
