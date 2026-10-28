// YAN-1237: shared list-price math for saved tokens, split out of
// usageSavingsRepo.js so getUsageSavings and the compare totals price
// identically. Pricing modules load lazily, only when a group has savings
// to price (same as the original helper).

/**
 * List-price value of a request's saved tokens. Every counted saver (RTK,
 * Headroom, PXPIPE) shrinks the prompt, so saved tokens are priced as
 * uncached input for the request's own provider/model — the same pricing
 * tables and math as usage cost. Unknown pricing returns 0 (never a guess).
 * @param {string|null} provider
 * @param {string|null} model
 * @param {number} savedTokens
 * @param {Map<string, Promise<object|null>>} [cache] per-call pricing lookups by provider/model
 * @returns {Promise<number>} dollars
 */
export async function savedTokensCost(provider, model, savedTokens, cache = new Map()) {
  if (!model || !(savedTokens > 0)) return 0;
  try {
    const key = `${provider}\u0000${model}`;
    if (!cache.has(key)) {
      const { getPricingForModel } = await import("./pricingRepo.js");
      cache.set(key, getPricingForModel(provider, model));
    }
    const pricing = await cache.get(key);
    if (!pricing || !(Number(pricing.input) > 0)) return 0;
    const { calculateCostFromTokens } = await import("open-sse/providers/pricing.js");
    return calculateCostFromTokens({ prompt_tokens: savedTokens }, pricing);
  } catch (e) {
    console.error("[usageSavingsPricing] savings pricing failed:", e.message);
    return 0;
  }
}

/**
 * Dollar sum over provider/model groups shaped like readSavingsTotals's
 * `byProviderModel` ({provider, model, tokensSavedEst, savingsRequests}).
 * Saved-token input pricing is linear: pricing grouped tokens equals pricing
 * each request, without retaining or parsing the request history.
 * @returns {Promise<{costSavedEst: number|null, pricedRequests: number}>}
 *   costSavedEst is null when no group had resolvable pricing (6dp rounding,
 *   same as getUsageSavings).
 */
export async function priceSavedGroups(groups, cache = new Map()) {
  let costSavedEst = 0;
  let pricedRequests = 0;
  for (const group of groups) {
    const cost = await savedTokensCost(group.provider, group.model, group.tokensSavedEst, cache);
    if (cost > 0) {
      costSavedEst += cost;
      pricedRequests += group.savingsRequests;
    }
  }
  return { costSavedEst: pricedRequests > 0 ? +costSavedEst.toFixed(6) : null, pricedRequests };
}
