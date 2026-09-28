// YAN-311: resolved reliability policy. Source order: built-in defaults
// (identical to today's hardcoded constants) < injected overrides (from
// 9router settings via src/) < env vars (stream timeouts only).
// open-sse never imports src/: overrides arrive as a plain argument.

const STATUS_KEYS = [502, 503, 504];

function envMs(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/**
 * Built-in defaults — MUST equal today's hardcoded values:
 * retryPolicy: open-sse/config/runtimeConfig.js DEFAULT_RETRY_CONFIG
 * cooldowns: open-sse/config/errorConfig.js (MAX_RATE_LIMIT_COOLDOWN_MS,
 *   COOLDOWN long/short, TRANSIENT_COOLDOWN_MS)
 * backoff: errorConfig.js BACKOFF_CONFIG
 * streamTimeouts: runtimeConfig.js env defaults (200s/360s/60s)
 */
export const RELIABILITY_DEFAULTS = {
  retryPolicy: {
    502: { tries: 3, delayMs: 3000 },
    503: { tries: 3, delayMs: 2000 },
    504: { tries: 2, delayMs: 3000 },
  },
  cooldowns: {
    rateLimitCapMs: 30 * 60 * 1000,
    longMs: 2 * 60 * 1000,
    shortMs: 5 * 1000,
    transientMs: 30 * 1000,
  },
  backoff: { startMs: 2000, maxMs: 5 * 60 * 1000, levels: 15 },
  streamTimeouts: {
    firstChunkMs: 200 * 1000,
    stallMs: 360 * 1000,
    connectMs: 60 * 1000,
  },
};

function numOrFallback(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Resolve the effective reliability policy.
 * @param {object} [overrides] Injected stored settings ({ retryPolicy, cooldowns, backoff, streamTimeouts }).
 * @returns {object} Resolved { retryPolicy, cooldowns, backoff, streamTimeouts }.
 */
export function getReliabilityPolicy(overrides = {}) {
  const stored = overrides && typeof overrides === "object" ? overrides : {};
  const retryPolicy = {};
  for (const status of STATUS_KEYS) {
    const def = RELIABILITY_DEFAULTS.retryPolicy[status];
    const entry = stored.retryPolicy?.[status];
    retryPolicy[status] =
      entry && typeof entry === "object"
        ? {
            tries: numOrFallback(entry.tries, def.tries),
            delayMs: numOrFallback(entry.delayMs, def.delayMs),
          }
        : { ...def };
  }
  const cooldowns = {};
  for (const [key, def] of Object.entries(RELIABILITY_DEFAULTS.cooldowns)) {
    cooldowns[key] = numOrFallback(stored.cooldowns?.[key], def);
  }
  const backoff = {};
  for (const [key, def] of Object.entries(RELIABILITY_DEFAULTS.backoff)) {
    backoff[key] = numOrFallback(stored.backoff?.[key], def);
  }
  const storedTimeouts =
    stored.streamTimeouts && typeof stored.streamTimeouts === "object" ? stored.streamTimeouts : {};
  // Only known leaves survive: raw DB JSON / injected objects bypass PATCH
  // validation on the read path, so junk keys never reach consumers.
  const streamTimeouts = {};
  for (const [key, def] of Object.entries(RELIABILITY_DEFAULTS.streamTimeouts)) {
    streamTimeouts[key] = numOrFallback(storedTimeouts[key], def);
  }
  streamTimeouts.firstChunkMs = envMs("STREAM_FIRST_CHUNK_TIMEOUT_MS", streamTimeouts.firstChunkMs);
  streamTimeouts.stallMs = envMs("STREAM_STALL_TIMEOUT_MS", streamTimeouts.stallMs);
  streamTimeouts.connectMs = envMs("FETCH_CONNECT_TIMEOUT_MS", streamTimeouts.connectMs);
  return { retryPolicy, cooldowns, backoff, streamTimeouts };
}

/**
 * Resolve a retry entry to executor shape { attempts, delayMs }.
 * 429 never retries (not configurable): always { attempts: 0, delayMs: 0 }.
 * @param {object} policy Resolved policy from getReliabilityPolicy().
 * @param {number} status HTTP status code.
 */
export function resolveRetryForStatus(policy, status) {
  if (Number(status) === 429) return { attempts: 0, delayMs: 0 };
  const entry = policy?.retryPolicy?.[status];
  if (!entry) return { attempts: 0, delayMs: 0 };
  const attempts = numOrFallback(entry.tries ?? entry.attempts, 0);
  const delayMs = numOrFallback(entry.delayMs, 0);
  return { attempts: Math.max(0, attempts), delayMs: Math.max(0, delayMs) };
}

// Injected stored overrides (from 9router settings via src/). Module-level so
// every consumer reads the resolved policy at use time — no stale copies, no
// constructor signature changes. Standalone open-sse: never set, defaults win.
let injectedOverrides = null;

/**
 * Inject stored reliability overrides (src/ → open-sse bridge).
 * @param {object|null} overrides Stored settings slice or null to clear.
 */
export function setReliabilityOverrides(overrides) {
  injectedOverrides = overrides && typeof overrides === "object" ? overrides : null;
}

/**
 * Resolve the active policy: defaults < injected overrides < env.
 * @returns {object} Resolved { retryPolicy, cooldowns, backoff, streamTimeouts }.
 */
export function getActiveReliabilityPolicy() {
  return getReliabilityPolicy(injectedOverrides || {});
}
