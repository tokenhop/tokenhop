/**
 * YAN-311 server-side validation for the Reliability section keys:
 * retryPolicy, cooldowns, backoff, streamTimeouts.
 *
 * Pure module (no imports): the settings PATCH route calls
 * `validateReliabilitySettings(body)` and returns its message as a 400.
 * Only keys present (own property) are checked; absent keys pass.
 * 429 is never configurable and is rejected when present.
 *
 * Bounds (justified):
 * - tries 0-10: 0 disables, 10 caps worst-case added latency per URL
 *   (10 × 60s delay would already stall a request for 10 minutes).
 * - delays 0-60000ms: 60s matches the connect-timeout ceiling; longer would
 *   look like a hang to CLI clients.
 * - cooldowns 1000ms-86400000ms (1s-24h): below 1s is a busy loop, above 24h
 *   locks accounts past any real upstream reset window.
 * - backoff start 100-60000ms, max 1000ms-3600000ms (1s-1h), levels 1-30:
 *   2^30 × start already overflows any sane cap, so maxMs clamps it.
 * - timeouts 1000ms-1800000ms (1s-30min): below 1s aborts healthy slow
 *   reasoning models; above 30min exceeds gateway/client patience.
 */

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Stored settings keys owned by the Reliability section. */
export const RELIABILITY_KEYS = ["retryPolicy", "cooldowns", "backoff", "streamTimeouts"];

/**
 * Merge a validated partial reliability object over the current stored value
 * (two levels deep: retryPolicy is status → { tries, delayMs }).
 * @param {object} current Current merged setting value.
 * @param {object} patch Validated partial object.
 * @returns {object} Complete object to store.
 */
export function mergeReliabilityPatch(current, patch) {
  const next = { ...(isPlainObject(current) ? current : {}) };
  for (const [key, value] of Object.entries(patch)) {
    next[key] = isPlainObject(value) ? { ...(next[key] || {}), ...value } : value;
  }
  return next;
}
const RETRY_STATUSES = new Set(["502", "503", "504"]);
const COOLDOWN_KEYS = new Set(["rateLimitCapMs", "longMs", "shortMs", "transientMs"]);
const BACKOFF_KEYS = new Set(["startMs", "maxMs", "levels"]);
const TIMEOUT_KEYS = new Set(["firstChunkMs", "stallMs", "connectMs"]);

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function intInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function validRetryPolicy(value) {
  if (!isPlainObject(value)) return false;
  for (const [status, entry] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(status)) return false;
    if (!RETRY_STATUSES.has(status)) return false;
    if (!isPlainObject(entry)) return false;
    for (const key of Object.keys(entry)) {
      if (UNSAFE_KEYS.has(key) || (key !== "tries" && key !== "delayMs")) return false;
    }
    if (Object.hasOwn(entry, "tries") && !intInRange(entry.tries, 0, 10)) return false;
    if (Object.hasOwn(entry, "delayMs") && !intInRange(entry.delayMs, 0, 60000)) return false;
  }
  return true;
}

function validCooldowns(value) {
  if (!isPlainObject(value)) return false;
  for (const [key, ms] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key) || !COOLDOWN_KEYS.has(key)) return false;
    if (!intInRange(ms, 1000, 86400000)) return false;
  }
  return true;
}

function validBackoff(value) {
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key) || !BACKOFF_KEYS.has(key)) return false;
  }
  if (Object.hasOwn(value, "startMs") && !intInRange(value.startMs, 100, 60000)) return false;
  if (Object.hasOwn(value, "maxMs") && !intInRange(value.maxMs, 1000, 3600000)) return false;
  if (Object.hasOwn(value, "levels") && !intInRange(value.levels, 1, 30)) return false;
  if (
    Object.hasOwn(value, "startMs") &&
    Object.hasOwn(value, "maxMs") &&
    value.maxMs < value.startMs
  ) {
    return false;
  }
  return true;
}

function backoffCrossCheck(body, stored) {
  const merged = { ...(isPlainObject(stored) ? stored : {}) };
  if (isPlainObject(body.backoff)) Object.assign(merged, body.backoff);
  return !(
    Object.hasOwn(merged, "startMs") &&
    Object.hasOwn(merged, "maxMs") &&
    merged.maxMs < merged.startMs
  );
}

function validStreamTimeouts(value) {
  if (!isPlainObject(value)) return false;
  for (const [key, ms] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key) || !TIMEOUT_KEYS.has(key)) return false;
    if (!intInRange(ms, 1000, 1800000)) return false;
  }
  return true;
}

/**
 * Validate YAN-311 reliability keys in a settings PATCH body.
 * @param {object} body JSON-parsed PATCH body.
 * @param {object} [stored] Current merged settings (for cross-leaf checks).
 * @returns {string | null} Error message, or null when valid.
 */
export function validateReliabilitySettings(body, stored = null) {
  if (!isPlainObject(body)) return null;
  for (const key of Object.keys(body)) {
    if (UNSAFE_KEYS.has(key)) return `Invalid setting "${key}"`;
  }
  if (Object.hasOwn(body, "retryPolicy") && !validRetryPolicy(body.retryPolicy)) {
    return "Invalid retryPolicy: statuses 502/503/504 with tries 0-10 and delayMs 0-60000";
  }
  if (Object.hasOwn(body, "cooldowns") && !validCooldowns(body.cooldowns)) {
    return "Invalid cooldowns: rateLimitCapMs/longMs/shortMs/transientMs between 1000 and 86400000";
  }
  if (Object.hasOwn(body, "backoff") && !validBackoff(body.backoff)) {
    return "Invalid backoff: startMs 100-60000, maxMs 1000-3600000 (>= startMs), levels 1-30";
  }
  if (Object.hasOwn(body, "backoff") && !backoffCrossCheck(body, stored?.backoff)) {
    return "Invalid backoff: maxMs must be >= startMs (including stored values)";
  }
  if (Object.hasOwn(body, "streamTimeouts") && !validStreamTimeouts(body.streamTimeouts)) {
    return "Invalid streamTimeouts: firstChunkMs/stallMs/connectMs between 1000 and 1800000";
  }
  return null;
}
