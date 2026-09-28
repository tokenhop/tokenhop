/**
 * Pure providers & models helpers shared by the Settings section.
 * Union-aware thinking-level lookup rides open-sse thinkingLevels
 * (same picker math as providers/[id]/page.js); quota/autoping shapes
 * mirror the Usage page and quotaAutoPing consumer.
 */

const MAX_QUOTA_KEYS = 1000;
const MAX_QUOTA_KEY_LEN = 256;

/**
 * Union of selectable thinking levels across a provider's models,
 * excluding "none" (picker meaning of "disable" is unclear here).
 * Sorted for a stable picker order regardless of model scan order.
 * @param {string} providerId Provider id (e.g. "claude").
 * @param {string[]} modelIds Model ids of that provider.
 * @param {(provider: string, model: string) => string[] | null} getLevels
 *   open-sse getThinkingLevels (injected so this stays pure).
 * @returns {string[] | null} Levels, or null when no reasoning model exists.
 */
export function unionThinkingLevels(providerId, modelIds = [], getLevels) {
  const set = new Set();
  const seen = new Set();
  for (const modelId of modelIds) {
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    const levels = getLevels(providerId, modelId);
    if (levels) {
      for (const level of levels) {
        if (level !== "none") set.add(level);
      }
    }
  }
  if (set.size === 0) return null;
  return ["auto", ...[...set].sort()];
}

/**
 * Provider ids with at least one reasoning model (drives the editor list).
 * @param {string[]} providerIds Provider ids to scan.
 * @param {(provider: string) => string[]} modelsFor Function returning model ids.
 * @param {(provider: string, model: string) => string[] | null} getLevels
 * @returns {string[]} Provider ids with thinking levels.
 */
export function providersWithThinking(providerIds = [], modelsFor, getLevels) {
  return providerIds.filter((providerId) => {
    const models = modelsFor(providerId) || [];
    return models.some((modelId) => {
      const levels = getLevels(providerId, modelId);
      return Array.isArray(levels) && levels.some((level) => level !== "none");
    });
  });
}

/**
 * Merge one provider's thinking mode into the stored map.
 * "auto"/empty deletes the entry (same as providers/[id]/page.js).
 * @param {object} current Stored providerThinking map.
 * @param {string} providerId Provider id.
 * @param {string} mode Level id or "auto".
 * @returns {object} Next providerThinking map.
 */
export function setProviderThinkingMode(current = {}, providerId, mode) {
  const updated = { ...(current || {}) };
  if (!mode || mode === "auto") delete updated[providerId];
  else updated[providerId] = { mode };
  return updated;
}

/**
 * Merge one quota key into the stored visibility map.
 * @param {object} current Stored quotaVisibility map.
 * @param {string} provider Provider id.
 * @param {string} key Quota key to hide/show.
 * @param {boolean} hidden True to hide, false to show.
 * @returns {object} Next quotaVisibility map.
 */
export function setQuotaHiddenKey(current = {}, provider, key, hidden) {
  const trimmed = String(key || "").trim();
  if (!provider || !trimmed) throw new Error("Provider and quota key are required");
  if (trimmed.length > MAX_QUOTA_KEY_LEN) throw new Error("Quota key too long");
  const entry = { ...(current?.[provider] ?? {}) };
  const hiddenKeys = new Set(entry.hidden ?? []);
  if (hidden) {
    hiddenKeys.add(trimmed);
    if (hiddenKeys.size > MAX_QUOTA_KEYS) throw new Error("Too many hidden quota keys");
  } else {
    hiddenKeys.delete(trimmed);
  }
  const updated = { ...(current || {}) };
  if (hiddenKeys.size === 0 && Object.keys(entry).length <= 1) delete updated[provider];
  else updated[provider] = { ...entry, hidden: [...hiddenKeys] };
  return updated;
}

/**
 * Coerce a per-connection auto-ping payload: booleans by connection id.
 * @param {*} value Stored claudeAutoPing/codexAutoPing value.
 * @returns {Record<string, boolean>} Connection id → enabled.
 */
export function autoPingConnections(value) {
  const connections = value?.connections;
  if (!connections || typeof connections !== "object" || Array.isArray(connections)) return {};
  return Object.fromEntries(
    Object.entries(connections).filter(([, on]) => typeof on === "boolean"),
  );
}

/**
 * Hidden keys list for one provider from the stored visibility map.
 * @param {object} quotaVisibility Stored quotaVisibility map.
 * @param {string} provider Provider id.
 * @returns {string[]} Hidden quota keys.
 */
export function hiddenKeysForProvider(quotaVisibility = {}, provider) {
  const hidden = quotaVisibility?.[provider]?.hidden;
  return Array.isArray(hidden) ? hidden.filter((key) => typeof key === "string") : [];
}

/**
 * @param {object} quotaVisibility Stored quotaVisibility map.
 * @returns {string[]} Provider ids present in the map.
 */
export function quotaProviders(quotaVisibility = {}) {
  if (!quotaVisibility || typeof quotaVisibility !== "object") return [];
  return Object.keys(quotaVisibility);
}
