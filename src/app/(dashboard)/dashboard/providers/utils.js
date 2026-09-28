import { getErrorCode, getRelativeTime } from "@/shared/utils";
import { connectionHealth, cooldownUntil, providerHealth } from "@/shared/utils/providerHealth";

export const LIST_FILTERS = {
  ALL: "all",
  CONNECTED: "connected",
  NEEDS_ATTENTION: "needs-attention",
  OAUTH: "oauth",
  FREE: "free",
  APIKEY: "apikey",
};

export const PROVIDER_LIST_FILTERS = [
  { value: LIST_FILTERS.ALL, label: "All" },
  { value: LIST_FILTERS.CONNECTED, label: "Connected" },
  { value: LIST_FILTERS.NEEDS_ATTENTION, label: "Needs attention" },
  { value: LIST_FILTERS.OAUTH, label: "OAuth" },
  { value: LIST_FILTERS.FREE, label: "Free tier" },
  { value: LIST_FILTERS.APIKEY, label: "API key" },
];

// Backward compatibility with previous select options
export const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "none", label: "No connection" },
];

export function getConnectionStatus(stats, isNoAuth = false) {
  if (isNoAuth) return "active";
  if (!stats || stats.total === 0) return "none";
  return stats.allDisabled ? "inactive" : "active";
}

export function matchesStatusFilter(statusFilter, stats, isNoAuth = false) {
  if (statusFilter === "all") return true;
  return getConnectionStatus(stats, isNoAuth) === statusFilter;
}

export function getConnectionErrorTag(connection) {
  if (!connection) return null;

  const explicitType = connection.lastErrorType;
  if (explicitType === "runtime_error") return "RUNTIME";
  if (
    explicitType === "upstream_auth_error" ||
    explicitType === "auth_missing" ||
    explicitType === "token_refresh_failed" ||
    explicitType === "token_expired"
  )
    return "AUTH";
  if (explicitType === "upstream_rate_limited") return "429";
  if (explicitType === "upstream_unavailable") return "5XX";
  if (explicitType === "network_error") return "NET";

  const numericCode = Number(connection.errorCode);
  if (Number.isFinite(numericCode) && numericCode >= 400) return String(numericCode);

  const fromMessage = getErrorCode(connection.lastError);
  if (fromMessage === "401" || fromMessage === "403") return "AUTH";
  if (fromMessage && fromMessage !== "ERR") return fromMessage;

  const msg = (connection.lastError || "").toLowerCase();
  if (msg.includes("runtime") || msg.includes("not runnable") || msg.includes("not installed"))
    return "RUNTIME";
  if (
    msg.includes("invalid api key") ||
    msg.includes("token invalid") ||
    msg.includes("revoked") ||
    msg.includes("unauthorized") ||
    msg.includes("no access token") ||
    msg.includes("missing access token") ||
    msg.includes("auth") ||
    msg.includes("sign in") ||
    msg.includes("signin") ||
    msg.includes("expired")
  )
    return "AUTH";

  return "ERR";
}

export function getCooldownUntil(connection) {
  return cooldownUntil(connection);
}

export function getEffectiveStatus(connection) {
  const isCooldown = Boolean(getCooldownUntil(connection));
  return connection.testStatus === "unavailable" && !isCooldown
    ? "active"
    : connection.testStatus || "unknown";
}

export function getProviderStats(connections, providerId, authType) {
  const authTypes = Array.isArray(authType) ? authType : [authType];
  const providerConnections = connections.filter(
    (c) => c.provider === providerId && authTypes.includes(c.authType),
  );

  const health = providerHealth(providerConnections);
  const connected = health.counts.ok + health.counts.warn + health.counts.err;
  const errorConns = providerConnections.filter((c) =>
    ["err", "warn"].includes(connectionHealth(c).status),
  );

  const error = health.counts.err + health.counts.warn;
  const total = providerConnections.length;
  const allDisabled = total > 0 && health.counts.off === total;
  const hasCooldown = providerConnections.some(
    (c) => connectionHealth(c).reason === "Cooling down",
  );

  const latestError = errorConns.sort(
    (a, b) => new Date(b.lastErrorAt || 0) - new Date(a.lastErrorAt || 0),
  )[0];
  const errorCode = latestError ? getConnectionErrorTag(latestError) : null;
  const errorTime = latestError?.lastErrorAt ? getRelativeTime(latestError.lastErrorAt) : null;

  return { connected, error, total, errorCode, errorTime, allDisabled, hasCooldown };
}

export function getAccountSegments(providerConnections) {
  if (!providerConnections || providerConnections.length === 0) {
    return [{ value: 0, kind: "none", label: "No accounts" }];
  }
  return providerConnections.map((c, i) => {
    const label = c.name || c.email || `Account ${i + 1}`;
    const health = connectionHealth(c);
    if (health.status === "off") return { value: 0, kind: "none", label };
    if (health.status === "warn") return { value: 50, kind: "warn", label };
    if (health.status === "err") return { value: 100, kind: "err", label };
    return { value: 100, kind: "ok", label };
  });
}

/**
 * Pure URL-state helpers for the linkable ?provider=<id> panel.
 * Kept pure (no router) so they are unit-testable; the shell wires them
 * to router.push/replace and syncs state from searchParams on popstate.
 */
export function readSelectedProvider(searchParamsString) {
  const params = new URLSearchParams(searchParamsString || "");
  const provider = params.get("provider");
  return provider || null;
}

export function writeSelectedProvider(searchParamsString, providerId) {
  const params = new URLSearchParams(searchParamsString || "");
  if (providerId) params.set("provider", providerId);
  else params.delete("provider");
  const qs = params.toString();
  return qs ? `/dashboard/providers?${qs}` : "/dashboard/providers";
}

export function matchesProviderListFilter(
  filter,
  stats,
  isNoAuth = false,
  authGroup = null,
  entryHasCooldown = undefined,
) {
  if (filter === LIST_FILTERS.ALL) return true;
  if (filter === LIST_FILTERS.CONNECTED) return !isNoAuth && (stats?.connected || 0) > 0;
  if (filter === LIST_FILTERS.NEEDS_ATTENTION)
    return needsAttention(stats, isNoAuth, entryHasCooldown);
  if (filter === LIST_FILTERS.OAUTH) return authGroup === "oauth";
  if (filter === LIST_FILTERS.FREE) return authGroup === "free";
  if (filter === LIST_FILTERS.APIKEY) return authGroup === "apikey" || authGroup === "compatible";
  return true;
}

export function buildProviderListFilterCounts(entries) {
  const counts = {
    [LIST_FILTERS.ALL]: entries.length,
    [LIST_FILTERS.CONNECTED]: 0,
    [LIST_FILTERS.NEEDS_ATTENTION]: 0,
    [LIST_FILTERS.OAUTH]: 0,
    [LIST_FILTERS.FREE]: 0,
    [LIST_FILTERS.APIKEY]: 0,
  };

  for (const entry of entries) {
    const { stats, isNoAuth, authGroup } = entry;
    if (matchesProviderListFilter(LIST_FILTERS.CONNECTED, stats, isNoAuth)) {
      counts[LIST_FILTERS.CONNECTED] += 1;
    }
    if (
      matchesProviderListFilter(
        LIST_FILTERS.NEEDS_ATTENTION,
        stats,
        isNoAuth,
        authGroup,
        entry.hasCooldown,
      )
    )
      counts[LIST_FILTERS.NEEDS_ATTENTION] += 1;
    if (authGroup === "oauth") counts[LIST_FILTERS.OAUTH] += 1;
    else if (authGroup === "free") counts[LIST_FILTERS.FREE] += 1;
    else if (authGroup === "apikey" || authGroup === "compatible") counts[LIST_FILTERS.APIKEY] += 1;
  }

  return counts;
}

/** Shared providerHealth rule: stats.error counts err + warn (cooldown/pending) connections. */
export function needsAttention(stats, isNoAuth = false, entryHasCooldown = undefined) {
  if (isNoAuth) return false;
  return (stats?.error || 0) > 0 || (entryHasCooldown ?? stats?.hasCooldown) === true;
}

export function countNeedsAttention(entries) {
  return entries.filter((e) => needsAttention(e.stats, e.isNoAuth, e.hasCooldown)).length;
}

export function needsLookLabel(count) {
  return `${count} ${count === 1 ? "needs" : "need"} a look`;
}
