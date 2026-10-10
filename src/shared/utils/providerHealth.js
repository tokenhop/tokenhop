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

// Exact lastError strings persisted by testSingleConnection
// (src/app/api/providers/[id]/test/testUtils.js) that mean the stored credential is dead.
const CREDENTIAL_FAILURES = new Map([
  ["Token expired and refresh failed", "Token refresh failed"],
  ["Token expired", "Token expired"],
  ["Token invalid or revoked", "Token revoked"],
  ["Access denied", "Access denied"],
  ["No access token", "Signed out"],
  ["Invalid API key", "Key rejected"],
  ["Invalid session cookie", "Cookie rejected"],
  ["Invalid SSO cookie", "Cookie rejected"],
  ["Session expired — re-paste cookie", "Cookie expired"],
]);

/**
 * Repair only where an existing flow replaces this credential:
 * OAuth re-sign-in, or PUT /api/providers/[id] which accepts a new apiKey
 * for apikey and cookie rows. iFlow cookies need cookie exchange, and
 * api_key/access_token imports store accessToken, which that PUT ignores.
 */
export function repairAction(connection) {
  const type = connection?.authType;
  if (type === "oauth" || type === "apikey") return "reconnect";
  if (type === "cookie" && connection.provider !== "iflow") return "reconnect";
  return "open";
}

/** Persisted account-wide billing lock, or null. Matches the backend: only reason "credit_exhausted" counts. */
export function billingLockOf(connection) {
  const lock = connection?.billingLock;
  return lock && typeof lock === "object" && lock.reason === "credit_exhausted" ? lock : null;
}

// lastProbeError is an allowlisted code, never raw provider text. Anything else reads as a generic failure.
const PROBE_ERROR_LABELS = {
  billing: "Still out of credit",
  auth: "Key was rejected",
  rate_limited: "Provider rate limit",
  server_error: "Provider error",
  timeout: "Probe timed out",
  network: "Network error",
  invalid_response: "Unexpected reply",
  probe_model_unavailable:
    "Probe model unavailable — replace the API key or re-enable the connection to clear the lock",
  unknown: "Probe failed",
};

export function probeErrorLabel(code) {
  if (code == null || code === "") return null;
  return typeof code === "string" && Object.hasOwn(PROBE_ERROR_LABELS, code)
    ? PROBE_ERROR_LABELS[code]
    : PROBE_ERROR_LABELS.unknown;
}

// Probe endpoint result -> short user feedback. Unknown results read as a failure.
const PROBE_FEEDBACK = {
  cleared: { variant: "ok", text: "Credit is back. Connection is active again." },
  still_locked: { variant: "warn", text: "Still out of credit." },
  error: { variant: "err", text: "Probe failed. Try again later." },
  in_flight: { variant: "info", text: "A probe is already running." },
  not_locked: { variant: "info", text: "No longer out of credit." },
  disabled: { variant: "err", text: "Enable this connection before probing it." },
  not_found: { variant: "err", text: "Connection no longer exists" },
};

export function billingProbeFeedback(result) {
  return (
    (typeof result === "string" && Object.hasOwn(PROBE_FEEDBACK, result)
      ? PROBE_FEEDBACK[result]
      : null) || PROBE_FEEDBACK.error
  );
}

// Probe variant -> notificationStore method name. Unknown variants fall back to info.
const NOTIFY_METHODS = { ok: "success", err: "error", warn: "warning", info: "info" };

export function probeNotifyMethod(variant) {
  return Object.hasOwn(NOTIFY_METHODS, variant) ? NOTIFY_METHODS[variant] : "info";
}

/**
 * Map a billing-probe HTTP response to a toast. `refetch` is always true: the
 * server owns lock state, so the row must reload whatever the outcome was.
 */
export function billingProbeOutcome(status, data) {
  const result = data?.result;
  if (result === "rate_limited" || status === 429) {
    const ms = Number(data?.retryAfterMs);
    const mins = Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 60000) : 0;
    const wait = mins >= 60 ? `${Math.ceil(mins / 60)}h` : `${mins}m`;
    return {
      variant: "warn",
      text: mins ? `Probed recently. Try again in ${wait}.` : "Probed recently. Try again later.",
      refetch: true,
    };
  }
  if (result === "disabled" || status === 409) return { ...PROBE_FEEDBACK.disabled, refetch: true };
  if (result === "not_found" || status === 404)
    return { ...PROBE_FEEDBACK.not_found, refetch: true };
  if (status >= 200 && status < 300) return { ...billingProbeFeedback(result), refetch: true };
  const error = typeof data?.error === "string" && data.error ? data.error : null;
  return { ...PROBE_FEEDBACK.error, text: error || PROBE_FEEDBACK.error.text, refetch: true };
}

function span(ms) {
  const mins = Math.max(0, Math.floor(ms / 60000));
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** Last/next probe copy for a billing lock. Bad or missing timestamps never render as NaN. */
export function probeTimes(lock, nowMs = Date.now()) {
  const last = lock?.lastProbeAt ? new Date(lock.lastProbeAt).getTime() : NaN;
  const next = lock?.nextProbeAt ? new Date(lock.nextProbeAt).getTime() : NaN;
  return {
    last: Number.isNaN(last) ? "Not probed yet" : `Last probe ${span(nowMs - last)} ago`,
    next: Number.isNaN(next)
      ? ""
      : next > nowMs
        ? `Next probe in ${span(next - nowMs)}`
        : "Next probe due",
  };
}

/** Pure connection assessment. Reason/action come from safe persisted fields, never raw error text. */
export function connectionHealth(connection, nowMs = Date.now()) {
  if (!connection || connection.isActive === false)
    return { status: "off", reason: "Disabled", action: "enable" };

  // Out of credit is account-wide and outlasts cooldowns, so it outranks them and
  // other errors. Disabled (above) still wins. Reported as "err": requests skip it
  // until credit returns, which keeps counts, filters and the shell badge unchanged.
  if (billingLockOf(connection))
    return {
      status: "err",
      state: "out_of_credit",
      reason: "Out of credit",
      action: "open",
      billingLock: billingLockOf(connection),
    };

  const until = cooldownUntil(connection, nowMs);
  const code = Number(connection.errorCode);
  const safeCode = Number.isInteger(code) && code >= 400 && code <= 599 ? String(code) : null;
  // Writer shapes only: testSingleConnection persists "active"/"error" plus an
  // exact lastError; routing failures persist "unavailable" with a modelLock_*
  // lock and errorCode. Background refresh failures only log. Values carried
  // only by manual PUT lastError can read, but the classifier must not require
  // any branch no writer emits.
  if (until) return { status: "warn", reason: "Cooling down", action: "open", until };
  if (connection.testStatus === "error") {
    const failure = CREDENTIAL_FAILURES.get(connection.lastError);
    if (failure) {
      const action = repairAction(connection);
      return {
        status: "err",
        reason: action === "reconnect" ? `${failure} · reconnect` : `${failure} · open provider`,
        action,
      };
    }
    return {
      status: "err",
      reason: safeCode ? `Test failed · ${safeCode}` : "Test failed",
      action: "test",
      code: safeCode,
    };
  }
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
  let outOfCreditCount = 0;
  for (const connection of connections || []) {
    const health = connectionHealth(connection, nowMs);
    counts[health.status] += 1;
    if (health.state === "out_of_credit") outOfCreditCount += 1;
    if (RANK[health.status] > RANK[worst.status]) worst = health;
  }
  const connected = counts.ok + counts.warn + counts.err > 0;
  // Counts and rank keep status "err" so the shell badge, filters and
  // attention counts treat a lock like any other error. outOfCredit only
  // relabels when every enabled error is a lock, so a mixed provider still
  // reads as "N Error". Disabled rows never count.
  return {
    ...worst,
    connected,
    needsAttention: counts.warn + counts.err > 0,
    outOfCredit: outOfCreditCount > 0 && outOfCreditCount === counts.err,
    outOfCreditCount,
    counts,
  };
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
