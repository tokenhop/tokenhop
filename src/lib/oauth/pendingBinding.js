// Pending OAuth flow -> initiating principal/workspace binding (YAN-366,
// ADR-0001). Key = the OAuth `state` or the device flow's `deviceCode`.
// ponytail: per-process in-memory store (tokenhop runs one server process);
// promote to a DB/kv table if tokenhop is ever multi-process.
const DEFAULT_TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 1000;

const bindings = new Map();

function sweep(now = Date.now()) {
  for (const [key, entry] of bindings) {
    if (entry.expiresAt <= now) bindings.delete(key);
  }
}

/** Bind `key` to the initiating principal. Overwrites an existing entry. */
export function rememberBinding(key, { provider, userId, workspaceId, ctx }, { ttlMs } = {}) {
  if (!key) return;
  const now = Date.now();
  sweep(now);
  bindings.delete(key); // re-insert so FIFO order follows the latest write
  while (bindings.size >= MAX_ENTRIES) bindings.delete(bindings.keys().next().value);
  bindings.set(key, {
    provider,
    userId,
    workspaceId,
    ctx,
    expiresAt: now + (ttlMs ?? DEFAULT_TTL_MS),
  });
}

/** @returns {{provider, userId, workspaceId, ctx, expiresAt}|null} */
export function bindingFor(key) {
  if (!key) return null;
  sweep();
  return bindings.get(key) ?? null;
}

export function forgetBinding(key) {
  if (!key) return;
  sweep();
  bindings.delete(key);
}

export function ownerMatches(entry, userId) {
  return Boolean(entry) && entry.userId === userId;
}
