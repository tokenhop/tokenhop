// Synchronous "usage row committed" hook (YAN-372, ADR-0007). saveRequestUsageUnscoped
// calls emitUsageCommitted(entry) right after its transaction commits; the gateway
// budget guard registers a listener. Lives under src/lib/usage so the db layer never
// imports from src/sse (no cycles). Process-wide via globalThis so Next HMR/duplicate
// module instances share one listener set. Listener errors never break usage saving.
if (!globalThis.__usageCommittedListeners) globalThis.__usageCommittedListeners = new Set();
const listeners = globalThis.__usageCommittedListeners;

/** @param {(entry: object) => void} fn @returns {() => void} unsubscribe */
export function onUsageCommitted(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** entry: { cost, promptTokens, completionTokens, workspaceId, userId, apiKeyId, grantId, timestamp } */
export function emitUsageCommitted(entry) {
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch (e) {
      console.warn("[usageCommitted] listener failed:", e?.message);
    }
  }
}
