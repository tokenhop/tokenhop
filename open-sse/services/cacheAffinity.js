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
 * @param {() => (PinPersistence|null)} [options.persistence] - Write-through store
 *   (YAN-2468): writes, removals and a throttled last-used touch are mirrored to it
 *   fire-and-forget; reads never wait on it. Null (default) = memory only.
 * @param {number} [options.touchEveryMs] - Re-save a live entry on read at most this often.
 */
export function createPinStore({
  ttlMs,
  maxPins,
  maxPinsPerScope = Infinity,
  scopeOf = firstSegment,
  maxAgeFor = null,
  now = Date.now,
  persistence = () => null,
  touchEveryMs = PIN_TOUCH_EVERY_MS,
}) {
  /** @type {Map<string, {value: any, expiresAt: number, createdAt: number, scope: string, persistedAt?: number}>} */
  const map = new Map(); // insertion order = global LRU order (oldest first)
  /** @type {Map<string, Set<string>>} */
  const scopes = new Map(); // scope -> keys, insertion order = per-scope LRU order

  // Bumped by every bulk delete (clear/deleteWhere/deleteScope), even when it
  // matched nothing: a deferred commit whose entry is gone (first turn, or removed
  // by a reset) must not re-create it once a reset ran. Store-wide, not per-scope,
  // because pred-based deletes cannot name scopes; the cost is that any reset drops
  // in-flight deferred writes that have no entry yet (e.g. first-turn account pins,
  // whose provisional pin lives in pendingAccountPins); the next turn pins again.
  let generation = 0;

  // Persistence is fail-open: a throw or rejection never reaches routing.
  const mirror = (op, ...args) => {
    const store = persistence();
    if (!store?.[op]) return;
    try {
      Promise.resolve(store[op](...args)).catch(() => {});
    } catch {
      // ignore
    }
  };
  const persistEntry = (key, entry) => {
    entry.persistedAt = now();
    mirror("save", key, {
      value: entry.value,
      createdAt: entry.createdAt,
      touchedAt: entry.persistedAt,
    });
  };

  // Drop from memory only (an entry being re-inserted keeps its persisted copy).
  function unlink(key) {
    const entry = map.get(key);
    if (!entry) return;
    map.delete(key);
    const set = scopes.get(entry.scope);
    if (!set) return;
    set.delete(key);
    if (set.size === 0) scopes.delete(entry.scope);
  }

  // Drop for good: expiry, eviction or an explicit delete.
  function remove(key) {
    if (!map.has(key)) return;
    unlink(key);
    mirror("remove", key);
  }

  function insert(key, value, createdAt, version, persistedAt, expiresAt = now() + ttlMs) {
    unlink(key);
    const scope = scopeOf(key);
    const entry = { value, createdAt, expiresAt, scope, version, persistedAt };
    map.set(key, entry);
    let set = scopes.get(scope);
    if (!set) scopes.set(scope, (set = new Set()));
    set.add(key);
    while (set.size > maxPinsPerScope) remove(set.values().next().value);
    while (map.size > maxPins) remove(map.keys().next().value);
    return entry;
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
      const renewed = insert(key, entry.value, entry.createdAt, entry.version, entry.persistedAt);
      if (!(now() - (renewed.persistedAt ?? 0) < touchEveryMs)) persistEntry(key, renewed);
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
      const entry = insert(key, value, prev && live(key, prev) ? prev.createdAt : now(), version);
      persistEntry(key, entry);
      return version;
    },
    /**
     * Re-load a persisted entry (startup). Keeps its createdAt and sliding expiry
     * from its last touch; never writes back. False when it is no longer live.
     */
    restore(key, value, createdAt, touchedAt) {
      if (![createdAt, touchedAt].every(Number.isFinite)) return false;
      const entry = { createdAt, expiresAt: touchedAt + ttlMs };
      if (!live(key, entry)) return false;
      const version = Symbol("pinVersion");
      insert(key, value, createdAt, version, touchedAt, entry.expiresAt);
      return map.has(key);
    },
    /** Identity of a live write; reads preserve it, every set replaces it. */
    version(key) {
      const entry = map.get(key);
      return entry && live(key, entry) ? entry.version : undefined;
    },
    /** Monotonic store generation; every bulk delete bumps it (see above). */
    generation() {
      return generation;
    },
    delete(key) {
      remove(key);
    },
    deleteWhere(pred) {
      generation++;
      for (const key of [...map.keys()]) if (pred(key)) remove(key);
    },
    deleteScope(scope) {
      generation++;
      for (const key of [...(scopes.get(scope) ?? [])]) remove(key);
    },
    clear() {
      generation++;
      map.clear();
      scopes.clear();
      mirror("clear");
    },
    get size() {
      return map.size;
    },
  };
}

/**
 * @typedef {object} PinPersistence
 * @property {(key: string, record: {value: any, createdAt: number, touchedAt: number}) => any} save
 * @property {(key: string) => any} remove
 * @property {() => any} clear
 */

/** A live pin re-saves its last-used time at most this often (YAN-2468). */
const PIN_TOUCH_EVERY_MS = 5 * 60 * 1000;
const COMBO_PIN_PERSISTENCE = Symbol.for("tokenhop.comboPinPersistence");

/**
 * Install (or clear with null) the store combo pins are mirrored to, so a gateway
 * restart does not move running conversations to another model (YAN-2468). The app
 * installs it at startup; open-sse never imports the DB layer.
 * @param {PinPersistence|null} store
 */
export function setComboPinPersistence(store) {
  globalThis[COMBO_PIN_PERSISTENCE] = store || null;
}

/**
 * Load persisted combo pins into memory, oldest touch first so LRU order holds.
 * @param {Iterable<[string, {value: any, createdAt: number, touchedAt: number}]>} records
 * @returns {{ restored: number, stale: string[] }} stale = keys no longer live (delete them)
 */
export function restoreComboPins(records) {
  const rows = [...records].filter(([key, r]) => typeof key === "string" && r && "value" in r);
  rows.sort((a, b) => (a[1].touchedAt ?? 0) - (b[1].touchedAt ?? 0));
  const stale = [];
  let restored = 0;
  for (const [key, r] of rows) {
    if (comboPins.restore(key, r.value, r.createdAt, r.touchedAt)) restored++;
    else stale.push(key);
  }
  return { restored, stale };
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
export const comboPins = createPinStore({
  ...storeConfig,
  persistence: () => globalThis[COMBO_PIN_PERSISTENCE] || null,
});
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
