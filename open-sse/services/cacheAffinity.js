/**
 * Conversation cache affinity (YAN-1211 / YAN-1213): pin a conversation to one
 * combo member / provider account so the provider's prompt cache stays warm.
 * Pure, in-memory, per process. Pins hold ids only, never credentials.
 */

import { CACHE_AFFINITY_MAX_PINS, CACHE_AFFINITY_TTL_MS } from "../config/runtimeConfig.js";

const SEP = "\n";

/** TTL (sliding) + LRU-capped map. now() injectable for tests. */
export function createPinStore({ ttlMs, maxPins, now = Date.now }) {
  const map = new Map(); // insertion order = LRU order (oldest first)

  function touch(key, value) {
    map.delete(key);
    map.set(key, { value, expiresAt: now() + ttlMs });
  }

  return {
    get(key) {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        map.delete(key);
        return undefined;
      }
      touch(key, entry.value);
      return entry.value;
    },
    set(key, value) {
      touch(key, value);
      while (map.size > maxPins) map.delete(map.keys().next().value);
    },
    delete(key) {
      map.delete(key);
    },
    deleteWhere(pred) {
      for (const key of [...map.keys()]) if (pred(key)) map.delete(key);
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}

const storeConfig = { ttlMs: CACHE_AFFINITY_TTL_MS, maxPins: CACHE_AFFINITY_MAX_PINS };
export const comboPins = createPinStore(storeConfig);
export const accountPins = createPinStore(storeConfig);

/** `${comboName}\n${conversationKey}`; comboName is already workspace-scoped. */
export function comboPinKey(comboName, conversationKey) {
  if (!comboName || !conversationKey) return null;
  return `${comboName}${SEP}${conversationKey}`;
}

/** `${workspaceId ?? ""}\n${providerId}\n${conversationKey}` (empty ws segment = legacy). */
export function accountPinKey(workspaceId, providerId, conversationKey) {
  if (!providerId || !conversationKey) return null;
  return `${workspaceId ?? ""}${SEP}${providerId}${SEP}${conversationKey}`;
}

/** Drop pins of one combo, or all when omitted. */
export function clearComboPins(comboName) {
  if (comboName == null) return comboPins.clear();
  const prefix = `${comboName}${SEP}`;
  comboPins.deleteWhere((key) => key.startsWith(prefix));
}

/** Drop account pins of one provider (2nd segment), or all when omitted. */
export function clearAccountPins(providerId) {
  if (providerId == null) return accountPins.clear();
  accountPins.deleteWhere((key) => key.split(SEP)[1] === providerId);
}

/** New array: `pin` moved to index 0 when present in `order`, else a copy of `order`. */
export function orderAroundPin(order, pin) {
  if (!order.includes(pin)) return [...order];
  return [pin, ...order.filter((item) => item !== pin)];
}
