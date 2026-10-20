import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { STAT_INTERVAL_MS, catalogGeneration } from "open-sse/providers/catalogOverride.js";

// The budget estimate needs one number per attempt: the model's output limit.
// It comes from the static capability tables plus the synced catalog; custom-model
// caps only override booleans, so they never move it. Memoized per provider:model,
// dropped when the catalog is invalidated or re-read (catalogGeneration) and after
// the same interval the catalog itself uses to notice a foreign write. Bounded
// because the model id is client-supplied.
const MAX_ENTRIES = 512;
const memo = new Map(); // `${provider}\0${model}` → { value, gen, at }

/** @returns {number} the model's maxOutput, or Infinity when unknown. */
export function maxOutputFor(provider, model) {
  const key = `${provider ?? ""}\0${model ?? ""}`;
  const now = Date.now();
  const hit = memo.get(key);
  if (hit && hit.gen === catalogGeneration() && now >= hit.at && now - hit.at < STAT_INTERVAL_MS) {
    return hit.value;
  }
  const value = Number(getCapabilitiesForModel(provider, model)?.maxOutput) || Infinity;
  // Read the generation after the lookup: it may have just re-read the catalog.
  memo.delete(key);
  for (const [k, entry] of memo) {
    if (now - entry.at >= STAT_INTERVAL_MS || now < entry.at) memo.delete(k);
  }
  while (memo.size >= MAX_ENTRIES) memo.delete(memo.keys().next().value);
  memo.set(key, { value, gen: catalogGeneration(), at: now });
  return value;
}
