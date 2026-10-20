// Token-lifetime helpers (YAN-1033/1034/1035). Pure and dependency-light on
// purpose: no import of tokenRefresh.js, so handlers and src/ routes can use it
// without pulling the refresh engine in.
//
// Only providers whose registry `oauth.lifetimeAware` is true (codex) opt in:
// the upstream `expires_in` lies for them, so we trust the access token's JWT
// `exp`/`iat`, scale the refresh lead to the real lifetime and rate-limit
// proactive refreshes. Every other provider keeps its declared behaviour.
import { PROVIDER_OAUTH } from "../providers/index.js";
import { decodeJwtPayload } from "../utils/jwt.js";

/** Floor for any refresh lead (also tokenRefresh.TOKEN_EXPIRY_BUFFER_MS). */
export const MIN_REFRESH_LEAD_MS = 5 * 60 * 1000;
/**
 * Refresh once this fraction of the lifetime remains (capped at the declared
 * lead). 50% keeps today's behaviour for the real 10-day Codex token (5-day
 * declared lead = half of 10 days) and gives a 1h token a 30 min lead.
 */
export const REFRESH_LEAD_LIFETIME_FRACTION = 0.5;
/** The age-based fallback fires once the token is this fraction through its lifetime. */
export const MAX_REFRESH_AGE_LIFETIME_FRACTION = 0.8;
/** Minimum gap between two proactive refreshes of one connection (reactive 401 refresh ignores it). */
export const MIN_PROACTIVE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** A learned lifetime (YAN-1035) is re-learned after this long, so it can recover upwards. */
export const OBSERVED_LIFETIME_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * An early `token_expired` seen sooner than this after lastRefreshAt is treated as
 * unknown, not recorded: it is more likely a stale/foreign lastRefreshAt (e.g. a bulk
 * import stamps lastRefreshAt = now) than a real lifetime, and recording it would make
 * a connection refresh every few minutes for the whole TTL.
 */
export const MIN_OBSERVED_LIFETIME_MS = 15 * 60 * 1000;

export function isLifetimeAware(provider) {
  return PROVIDER_OAUTH[provider]?.lifetimeAware === true;
}

export function parseTimeMs(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? (value < 1e12 ? value * 1000 : value) : null;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/** `{ expMs, iatMs }` from an access token JWT; each null when absent or not a JWT. */
export function getJwtTimesMs(token) {
  const payload = typeof token === "string" ? decodeJwtPayload(token) : null;
  const toMs = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v * 1000 : null);
  return { expMs: toMs(payload?.exp), iatMs: toMs(payload?.iat) };
}

/**
 * ISO expiry = the earliest of now + expiresIn (seconds), an explicit expiresAt,
 * and the access token's JWT `exp`. Null when none of them is known.
 */
export function computeExpiresAt({ expiresIn, expiresAt, accessToken, nowMs = Date.now() } = {}) {
  const candidates = [];
  const seconds = Number(expiresIn);
  if (Number.isFinite(seconds) && seconds > 0) candidates.push(nowMs + seconds * 1000);
  const explicit = parseTimeMs(expiresAt);
  if (explicit !== null) candidates.push(explicit);
  const { expMs } = getJwtTimesMs(accessToken);
  if (expMs !== null) candidates.push(expMs);
  return candidates.length ? new Date(Math.min(...candidates)).toISOString() : null;
}

/**
 * `expires_in` (seconds) clamped to the access token's JWT exp. Returned as
 * seconds so every persistence site that recomputes `now + expiresIn` stays correct.
 */
export function clampExpiresInSeconds(expiresIn, accessToken, nowMs = Date.now()) {
  const seconds = Number(expiresIn);
  const { expMs } = getJwtTimesMs(accessToken);
  if (expMs === null) return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  const untilExp = Math.max(1, Math.floor((expMs - nowMs) / 1000));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, untilExp) : untilExp;
}

export function getCredentialExpiryMs(credentials, provider) {
  const stored = parseTimeMs(credentials?.expiresAt ?? credentials?.tokenExpiresAt);
  if (!isLifetimeAware(provider)) return stored;
  // The JWT exp is authoritative for lifetime-aware providers: it also covers
  // legacy rows with no expiresAt or a stale `now + expires_in` one.
  const { expMs } = getJwtTimesMs(credentials?.accessToken);
  if (expMs === null) return stored;
  return stored === null ? expMs : Math.min(stored, expMs);
}

export function getCredentialLastRefreshMs(credentials) {
  return parseTimeMs(
    credentials?.lastRefreshAt ??
      credentials?.lastRefresh ??
      credentials?.providerSpecificData?.lastRefreshAt,
  );
}

/** Full lifetime of the current access token: JWT exp - iat, else expiresAt - lastRefreshAt. */
export function getTokenLifetimeMs({ accessToken, expiresAtMs, lastRefreshMs } = {}) {
  const { expMs, iatMs } = getJwtTimesMs(accessToken);
  if (expMs !== null && iatMs !== null && expMs > iatMs) return expMs - iatMs;
  if (expiresAtMs != null && lastRefreshMs != null && expiresAtMs > lastRefreshMs) {
    return expiresAtMs - lastRefreshMs;
  }
  return null;
}

/** Lifetime learned from an early `token_expired` 401, if recorded and still fresh. */
export function getObservedLifetimeMs(providerSpecificData, nowMs = Date.now()) {
  const observed = Number(providerSpecificData?.observedLifetimeMs);
  if (!Number.isFinite(observed) || observed <= 0) return null;
  const at = parseTimeMs(providerSpecificData?.observedLifetimeAt);
  if (at !== null && nowMs - at > OBSERVED_LIFETIME_TTL_MS) return null;
  return observed;
}

/**
 * Refresh lead for one token:
 *   min(declaredLead, 50% of lifetime, observedLifetime / 2), floored at 5 min.
 * Unknown lifetime and no observation => the declared lead (today's behaviour).
 */
export function scaleRefreshLeadMs({ declaredLeadMs, lifetimeMs, observedLifetimeMs }) {
  let lead = declaredLeadMs;
  if (lifetimeMs > 0) lead = Math.min(lead, lifetimeMs * REFRESH_LEAD_LIFETIME_FRACTION);
  if (observedLifetimeMs > 0) lead = Math.min(lead, observedLifetimeMs / 2);
  return Math.max(lead, Math.min(MIN_REFRESH_LEAD_MS, declaredLeadMs));
}

/**
 * Age after which a token is refreshed regardless of expiresAt:
 *   min(declaredMaxAge, 80% of its lifetime), floored at 5 min.
 * Unknown lifetime => the declared max age.
 */
export function scaleMaxRefreshAgeMs({ declaredMaxAgeMs, lifetimeMs }) {
  if (!(lifetimeMs > 0)) return declaredMaxAgeMs;
  const scaled = lifetimeMs * MAX_REFRESH_AGE_LIFETIME_FRACTION;
  return Math.max(
    Math.min(declaredMaxAgeMs, scaled),
    Math.min(MIN_REFRESH_LEAD_MS, declaredMaxAgeMs),
  );
}

/** True when the last refresh was under MIN_PROACTIVE_REFRESH_INTERVAL_MS ago. */
export function isWithinProactiveRefreshInterval(lastRefreshMs, nowMs = Date.now()) {
  if (lastRefreshMs == null) return false;
  const age = nowMs - lastRefreshMs;
  return age >= 0 && age < MIN_PROACTIVE_REFRESH_INTERVAL_MS;
}
