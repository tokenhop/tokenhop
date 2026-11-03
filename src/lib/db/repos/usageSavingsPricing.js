// YAN-1237: shared list-price math for saved tokens, split out of
// usageSavingsRepo.js so getUsageSavings and the compare totals price
// identically. Pricing modules load lazily, only when a group has savings
// to price (same as the original helper).

/**
 * Numeric input rate from a pricing entry: a number, or a non-blank numeric
 * string. Anything else (null, "", false, arrays) is unresolved (NaN) rather
 * than coerced to a free 0 rate.
 * @param {unknown} value
 * @returns {number}
 */
function parseRate(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return Number.NaN;
}

/**
 * List-price value of a request's saved tokens. Every counted saver (RTK,
 * Headroom, PXPIPE) shrinks the prompt, so saved tokens are priced as
 * uncached input for the request's own provider/model — the same pricing
 * tables and math as usage cost. Resolved pricing with a zero input rate (a
 * free model) returns 0; unresolved pricing returns null (never a guess).
 * @param {string|null} provider
 * @param {string|null} model
 * @param {number} savedTokens
 * @param {Map<string, Promise<object|null>>} [cache] per-call pricing lookups by provider/model
 * @returns {Promise<number|null>} dollars; null when there is no model, no
 *   saved tokens, no resolvable input rate, or the lookup failed
 */
export async function savedTokensCost(provider, model, savedTokens, cache = new Map()) {
  if (!model || !(savedTokens > 0)) return null;
  try {
    const key = `${provider}\u0000${model}`;
    if (!cache.has(key)) {
      const { getPricingForModel } = await import("./pricingRepo.js");
      cache.set(key, getPricingForModel(provider, model));
    }
    const pricing = await cache.get(key);
    const inputRate = pricing ? parseRate(pricing.input) : Number.NaN;
    if (!Number.isFinite(inputRate) || inputRate < 0) return null;
    if (inputRate === 0) return 0;
    const { calculateCostFromTokens } = await import("open-sse/providers/pricing.js");
    return calculateCostFromTokens({ prompt_tokens: savedTokens }, pricing);
  } catch (e) {
    console.error("[usageSavingsPricing] savings pricing failed:", e.message);
    return null;
  }
}

/**
 * Dollar sum over provider/model groups shaped like readSavingsTotals's
 * `byProviderModel` ({provider, model, tokensSavedEst, savingsRequests}).
 * Saved-token input pricing is linear: pricing grouped tokens equals pricing
 * each request, without retaining or parsing the request history.
 * @returns {Promise<{costSavedEst: number|null, pricedRequests: number}>}
 *   pricedRequests counts the requests of every group whose pricing resolved,
 *   free ($0) models included (YAN-1812). costSavedEst is the 6dp-rounded
 *   dollar sum (same as getUsageSavings), null when the rounded sum is not
 *   positive: no group resolved, or every resolved group was free (or priced
 *   below the 6dp resolution).
 */
export async function priceSavedGroups(groups, cache = new Map()) {
  let costSavedEst = 0;
  let pricedRequests = 0;
  for (const group of groups) {
    const cost = await savedTokensCost(group.provider, group.model, group.tokensSavedEst, cache);
    if (cost !== null) {
      costSavedEst += cost;
      pricedRequests += group.savingsRequests;
    }
  }
  const rounded = +costSavedEst.toFixed(6);
  return { costSavedEst: rounded > 0 ? rounded : null, pricedRequests };
}
