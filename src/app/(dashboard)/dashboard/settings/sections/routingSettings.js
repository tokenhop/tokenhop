/**
 * Pure routing-settings helpers: the plain-language summary shown in the
 * Routing section, and the providerStrategies override reducers. No React, no
 * fetch — safe to unit-test in Node.
 */

/**
 * @typedef {object} ProviderOverride
 * @property {string} [fallbackStrategy]
 * @property {number} [stickyRoundRobinLimit]
 * @property {Record<string, *>} [rest] Unrelated keys (proxy pool, …) — always preserved.
 */

/**
 * Plain-language summary of the current routing values.
 * @param {object} [settings={}] Server settings blob (may be sparse).
 * @returns {string} One plain-language paragraph.
 */
export function summarizeRouting(settings = {}) {
  const fallbackStrategy = settings?.fallbackStrategy ?? "fill-first";
  const sticky = settings?.stickyRoundRobinLimit ?? 3;
  const comboStrategy = settings?.comboStrategy ?? "fallback";
  const comboSticky = settings?.comboStickyRoundRobinLimit ?? 1;
  const overrides = settings?.providerStrategies ?? {};
  const overrideCount =
    overrides && typeof overrides === "object" ? Object.keys(overrides).length : 0;

  let account;
  if (fallbackStrategy === "round-robin") {
    account = `Each provider rotates through its accounts in turn, staying ${sticky} request(s) on one account before moving on.`;
  } else if (fallbackStrategy === "weighted") {
    account = `Each provider sends requests to accounts with the most remaining quota, staying ${sticky} request(s) on one account before reconsidering.`;
  } else {
    account =
      "Right now: each provider uses its accounts in priority order and moves on only when one fails or runs dry.";
  }

  let combo;
  if (comboStrategy === "round-robin") {
    combo = `Combos rotate through their models, staying ${comboSticky} request(s) per model.`;
  } else if (comboStrategy === "fusion") {
    combo = "Combos fuse answers from several models (managed per combo on the Combos page).";
  } else if (comboStrategy === "weighted") {
    combo = "Combos weight models by quota (managed per combo on the Combos page).";
  } else {
    combo = "Combos try models in order.";
  }

  const overrideText =
    overrideCount === 0
      ? ""
      : overrideCount === 1
        ? " 1 provider override beats the global strategy."
        : ` ${overrideCount} provider overrides beat the global strategy.`;

  return `${account} ${combo}${overrideText}`;
}

/**
 * Add or edit one routing override. Blank strategy/sticky ("" or null) clears
 * that key; dropping both removes the entry only when no unrelated keys
 * (proxy pool, rotation, …) remain.
 * @param {Record<string, object>} [map={}] Current providerStrategies value.
 * @param {string} providerId Provider key.
 * @param {{ fallbackStrategy?: string|null, stickyRoundRobinLimit?: number|string|null }} draft
 * @returns {Record<string, object>} New map (input untouched).
 */
export function applyProviderOverride(map = {}, providerId, draft = {}) {
  const next = { ...(map || {}) };
  const base = { ...(map?.[providerId] || {}) };
  const { fallbackStrategy, stickyRoundRobinLimit } = draft || {};
  if (fallbackStrategy) base.fallbackStrategy = fallbackStrategy;
  else delete base.fallbackStrategy;
  const sticky =
    stickyRoundRobinLimit === "" || stickyRoundRobinLimit == null
      ? null
      : Number(stickyRoundRobinLimit);
  if (sticky != null && Number.isInteger(sticky)) base.stickyRoundRobinLimit = sticky;
  else delete base.stickyRoundRobinLimit;
  if (Object.keys(base).length === 0) delete next[providerId];
  else next[providerId] = base;
  return next;
}

/**
 * Remove the routing keys of one provider override, keeping unrelated keys.
 * @param {Record<string, object>} [map={}] Current providerStrategies value.
 * @param {string} providerId Provider key.
 * @returns {Record<string, object>} New map (input untouched).
 */
export function removeProviderOverride(map = {}, providerId) {
  const next = { ...(map || {}) };
  const base = { ...(map?.[providerId] || {}) };
  delete base.fallbackStrategy;
  delete base.stickyRoundRobinLimit;
  if (Object.keys(base).length === 0) delete next[providerId];
  else next[providerId] = base;
  return next;
}
