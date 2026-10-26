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

// formatProviderError wraps upstream bodies as "[401]: {raw body}"; strip the
// prefix before JSON.parse so classifiers see the structured payload.
const STATUS_PREFIX = /^\[\d{3}\]:\s*/;

// "token_revoked" is a code; "Token was revoked" is a sentence.
const isCodeLike = (v) => /^[a-z0-9_.-]+$/i.test(v);

/** Parse a 401 body that may carry the "[status]: " wrapper. Returns JSON or null. */
export function parseErrorBody(text) {
  if (typeof text !== "string" || !text) return null;
  const stripped = STATUS_PREFIX.test(text) ? text.replace(STATUS_PREFIX, "") : text;
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

// YAN-1288: structured codes that conclusively mean the access token was
// rejected (revoked/invalidated), not merely expired. Allowlist: raw upstream
// text is never persisted.
const REJECTION_CODES = new Set([
  "token_invalidated",
  "token_revoked",
  "invalid_token",
  "invalid_api_key",
  "account_deactivated",
]);
const REJECTION_MESSAGES = ["invalidated", "revoked", "invalid token", "incorrect api key"];

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
  const json = parseErrorBody(text);
  const err = json?.error;
  const code = typeof err === "string" ? err : (err?.code ?? json?.code);
  if (code === TOKEN_EXPIRED_CODE) return true;
  const message = err?.message ?? json?.message ?? (json ? "" : text);
  return typeof message === "string" && message.toLowerCase().includes(TOKEN_EXPIRED_MESSAGE);
}

/**
 * YAN-1288: classify a 401 body as a conclusive access-token rejection.
 * A structured code (`error.code`, a string `error`, `code`, `detail.code`)
 * flags only when it is in the REJECTION_CODES allowlist and is returned as
 * is. A string `error` that is not a code is treated as a message. Message
 * wording (`error.message`, `message`, `detail`, `detail.message`) returns
 * "unknown". Any other structured code is inconclusive → null, so an
 * unrecognized 401 keeps today's short lock and is never flagged. Wording is
 * only ever scanned in message fields of a parsed body, never the raw JSON.
 */
export function classifyAccessTokenRejection(text) {
  const json = parseErrorBody(text);
  const err = json?.error;
  const detail = json?.detail;
  const str = (v) => (typeof v === "string" && v ? v : null);

  const stringError = str(err);
  const code =
    (stringError && isCodeLike(stringError) ? stringError : null) ??
    str(err?.code) ??
    str(json?.code) ??
    str(detail?.code);
  if (code) {
    if (code === TOKEN_EXPIRED_CODE) return null;
    return REJECTION_CODES.has(code) ? code : null;
  }

  const messages = [
    stringError,
    str(err?.message),
    str(json?.message),
    str(detail),
    str(detail?.message),
  ];
  // Non-JSON text: the whole string is the message.
  if (!json && typeof text === "string" && text) messages.push(text);
  for (const m of messages) {
    if (!m) continue;
    const lower = m.toLowerCase();
    if (REJECTION_MESSAGES.some((w) => lower.includes(w))) return "unknown";
  }
  return null;
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
