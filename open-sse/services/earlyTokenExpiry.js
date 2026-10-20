// YAN-1035: learn a connection's real access-token lifetime from an early
// `token_expired` 401 (the token is dead although our stored expiry says it is
// not). Leaf module: imported by handlers/chatCore.js, which must not pull in
// the refresh engine.
import {
  MIN_OBSERVED_LIFETIME_MS,
  getCredentialExpiryMs,
  getCredentialLastRefreshMs,
  getJwtTimesMs,
  isLifetimeAware,
} from "./tokenLifetime.js";

const TOKEN_EXPIRED_CODE = "token_expired";
const TOKEN_EXPIRED_MESSAGE = "your authentication token has expired";

/**
 * When the current access token was issued: its JWT `iat` when usable, else the
 * stored lastRefreshAt. `iat` stays right for imports, which stamp lastRefreshAt
 * with the import time rather than the token's age.
 */
function getTokenIssuedMs(credentials, nowMs) {
  const { iatMs } = getJwtTimesMs(credentials?.accessToken);
  if (iatMs !== null && iatMs <= nowMs) return iatMs;
  return getCredentialLastRefreshMs(credentials);
}

/** True when an upstream 401 body says the access token expired. */
export function isTokenExpiredBody(text) {
  if (typeof text !== "string" || !text) return false;
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  const err = json?.error;
  const code = typeof err === "string" ? err : (err?.code ?? json?.code);
  if (code === TOKEN_EXPIRED_CODE) return true;
  const message = err?.message ?? json?.message ?? (json ? "" : text);
  return typeof message === "string" && message.toLowerCase().includes(TOKEN_EXPIRED_MESSAGE);
}

/**
 * Read a 401 response (via clone, so the caller can still consume it) and
 * snapshot what is needed to judge it after the refresh overwrites the
 * credentials. Null when not applicable (other status/provider) or unreadable.
 */
export async function probeEarlyTokenExpiry({
  provider,
  credentials,
  response,
  nowMs = Date.now(),
}) {
  if (response?.status !== 401 || !isLifetimeAware(provider)) return null;
  let text = "";
  try {
    text = await response.clone().text();
  } catch {
    return null;
  }
  if (!isTokenExpiredBody(text)) return null;
  return {
    storedExpiryMs: getCredentialExpiryMs(credentials, provider),
    lastRefreshMs: getTokenIssuedMs(credentials, nowMs),
    nowMs,
  };
}

/**
 * providerSpecificData delta to persist after the refresh succeeded, or null.
 * Recorded only when the stored expiry was still in the future (so the token
 * died early; an expired or revoked token teaches nothing) and the token age
 * now - lastRefreshAt is at least MIN_OBSERVED_LIFETIME_MS (15 min); anything
 * shorter is treated as unknown. A real refresh stamp is not cheaply
 * distinguishable from an imported one (bulk import stamps lastRefreshAt = now),
 * so that minimum is the guard. A newer observation replaces the old one (up or
 * down), and the record is ignored after OBSERVED_LIFETIME_TTL_MS.
 */
export function buildObservedLifetimePatch(probe) {
  if (!probe) return null;
  const { storedExpiryMs, lastRefreshMs, nowMs } = probe;
  if (storedExpiryMs == null || storedExpiryMs <= nowMs) return null;
  if (lastRefreshMs == null || nowMs - lastRefreshMs < MIN_OBSERVED_LIFETIME_MS) return null;
  return {
    observedLifetimeMs: nowMs - lastRefreshMs,
    observedLifetimeAt: new Date(nowMs).toISOString(),
  };
}
