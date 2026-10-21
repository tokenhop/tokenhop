// YAN-1037/1038: pure helpers for the `reauthRequired` connection state.
// No I/O. Server engine side; the dashboard uses config/reauthConstants.js only.
import {
  REAUTH_CODES,
  REAUTH_ERROR_TYPE,
  REAUTH_LAST_ERROR,
  REAUTH_REASONS,
} from "../config/reauthConstants.js";
import { getCredentialExpiryMs, isLifetimeAware } from "./tokenLifetime.js";

const REASONS = new Set(Object.values(REAUTH_REASONS));

function coerceCode(code) {
  return REAUTH_CODES.includes(code) ? code : "unknown";
}

/** Validated reauthRequired object or null (malformed/legacy values are ignored, like getBillingLock). */
export function getReauthRequired(connection) {
  const flag = connection?.reauthRequired;
  if (!flag || typeof flag !== "object" || !REASONS.has(flag.reason)) return null;
  return { reason: flag.reason, code: coerceCode(flag.code), at: flag.at };
}

/** Build the persisted object; code is coerced to REAUTH_CODES ("unknown" otherwise). */
export function buildReauthRequired({ reason, code, nowMs = Date.now() } = {}) {
  return { reason, code: coerceCode(code), at: new Date(nowMs).toISOString() };
}

/** Lifetime-aware provider (codex), no refreshToken, has accessToken, known expiry <= now. Pure. */
export function isAccessTokenOnlyExpired(provider, credentials, nowMs = Date.now()) {
  if (!credentials || !isLifetimeAware(provider)) return false;
  if (credentials.refreshToken || !credentials.accessToken) return false;
  const expiryMs = getCredentialExpiryMs(credentials, provider);
  return expiryMs !== null && expiryMs <= nowMs;
}

/** Used by account selection: flagged, or an access-token-only row that already expired. */
export function needsReauthentication(provider, connection, nowMs = Date.now()) {
  return Boolean(
    getReauthRequired(connection) || isAccessTokenOnlyExpired(provider, connection, nowMs),
  );
}

/** Patch written when a connection is flagged. */
export function buildReauthPatch(reauthRequired, nowMs = Date.now()) {
  return {
    reauthRequired,
    testStatus: "error",
    lastError: REAUTH_LAST_ERROR[reauthRequired.reason],
    lastErrorType: REAUTH_ERROR_TYPE[reauthRequired.reason],
    lastErrorAt: new Date(nowMs).toISOString(),
    errorCode: 401,
  };
}
