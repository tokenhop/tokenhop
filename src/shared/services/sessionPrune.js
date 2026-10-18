// YAN-751: device-sessions prune: once now, then daily. Never breaks startup.
// Survive Next.js hot reload via the shared singleton (see initializeApp.js).
global.__appSingleton ??= {};
const g = global.__appSingleton;

const SESSION_PRUNE_MS = 24 * 60 * 60 * 1000;

async function pruneSessions() {
  try {
    const { isUserSecurityEnforced } = await import("@/lib/users/securityState.js");
    // Multi-user switch off: no `sessions` query runs (the switch check itself reads settings).
    if (!(await isUserSecurityEnforced())) return;
    const { pruneExpiredSessionsUnscoped } = await import("@/lib/db/index.js");
    await pruneExpiredSessionsUnscoped(new Date().toISOString());
  } catch (e) {
    console.log("[Sessions] prune failed:", e.message);
  }
}

export function startSessionPrune() {
  if (g.sessionPruneInterval) return;
  pruneSessions();
  g.sessionPruneInterval = setInterval(pruneSessions, SESSION_PRUNE_MS);
  if (g.sessionPruneInterval.unref) g.sessionPruneInterval.unref();
}
