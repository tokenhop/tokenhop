import {
  getRefreshLeadMs,
  isUnrecoverableRefreshError,
  refreshTokenByProvider,
} from "./tokenRefresh.js";
import { PROVIDER_OAUTH } from "../providers/index.js";
import {
  computeExpiresAt,
  getCredentialExpiryMs as getExpiryMs,
  getCredentialLastRefreshMs,
  getObservedLifetimeMs,
  getTokenLifetimeMs,
  isLifetimeAware,
  isWithinProactiveRefreshInterval,
  scaleMaxRefreshAgeMs,
  scaleRefreshLeadMs,
} from "./tokenLifetime.js";

export { getCredentialLastRefreshMs };

// Single source: codex.oauth.maxRefreshAgeMs (8 days) — proactive refresh window
export const CODEX_MAX_REFRESH_AGE_MS = PROVIDER_OAUTH["codex"]?.maxRefreshAgeMs;

const refreshLocks = new Map();

function toExpiresAt(expiresIn, nowMs = Date.now()) {
  if (!expiresIn) return null;
  return new Date(nowMs + expiresIn * 1000).toISOString();
}

/** Stored expiry; for lifetime-aware providers (codex) also capped by the access token's JWT exp. */
export function getCredentialExpiryMs(credentials, provider) {
  return getExpiryMs(credentials, provider);
}

export function isCodexRefreshStale(
  credentials,
  nowMs = Date.now(),
  maxAgeMs = CODEX_MAX_REFRESH_AGE_MS,
) {
  const lastRefreshMs = getCredentialLastRefreshMs(credentials);
  return !lastRefreshMs || nowMs - lastRefreshMs >= maxAgeMs;
}

/**
 * Lifetime facts for a lifetime-aware provider (codex), or null for the rest.
 * Everything else keeps its declared lead / max age untouched.
 * `expiresAtMs` is also capped by lastRefreshAt + observedLifetime (YAN-1035):
 * with a learned lifetime L, the lead L/2 then refreshes at half of L.
 */
function describeLifetime(provider, credentials, nowMs) {
  if (!isLifetimeAware(provider)) return null;
  const lastRefreshMs = getCredentialLastRefreshMs(credentials);
  const storedExpiryMs = getCredentialExpiryMs(credentials, provider);
  const observedLifetimeMs = getObservedLifetimeMs(credentials.providerSpecificData, nowMs);
  let expiresAtMs = storedExpiryMs;
  if (observedLifetimeMs && lastRefreshMs != null) {
    const learnedExpiry = lastRefreshMs + observedLifetimeMs;
    expiresAtMs = expiresAtMs === null ? learnedExpiry : Math.min(expiresAtMs, learnedExpiry);
  }
  return {
    expiresAtMs,
    lastRefreshMs,
    lifetimeMs: getTokenLifetimeMs({
      accessToken: credentials.accessToken,
      expiresAtMs: storedExpiryMs,
      lastRefreshMs,
    }),
    observedLifetimeMs,
  };
}

/**
 * Lead (ms before expiry) at which a credential is refreshed proactively.
 * Lifetime-aware providers: min(declared lead, 50% of the token lifetime,
 * observedLifetime / 2), floored at 5 min. Others: the declared lead.
 */
export function getEffectiveRefreshLeadMs(provider, credentials, nowMs = Date.now()) {
  const declaredLeadMs = getRefreshLeadMs(provider);
  const facts = credentials ? describeLifetime(provider, credentials, nowMs) : null;
  if (!facts) return declaredLeadMs;
  return scaleRefreshLeadMs({ declaredLeadMs, ...facts });
}

/** Expiry used for scheduling: stored/JWT expiry, capped by a learned lifetime. */
export function getSchedulingExpiryMs(provider, credentials, nowMs = Date.now()) {
  const facts = credentials ? describeLifetime(provider, credentials, nowMs) : null;
  return facts ? facts.expiresAtMs : getCredentialExpiryMs(credentials, provider);
}

/** True when a lifetime-aware connection was refreshed less than 5 min ago and its token is still live. */
export function isProactiveRefreshThrottled(provider, credentials, nowMs = Date.now()) {
  if (!credentials || !isLifetimeAware(provider)) return false;
  const expiresAtMs = getCredentialExpiryMs(credentials, provider);
  if (expiresAtMs !== null && expiresAtMs <= nowMs) return false;
  return isWithinProactiveRefreshInterval(getCredentialLastRefreshMs(credentials), nowMs);
}

export function shouldRefreshCredentials(provider, credentials, nowMs = Date.now()) {
  if (!credentials) return false;
  if (isProactiveRefreshThrottled(provider, credentials, nowMs)) return false;
  // Access-token imports (no refresh token) now carry a JWT-derived expiry; there is nothing to refresh.
  if (isLifetimeAware(provider) && !credentials.refreshToken) return false;

  const expiresAtMs = getSchedulingExpiryMs(provider, credentials, nowMs);
  if (
    expiresAtMs !== null &&
    expiresAtMs - nowMs < getEffectiveRefreshLeadMs(provider, credentials, nowMs)
  ) {
    return true;
  }

  // Proactive stale refresh for providers declaring oauth.maxRefreshAgeMs (e.g. codex)
  const declaredMaxAgeMs = PROVIDER_OAUTH[provider]?.maxRefreshAgeMs;
  if (declaredMaxAgeMs && credentials.refreshToken) {
    const facts = describeLifetime(provider, credentials, nowMs);
    const maxAgeMs = facts
      ? scaleMaxRefreshAgeMs({ declaredMaxAgeMs, lifetimeMs: facts.lifetimeMs })
      : declaredMaxAgeMs;
    if (isCodexRefreshStale(credentials, nowMs, maxAgeMs)) return true;
  }

  return false;
}

export function mergeProviderSpecificData(existing, next) {
  if (!next || typeof next !== "object") return existing;
  return {
    ...(existing || {}),
    ...next,
  };
}

export function mergeRefreshedCredentials(
  provider,
  currentCredentials,
  refreshedCredentials,
  nowMs = Date.now(),
) {
  if (!refreshedCredentials) return null;
  if (isUnrecoverableRefreshError(refreshedCredentials)) return refreshedCredentials;

  const next = {};
  const nowIso = new Date(nowMs).toISOString();

  if (refreshedCredentials.accessToken) next.accessToken = refreshedCredentials.accessToken;
  if (refreshedCredentials.apiKey) next.apiKey = refreshedCredentials.apiKey;
  if (refreshedCredentials.token) next.token = refreshedCredentials.token;

  const refreshToken = refreshedCredentials.refreshToken ?? currentCredentials?.refreshToken;
  if (refreshToken) next.refreshToken = refreshToken;

  const idToken = refreshedCredentials.idToken ?? currentCredentials?.idToken;
  if (idToken) next.idToken = idToken;

  if (isLifetimeAware(provider)) {
    // YAN-1033: expires_in alone overstates the lifetime; the JWT exp wins when earlier.
    // expiresIn is re-derived from the clamped expiresAt: several persistence sites
    // (usage/test/translator routes) recompute `now + expiresIn`.
    const expiresAt = computeExpiresAt({
      expiresIn: refreshedCredentials.expiresIn,
      expiresAt: refreshedCredentials.expiresAt,
      accessToken: refreshedCredentials.accessToken,
      nowMs,
    });
    if (expiresAt) {
      next.expiresAt = expiresAt;
      next.expiresIn = Math.max(1, Math.floor((new Date(expiresAt).getTime() - nowMs) / 1000));
    }
  } else if (refreshedCredentials.expiresIn) {
    next.expiresIn = refreshedCredentials.expiresIn;
    next.expiresAt = toExpiresAt(refreshedCredentials.expiresIn, nowMs);
  } else if (refreshedCredentials.expiresAt) {
    next.expiresAt = refreshedCredentials.expiresAt;
  }

  if (refreshedCredentials.projectId) next.projectId = refreshedCredentials.projectId;

  if (refreshedCredentials.providerSpecificData) {
    next.providerSpecificData = mergeProviderSpecificData(
      currentCredentials?.providerSpecificData,
      refreshedCredentials.providerSpecificData,
    );
  }

  // YAN-1035: the learned lifetime (providerSpecificData.observedLifetimeMs) is never
  // cleared here. Token age alone cannot disprove it (an idle account's proactive
  // refresh can come long after the token died). It is replaced by a newer
  // observation and ignored after OBSERVED_LIFETIME_TTL_MS (tokenLifetime.js).

  if (refreshedCredentials.copilotToken) next.copilotToken = refreshedCredentials.copilotToken;
  if (refreshedCredentials.copilotTokenExpiresAt) {
    next.copilotTokenExpiresAt = refreshedCredentials.copilotTokenExpiresAt;
  }

  // trackRefreshAt providers (e.g. codex) always stamp lastRefreshAt for staleness tracking
  if (
    PROVIDER_OAUTH[provider]?.trackRefreshAt ||
    next.accessToken ||
    next.apiKey ||
    next.token ||
    next.refreshToken ||
    next.copilotToken
  ) {
    next.lastRefreshAt = refreshedCredentials.lastRefreshAt || nowIso;
  }

  return next;
}

function getRefreshLockKey(provider, credentials) {
  const stableId =
    credentials?.connectionId ||
    credentials?.id ||
    credentials?.email ||
    credentials?.name ||
    credentials?.refreshToken?.slice?.(-16) ||
    "default";
  return `${provider}:${stableId}`;
}

export async function withCredentialRefreshLock(provider, credentials, refreshFn) {
  const key = getRefreshLockKey(provider, credentials);
  const existing = refreshLocks.get(key);
  if (existing) return existing;

  const pending = Promise.resolve()
    .then(refreshFn)
    .finally(() => {
      refreshLocks.delete(key);
    });

  refreshLocks.set(key, pending);
  return pending;
}

export async function refreshProviderCredentials(provider, credentials, log, proxyOptions = null) {
  if (!credentials) return null;

  return withCredentialRefreshLock(provider, credentials, async () => {
    const refreshed = await refreshTokenByProvider(provider, credentials, log, proxyOptions);
    return mergeRefreshedCredentials(provider, credentials, refreshed);
  });
}
