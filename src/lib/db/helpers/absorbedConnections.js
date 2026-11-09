// YAN-1941: removed→kept id map for codex duplicates a reconnect absorbed
// (YAN-1623). absorbDuplicateInTx repoints rows already stored; a request
// still in flight on the removed row writes later, so usage and request-detail
// writes resolve their connectionId through this map. Leaf module, NO imports.
// On globalThis: Next bundles route handlers separately, each with its own
// module copy, and the absorb and the late write can run in different bundles.

// Longer than any request can stay in flight (streams included).
export const ABSORBED_TTL_MS = 60 * 60 * 1000;
// Duplicates are rare; the cap only bounds memory if something loops.
const MAX_ENTRIES = 1000;
// A keeper can itself be absorbed later; follow that chain a few hops.
const MAX_HOPS = 8;

globalThis.__tokenhopAbsorbedConnections ??= new Map();
const absorbed = globalThis.__tokenhopAbsorbedConnections;

/** Record that `removedId` was merged into `keptId`. Call after the commit. */
export function recordAbsorbedConnection(removedId, keptId, nowMs = Date.now()) {
  if (typeof removedId !== "string" || typeof keptId !== "string" || removedId === keptId) return;
  absorbed.delete(removedId);
  absorbed.set(removedId, { keptId, expiresAt: nowMs + ABSORBED_TTL_MS });
  while (absorbed.size > MAX_ENTRIES) absorbed.delete(absorbed.keys().next().value);
}

/** The kept id for an absorbed connection, else `id` unchanged. */
export function resolveAbsorbedConnectionId(id, nowMs = Date.now()) {
  if (typeof id !== "string" || absorbed.size === 0) return id;
  let current = id;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const hit = absorbed.get(current);
    if (!hit) break;
    if (hit.expiresAt <= nowMs) {
      absorbed.delete(current);
      break;
    }
    current = hit.keptId;
  }
  return current;
}

/** Test hook. */
export function clearAbsorbedConnections() {
  absorbed.clear();
}
