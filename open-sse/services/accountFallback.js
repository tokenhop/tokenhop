import {
  BILLING_LOCK_AUTH_TYPES,
  BILLING_LOCK_MESSAGES,
  BILLING_LOCK_REASON,
  BILLING_PROBE_CONFIG,
  BILLING_RULES,
  ERROR_RULES,
  UPSTREAM_CODE_MARKER,
} from "../config/errorConfig.js";
import { getActiveReliabilityPolicy, RELIABILITY_DEFAULTS } from "../config/reliabilityPolicy.js";
import REGISTRY from "../providers/registry/index.js";
import { resolveBillingProbeSpec } from "./billingProbeSpec.js";

/**
 * Calculate exponential backoff cooldown for rate limits (429)
 * Level 1: 1s, Level 2: 2s, Level 3: 4s... → max 4 min
 * @param {number} backoffLevel - Current backoff level
 * @param {object} [policy] - Resolved policy (defaults to the active policy)
 * @returns {number} Cooldown in milliseconds
 */
export function getQuotaCooldown(backoffLevel = 0, policy = null) {
  const backoff = (policy || getActiveReliabilityPolicy()).backoff;
  const level = Math.max(0, backoffLevel - 1);
  const cooldown = backoff.startMs * 2 ** level;
  return Math.min(cooldown, backoff.maxMs);
}

const CODE_MARKER_RE = new RegExp(`\\[${UPSTREAM_CODE_MARKER}([^\\]]*)\\]`, "g");

/** Structured upstream codes carried in the error text as `[code=a,b]`. */
function structuredCodes(lowerError) {
  const codes = [];
  for (const m of lowerError.matchAll(CODE_MARKER_RE)) codes.push(...m[1].split(","));
  return codes;
}

/**
 * YAN-1041: is this upstream failure a credit/spend exhaustion?
 * Provider-agnostic structured codes (429/402/403) plus the Anthropic-specific
 * 400 wording (gated to anthropic/claude) and a bare 402. Generic 400/403/429 are
 * never billing. The caller still requires an API-key connection to lock.
 * @param {number} status
 * @param {string} errorText
 * @param {string|null} [provider]
 */
export function isBillingExhausted(status, errorText, provider = null) {
  const st = Number(status);
  const lower = (
    typeof errorText === "string" ? errorText : JSON.stringify(errorText ?? "")
  ).toLowerCase();
  if (BILLING_RULES.excludedProviders.includes(provider)) return false;
  if (BILLING_RULES.statuses.includes(st)) return true;
  if (
    BILLING_RULES.codeStatuses.includes(st) &&
    structuredCodes(lower).some((c) => BILLING_RULES.codes.includes(c))
  )
    return true;
  const a = BILLING_RULES.anthropic;
  return (
    st === a.status &&
    (provider == null || a.providers.includes(provider)) &&
    a.texts.some((t) => lower.includes(t))
  );
}

/** First billing structured code in the error text, else null. */
function billingCode(lowerError) {
  return structuredCodes(lowerError).find((c) => BILLING_RULES.codes.includes(c)) ?? null;
}

/**
 * Fixed persisted lock message for a billing trigger — one of the
 * BILLING_LOCK_MESSAGES constants, chosen from the classification. Upstream
 * free text never reaches the lock, so no secret or PII can be persisted or
 * echoed back by the probe route.
 */
export function billingLockMessage(status, errorText) {
  if (Number(status) === 402) return BILLING_LOCK_MESSAGES.payment;
  const lower = (
    typeof errorText === "string" ? errorText : JSON.stringify(errorText ?? "")
  ).toLowerCase();
  if (/usage limit|spend_limit|usage_limit/.test(lower)) return BILLING_LOCK_MESSAGES.limit;
  return BILLING_LOCK_MESSAGES.credit;
}

/**
 * Probe spec for a provider id, or null when unsupported. Unsupported providers
 * are never billing-locked (no automatic recovery path would exist).
 */
export function getBillingProbeSpec(provider) {
  return resolveBillingProbeSpec(provider, REGISTRY);
}

/** Can this connection hold a billing lock? (API-key + probeable provider) */
export function canBillingLock(connection) {
  return (
    !!connection &&
    connection.isActive !== false &&
    BILLING_LOCK_AUTH_TYPES.includes(connection.authType) &&
    !!getBillingProbeSpec(connection.provider)
  );
}

/**
 * Active (set) billing lock on a connection record, else null. A lock is only
 * valid when its reason matches BILLING_LOCK_REASON (the single validity rule;
 * the UI mirrors it, nothing new is exported for it).
 */
export function getBillingLock(connection) {
  const lock = connection?.billingLock;
  return lock && typeof lock === "object" && lock.reason === BILLING_LOCK_REASON ? lock : null;
}

/** ISO time of the next re-probe: default interval with +/- jitter. */
export function nextBillingProbeAt(now = Date.now()) {
  const { intervalMs, jitterRatio } = BILLING_PROBE_CONFIG;
  const spread = jitterRatio * intervalMs;
  return new Date(now + intervalMs + Math.round((Math.random() * 2 - 1) * spread)).toISOString();
}

/**
 * Build the persisted billingLock. `generation` must come from the caller's
 * transactional floor (Math.max(nowMs, liveGeneration + 1)): a raw timestamp is
 * NOT inherently monotonic — same-millisecond re-locks would repeat a value and
 * let a stale probe match a newer lock.
 */
export function buildBillingLock(status, errorText, generation, now = Date.now()) {
  const lower = (
    typeof errorText === "string" ? errorText : JSON.stringify(errorText ?? "")
  ).toLowerCase();
  return {
    reason: BILLING_LOCK_REASON,
    code: billingCode(lower) ?? `http_${Number(status) || 0}`,
    message: billingLockMessage(status, errorText),
    lockedAt: new Date(now).toISOString(),
    nextProbeAt: nextBillingProbeAt(now),
    lastProbeAt: null,
    lastProbeError: null,
    generation,
  };
}

/**
 * Check if error should trigger account fallback (switch to next account)
 * Config-driven: matches ERROR_RULES top-to-bottom (text rules first, then status)
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message text
 * @param {number} backoffLevel - Current backoff level for exponential backoff
 * @param {object} [policy] - Resolved policy (defaults to the active policy)
 * @param {string|null} [provider] - Provider id when known (gates the Anthropic 400 wording)
 * @returns {{ shouldFallback: boolean, cooldownMs: number, newBackoffLevel?: number }}
 */
export function checkFallbackError(
  status,
  errorText,
  backoffLevel = 0,
  policy = null,
  provider = null,
) {
  const resolved = policy || getActiveReliabilityPolicy();
  const { backoff, cooldowns } = resolved;
  const lowerError = errorText
    ? (typeof errorText === "string" ? errorText : JSON.stringify(errorText)).toLowerCase()
    : "";

  // Policy-aware cooldowns for the fixed rules: text rules keep their shape
  // (backoff vs fixed), but fixed durations come from the resolved policy.
  // ERROR_RULES stays the semantic source of truth for classification; the
  // comparison is against RELIABILITY_DEFAULTS (frozen copies of today's
  // constants) so a configured policy can never shift the mapping itself.
  const ruleCooldown = (rule) => {
    if (rule.cooldownMs === RELIABILITY_DEFAULTS.cooldowns.rateLimitCapMs)
      return cooldowns.rateLimitCapMs;
    if (rule.cooldownMs === RELIABILITY_DEFAULTS.cooldowns.transientMs)
      return cooldowns.transientMs;
    if (rule.cooldownMs === RELIABILITY_DEFAULTS.cooldowns.longMs) return cooldowns.longMs;
    if (rule.cooldownMs === RELIABILITY_DEFAULTS.cooldowns.shortMs) return cooldowns.shortMs;
    return rule.cooldownMs;
  };

  // YAN-1041: a billing-exhausted 400 must fall back; it would otherwise hit the
  // unmatched-4xx early return below. The account-wide lock itself is applied by
  // markAccountUnavailable (it knows provider + authType); here only fall back.
  if (Number(status) === 400 && isBillingExhausted(status, lowerError, provider)) {
    return { shouldFallback: true, cooldownMs: cooldowns.longMs, billing: true };
  }

  for (const rule of ERROR_RULES) {
    // Text-based rule: match substring in error message
    if (rule.text && lowerError && lowerError.includes(rule.text)) {
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, backoff.levels);
        return {
          shouldFallback: true,
          cooldownMs: getQuotaCooldown(newLevel, resolved),
          newBackoffLevel: newLevel,
        };
      }
      return { shouldFallback: true, cooldownMs: ruleCooldown(rule) };
    }

    // Status-based rule: match HTTP status code
    if (rule.status && rule.status === status) {
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, backoff.levels);
        return {
          shouldFallback: true,
          cooldownMs: getQuotaCooldown(newLevel, resolved),
          newBackoffLevel: newLevel,
        };
      }
      return { shouldFallback: true, cooldownMs: ruleCooldown(rule) };
    }
  }

  // Request-scoped client errors that matched no rule above: a 400 caused by the
  // request itself (context overflow, malformed body, unsupported parameter) says
  // nothing about the credential, so cooling the account down only removes a
  // healthy connection from rotation. With a single connection it is worse: every
  // later request in the window fails with a copy of this very error
  // ("all 1 accounts locked for <model> | lastError=[400]: ..."), which hides the
  // real cause from the caller and makes unrelated sessions look like they hit the
  // same limit. Hand the upstream error back for this request instead.
  // Account-scoped statuses keep their rules above (401/402/403/404/429), and the
  // text rules still win for rate-limit / quota / capacity wording.
  if (
    status >= 400 &&
    status < 500 &&
    status !== 401 &&
    status !== 402 &&
    status !== 403 &&
    status !== 429
  ) {
    return { shouldFallback: false, cooldownMs: 0 };
  }

  // Default: transient cooldown for any unmatched error
  return { shouldFallback: true, cooldownMs: resolved.cooldowns.transientMs };
}

/**
 * Check if account is currently unavailable (cooldown not expired)
 */
export function isAccountUnavailable(unavailableUntil) {
  if (!unavailableUntil) return false;
  return new Date(unavailableUntil).getTime() > Date.now();
}

/**
 * Calculate unavailable until timestamp
 */
export function getUnavailableUntil(cooldownMs) {
  return new Date(Date.now() + cooldownMs).toISOString();
}

/**
 * Get the earliest rateLimitedUntil from a list of accounts
 * @param {Array} accounts - Array of account objects with rateLimitedUntil
 * @returns {string|null} Earliest rateLimitedUntil ISO string, or null
 */
export function getEarliestRateLimitedUntil(accounts) {
  let earliest = null;
  const now = Date.now();
  for (const acc of accounts) {
    if (!acc.rateLimitedUntil) continue;
    const until = new Date(acc.rateLimitedUntil).getTime();
    if (until <= now) continue;
    if (!earliest || until < earliest) earliest = until;
  }
  if (!earliest) return null;
  return new Date(earliest).toISOString();
}

/**
 * Format rateLimitedUntil to human-readable "reset after Xm Ys"
 * @param {string} rateLimitedUntil - ISO timestamp
 * @returns {string} e.g. "reset after 2m 30s"
 */
export function formatRetryAfter(rateLimitedUntil) {
  if (!rateLimitedUntil) return "";
  const diffMs = new Date(rateLimitedUntil).getTime() - Date.now();
  if (diffMs <= 0) return "reset after 0s";
  const totalSec = Math.ceil(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return `reset after ${parts.join(" ")}`;
}

/** Prefix for model lock flat fields on connection record */
export const MODEL_LOCK_PREFIX = "modelLock_";

/** Special key used when no model is known (account-level lock) */
export const MODEL_LOCK_ALL = `${MODEL_LOCK_PREFIX}__all`;

/** Build the flat field key for a model lock */
export function getModelLockKey(model) {
  return model ? `${MODEL_LOCK_PREFIX}${model}` : MODEL_LOCK_ALL;
}

/**
 * Check if a model lock on a connection is still active.
 * Reads flat field `modelLock_${model}` (or `modelLock___all` when model=null).
 */
export function isModelLockActive(connection, model) {
  const key = getModelLockKey(model);
  const now = Date.now();
  return [connection[key], connection[MODEL_LOCK_ALL]].some(
    (expiry) => expiry && new Date(expiry).getTime() > now,
  );
}

/**
 * Expiry of the lock that actually blocks `model` (later of its own lock and the
 * account-wide lock, active ones only). Null when not locked.
 */
export function getModelLockUntil(connection, model) {
  const now = Date.now();
  const active = [connection?.[getModelLockKey(model)], connection?.[MODEL_LOCK_ALL]]
    .filter((v) => v && new Date(v).getTime() > now)
    .map((v) => new Date(v).getTime());
  return active.length ? new Date(Math.max(...active)).toISOString() : null;
}

/**
 * Get earliest active model lock expiry across all modelLock_* fields.
 * Used for UI cooldown display.
 */
export function getEarliestModelLockUntil(connection) {
  if (!connection) return null;
  let earliest = null;
  const now = Date.now();
  for (const [key, val] of Object.entries(connection)) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !val) continue;
    const t = new Date(val).getTime();
    if (t <= now) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

/**
 * Build update object to set a model lock on a connection.
 */
export function buildModelLockUpdate(model, cooldownMs) {
  const key = getModelLockKey(model);
  return { [key]: new Date(Date.now() + cooldownMs).toISOString() };
}

/**
 * Build update object to clear all model locks on a connection.
 */
export function buildClearModelLocksUpdate(connection) {
  const cleared = {};
  for (const key of Object.keys(connection)) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) cleared[key] = null;
  }
  return cleared;
}

/**
 * Filter available accounts (not in cooldown)
 */
export function filterAvailableAccounts(accounts, excludeId = null) {
  const now = Date.now();
  return accounts.filter((acc) => {
    if (excludeId && acc.id === excludeId) return false;
    if (acc.rateLimitedUntil) {
      const until = new Date(acc.rateLimitedUntil).getTime();
      if (until > now) return false;
    }
    return true;
  });
}

/**
 * Reset account state when request succeeds
 * Clears cooldown and resets backoff level to 0
 * @param {object} account - Account object
 * @returns {object} Updated account with reset state
 */
export function resetAccountState(account) {
  if (!account) return account;
  return {
    ...account,
    rateLimitedUntil: null,
    backoffLevel: 0,
    lastError: null,
    status: "active",
  };
}

/**
 * Apply error state to account
 * @param {object} account - Account object
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message
 * @returns {object} Updated account with error state
 */
export function applyErrorState(account, status, errorText) {
  if (!account) return account;

  const backoffLevel = account.backoffLevel || 0;
  const { cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel);

  return {
    ...account,
    rateLimitedUntil: cooldownMs > 0 ? getUnavailableUntil(cooldownMs) : null,
    backoffLevel: newBackoffLevel ?? backoffLevel,
    lastError: { status, message: errorText, timestamp: new Date().toISOString() },
    status: "error",
  };
}
