// One rule for every dashboard provider status. Connected means at least one enabled
// connection, even when that connection needs attention. No-auth ready is separate.
const RANK = { off: 0, ok: 1, warn: 2, err: 3 };

export function cooldownUntil(connection, nowMs = Date.now()) {
  let earliest = null;
  for (const [key, value] of Object.entries(connection || {})) {
    if (!key.startsWith("modelLock_") || !value) continue;
    const time = new Date(value).getTime();
    if (time > nowMs && (!earliest || time < earliest.time)) earliest = { time, value };
  }
  return earliest?.value || null;
}

/** Pure connection assessment. Reason/action come from safe status fields, never raw error text. */
export function connectionHealth(connection, nowMs = Date.now()) {
  if (!connection || connection.isActive === false)
    return { status: "off", reason: "Disabled", action: "enable" };

  const until = cooldownUntil(connection, nowMs);
  const code = Number(connection.errorCode);
  const safeCode = Number.isInteger(code) && code >= 400 && code <= 599 ? String(code) : null;
  if (connection.lastErrorType === "token_refresh_failed")
    return { status: "err", reason: "Token refresh failed · reconnect", action: "reconnect" };
  if (connection.testStatus === "expired" || connection.lastErrorType === "token_expired")
    return { status: "err", reason: "Token expired · reconnect", action: "reconnect" };
  if (until || connection.testStatus === "cooldown")
    return { status: "warn", reason: "Cooling down", action: "open", until };
  if (connection.testStatus === "error")
    return {
      status: "err",
      reason: safeCode ? `Test failed · ${safeCode}` : "Test failed",
      action: safeCode === "401" || safeCode === "403" ? "reconnect" : "test",
      code: safeCode,
    };
  // Untested or stale-unavailable accounts are not a current outage. Unknown statuses fail
  // closed as warnings so a new persisted error value cannot look healthy.
  if (
    connection.testStatus === "unavailable" ||
    !connection.testStatus ||
    ["active", "success", "ok", "unknown", "untested", "pending"].includes(connection.testStatus)
  )
    return { status: "ok", reason: null, action: null };
  return { status: "warn", reason: "Status unknown · test", action: "test" };
}

/** Worst enabled connection wins. Disabled accounts cannot mask active failures. */
export function providerHealth(connections, nowMs = Date.now()) {
  const counts = { ok: 0, warn: 0, err: 0, off: 0 };
  let worst = { status: "off", reason: null, action: null };
  for (const connection of connections || []) {
    const health = connectionHealth(connection, nowMs);
    counts[health.status] += 1;
    if (RANK[health.status] > RANK[worst.status]) worst = health;
  }
  const connected = counts.ok + counts.warn + counts.err > 0;
  return { ...worst, connected, needsAttention: counts.warn + counts.err > 0, counts };
}

/** Unique provider totals; registry entries with noAuth are ready but not connected. */
export function summarizeProviders(providers = [], connections = [], nowMs = Date.now()) {
  const byId = new Map();
  for (const provider of providers || []) {
    const id = provider.id || provider.provider;
    if (id) byId.set(id, { ...provider, id });
  }
  for (const connection of connections || []) {
    if (connection?.provider && !byId.has(connection.provider))
      byId.set(connection.provider, { id: connection.provider });
  }
  const result = [...byId.values()].map((provider) => ({
    ...provider,
    ...providerHealth(
      provider.isNoAuth ? [] : (connections || []).filter((c) => c.provider === provider.id),
      nowMs,
    ),
  }));
  return {
    connected: result.filter((p) => p.connected).length,
    needsAttention: result.filter((p) => p.needsAttention).length,
    noAuthReady: result.filter((p) => p.isNoAuth).length,
    providers: result,
  };
}
