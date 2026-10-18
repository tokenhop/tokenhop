// Device-session cache + touch memo (YAN-751). Leaf module: NO imports, so both
// sessionsRepo and gatewayKeyTransfer can use it without an import cycle.
// On globalThis: Next bundles proxy handlers separately, each with its own
// module copy; a revoke in a route must reach the guard's cache.
// Hits only: a miss is never cached, so a just-created row is visible at once.

// Same value as usersRepo's SESSION_TTL_MS (duplicated to keep this a leaf).
export const SESSION_CACHE_TTL_MS = 5000;

globalThis.__tokenhopDeviceSessionCache ??= new Map();
globalThis.__tokenhopDeviceSessionTouch ??= new Map();
export const sessionCache = globalThis.__tokenhopDeviceSessionCache;
export const lastTouch = globalThis.__tokenhopDeviceSessionTouch;

export const sessionCacheKey = (id) => `sid:${id}`;

export function dropSessionCache(...ids) {
  for (const id of ids) {
    if (typeof id !== "string") continue;
    sessionCache.delete(sessionCacheKey(id));
    lastTouch.delete(id);
  }
}

export function invalidateSessionCache(...ids) {
  if (ids.length === 0) {
    sessionCache.clear();
    lastTouch.clear();
    return;
  }
  dropSessionCache(...ids);
}
