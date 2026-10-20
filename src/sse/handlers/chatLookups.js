import { cloneJson } from "@/lib/db/helpers/cloneJson.js";
import { deepFreeze } from "@/lib/utils/deepFreeze.js";
import { getModelInfo, getComboModels, getComboByName } from "../services/model.js";

// Resolved lookups are shared by every attempt of one request (and concurrent
// hedged attempts), so they are handed out frozen: no attempt can alter what a
// sibling or the authorization walk sees.
//
// Freezing is in place and permanent, so the lookup freezes only objects it OWNS:
// every result is cloned first. The services behind these calls may return
// objects that other code still holds (a combo's `models` array is a reference
// into the combo; a scoped combo is the request's shared gatewayResources memo;
// a test double may return a module-level fixture), and freezing those would
// change behavior for their other holders.
const own = (value) => deepFreeze(cloneJson(value));

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
      hit = load().then(own);
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
