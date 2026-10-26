/**
 * Conversation cache affinity (YAN-1211 / YAN-1213): pin a conversation to one
 * combo member / provider account so the provider's prompt cache stays warm.
 * Pure, in-memory, per process. Pins hold ids only, never credentials.
 *
 * Every key starts with its workspace segment (`""` = legacy / no workspace).
 * That segment is the pin's scope: a workspace cannot evict another's pins
 * (YAN-1221) and a workspace save can reset just its own.
 */

import {
  CACHE_AFFINITY_MAX_PINS,
  CACHE_AFFINITY_MAX_PINS_PER_WORKSPACE,
  CACHE_AFFINITY_PROMPT_PIN_MAX_AGE_MS,
  CACHE_AFFINITY_TTL_MS,
} from "../config/runtimeConfig.js";

const SEP = "\n";

/** An unsettled account pin lives this long, absolute (never renewed). */
const PENDING_PIN_TTL_MS = 60 * 1000;

const firstSegment = (key) => {
  const i = key.indexOf(SEP);
  return i < 0 ? key : key.slice(0, i);
};

/**
 * Sliding-TTL + LRU-capped map with an optional per-scope LRU cap and an
 * optional absolute lifetime per key. now() injectable for tests.
 * @param {object} options
 * @param {number} options.ttlMs - Sliding TTL, renewed by get/set.
 * @param {number} options.maxPins - Global LRU cap.
 * @param {number} [options.maxPinsPerScope=Infinity] - LRU cap per scope.
 * @param {(key: string) => string} [options.scopeOf] - Scope of a key (default: first segment).
 * @param {((key: string) => number)|null} [options.maxAgeFor] - Absolute lifetime of a key
 *   measured from its first write; get/set never extend it. Infinity = sliding only.
 * @param {() => number} [options.now]
 */
export function createPinStore({
  ttlMs,
  maxPins,
  maxPinsPerScope = Infinity,
  scopeOf = firstSegment,
  maxAgeFor = null,
  now = Date.now,
}) {
  /** @type {Map<string, {value: any, expiresAt: number, createdAt: number, scope: string}>} */
  const map = new Map(); // insertion order = global LRU order (oldest first)
  /** @type {Map<string, Set<string>>} */
  const scopes = new Map(); // scope -> keys, insertion order = per-scope LRU order

  function remove(key) {
    const entry = map.get(key);
    if (!entry) return;
    map.delete(key);
    const set = scopes.get(entry.scope);
    if (!set) return;
    set.delete(key);
    if (set.size === 0) scopes.delete(entry.scope);
  }

  function insert(key, value, createdAt, version) {
    remove(key);
    const scope = scopeOf(key);
    map.set(key, { value, createdAt, expiresAt: now() + ttlMs, scope, version });
    let set = scopes.get(scope);
    if (!set) scopes.set(scope, (set = new Set()));
    set.add(key);
    while (set.size > maxPinsPerScope) remove(set.values().next().value);
    while (map.size > maxPins) remove(map.keys().next().value);
  }

  function live(key, entry) {
    const t = now();
    if (entry.expiresAt <= t) return false;
    return !maxAgeFor || t - entry.createdAt < maxAgeFor(key);
  }

  return {
    /** Value when live, renewing its sliding TTL and LRU position. */
    get(key) {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (!live(key, entry)) {
        remove(key);
        return undefined;
      }
      insert(key, entry.value, entry.createdAt, entry.version);
      return entry.value;
    },
    /** Value when live, without renewing anything. */
    peek(key) {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (!live(key, entry)) {
        remove(key);
        return undefined;
      }
      return entry.value;
    },
    /** Write; a live entry keeps its createdAt so re-pinning never extends max age. */
    set(key, value) {
      const prev = map.get(key);
      const version = Symbol("pinVersion");
      insert(key, value, prev && live(key, prev) ? prev.createdAt : now(), version);
      return version;
    },
    /** Identity of a live write; reads preserve it, every set replaces it. */
    version(key) {
      const entry = map.get(key);
      return entry && live(key, entry) ? entry.version : undefined;
    },
    delete(key) {
      remove(key);
    },
    deleteWhere(pred) {
      for (const key of [...map.keys()]) if (pred(key)) remove(key);
    },
    deleteScope(scope) {
      for (const key of [...(scopes.get(scope) ?? [])]) remove(key);
    },
    clear() {
      map.clear();
      scopes.clear();
    },
    get size() {
      return map.size;
    },
  };
}

// Prompt-hash ("p:") conversation keys are shared by every request that opens with
// the same prompt, so they get an absolute lifetime; client session ("s:") keys slide.
const promptPinMaxAge = (key) =>
  key.startsWith("p:", key.lastIndexOf(SEP) + 1) ? CACHE_AFFINITY_PROMPT_PIN_MAX_AGE_MS : Infinity;

const storeConfig = {
  ttlMs: CACHE_AFFINITY_TTL_MS,
  maxPins: CACHE_AFFINITY_MAX_PINS,
  maxPinsPerScope: CACHE_AFFINITY_MAX_PINS_PER_WORKSPACE,
  maxAgeFor: promptPinMaxAge,
};
export const comboPins = createPinStore(storeConfig);
export const accountPins = createPinStore(storeConfig);
/**
 * Provisional account pins (YAN-1222): written at selection so a concurrent first
 * turn converges on the same account, promoted to `accountPins` only when the
 * account served. Entries are `{ connectionId, token }`; read with peek().
 */
export const pendingAccountPins = createPinStore({
  ttlMs: PENDING_PIN_TTL_MS,
  maxPins: CACHE_AFFINITY_MAX_PINS,
  maxPinsPerScope: CACHE_AFFINITY_MAX_PINS_PER_WORKSPACE,
});

/** `${workspaceId ?? ""}\n${comboName}\n${conversationKey}` (empty ws segment = legacy). */
export function comboPinKey(workspaceId, comboName, conversationKey) {
  if (!comboName || !conversationKey) return null;
  return `${workspaceId ?? ""}${SEP}${comboName}${SEP}${conversationKey}`;
}

/** `${workspaceId ?? ""}\n${providerId}\n${conversationKey}` (empty ws segment = legacy). */
export function accountPinKey(workspaceId, providerId, conversationKey) {
  if (!providerId || !conversationKey) return null;
  return `${workspaceId ?? ""}${SEP}${providerId}${SEP}${conversationKey}`;
}

// Shared by both clear helpers: `name` is the 2nd key segment (combo / provider).
function clearPins(stores, name, workspaceId) {
  const scope = workspaceId === undefined ? undefined : (workspaceId ?? "");
  for (const store of stores) {
    if (name == null && scope === undefined) store.clear();
    else if (name == null) store.deleteScope(scope);
    else {
      store.deleteWhere((key) => {
        const [ws, segment] = key.split(SEP);
        return segment === name && (scope === undefined || ws === scope);
      });
    }
  }
}

/**
 * Drop pins of one combo (by the name segment handleComboChat was given), or all
 * when omitted. `workspaceId` limits the drop to one workspace's pins.
 */
export function clearComboPins(comboName, { workspaceId } = {}) {
  clearPins([comboPins], comboName, workspaceId);
}

/**
 * Drop account pins (committed and provisional) of one provider, or all when
 * omitted. `workspaceId` limits the drop to one workspace's pins.
 */
export function clearAccountPins(providerId, { workspaceId } = {}) {
  clearPins([accountPins, pendingAccountPins], providerId, workspaceId);
}

/** New array: `pin` moved to index 0 when present in `order`, else a copy of `order`. */
export function orderAroundPin(order, pin) {
  if (!order.includes(pin)) return [...order];
  return [pin, ...order.filter((item) => item !== pin)];
}
