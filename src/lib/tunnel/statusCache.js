// Shared, hot-reload-safe cache for /api/tunnel/status. Mutation routes call
// invalidateTunnelStatusCache() after changing tunnel state so the UI's
// post-action refetch never reads a pre-mutation snapshot.
const cache = global.__tunnelStatusCache ?? { value: null, fetchedAt: 0 };
cache.value = cache.value ?? null;
cache.fetchedAt = cache.fetchedAt ?? 0;
global.__tunnelStatusCache = cache;

export const STATUS_CACHE_TTL_MS = 3000;

/** @returns {{ tunnel: object, tailscale: object }|null} cached probes, or null when stale */
export function peekTunnelStatus() {
  if (cache.value && Date.now() - cache.fetchedAt < STATUS_CACHE_TTL_MS) return cache.value;
  return null;
}

/** @param {{ tunnel: object, tailscale: object }} value fresh probe results */
export function storeTunnelStatus(value) {
  cache.value = value;
  cache.fetchedAt = Date.now();
}

/** Drop the cached snapshot so the next GET re-probes immediately. */
export function invalidateTunnelStatusCache() {
  cache.value = null;
  cache.fetchedAt = 0;
}
