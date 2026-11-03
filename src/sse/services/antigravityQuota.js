/**
 * Antigravity live quota cache — in-memory, refreshed on demand.
 * Used by auth.js pre-filter to skip accounts with exhausted model quota.
 * Also triggered by 409/429 error handler to sync exact resetAt from upstream.
 */

import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { getAntigravityUsage } from "open-sse/services/usage/google.js";
import { recordProbeWindows } from "open-sse/services/quotaSnapshot.js";
import * as log from "../utils/logger.js";

// Compat Map (auth pre-filter + tests read/write this directly). Every
// internal write dual-writes normalized probe windows to the snapshot store
// (canonical for phase-2 weight) and mirrors the upstream-exact entries here,
// so routing behavior is byte-identical to before the fold.
// ponytail: clearAntigravityStrikes drops only this Map; the store window
// expires or is overwritten on the next refresh (no per-window delete API).
const quotaCache = new Map();
// Track last refresh per connection to avoid hammering
const lastRefreshAt = new Map();
// In-flight refresh promises — dedup concurrent 409/429 bursts
const inflightRefresh = new Map();

const MIN_REFRESH_INTERVAL_MS = 30_000; // 30s between refreshes per connection

// Strike-based circuit breaker (#3681): Google's quota API can report remaining
// quota while generation endpoints keep returning 429 (sprint/weekly dual-pool
// mismatch). After STRIKE_THRESHOLD 429s within the window for the same
// connection+model, treat the optimistic quota reading as untrusted and
// cache-block that pair instead of retry-storming upstream.
const STRIKE_WINDOW_MS = 60_000; // strikes older than this reset the count
const STRIKE_THRESHOLD = 3;
const STRIKE_BLOCK_MS = 15 * 60_000;
const strikeCounts = new Map(); // "connectionId|model" → { count, windowStart (anchored at first strike) }
const strikeBlocks = new Map(); // "connectionId|model" → blockedUntil ms

/**
 * Adapter: upstream quota entry → snapshot probe window.
 * @param {string} model model id
 * @param {{ remainingPercentage?: number, resetAt?: string }} entry upstream quota entry
 * @returns {object|null} probe window, or null when reading is unknown
 */
function _toSnapshotWindow(model, entry) {
  if (model === null || model === undefined) return null;
  const remaining = Number(entry?.remainingPercentage);
  // Unknown reading (>= 100% means "unlimited/unknown" per YAN-259): skip, keep prior.
  if (!Number.isFinite(remaining) || remaining >= 100) return null;
  return {
    kind: `model:${model}`,
    usedFraction: Math.min(1, Math.max(0, 1 - remaining / 100)),
    resetsAt: entry?.resetAt,
  };
}

/**
 * Dual-write: record normalized probe windows in the store (canonical), then
 * mirror the upstream-exact entries (+ active strike blocks) into the view.
 * Mirror, not projection: the store drops unknown (>=100%) readings and
 * out-of-horizon resets, which would change routing if read back.
 * @param {string} connectionId connection id
 * @param {object} quotas quotas map, merged into the existing view entry
 * @returns {object} view entry for the connection
 */
// Keys that would hit the prototype setter (or shadow Object internals) if
// merged via Object.assign from an upstream-controlled quotas object.
const FORBIDDEN_QUOTA_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Copy own entries of a quotas map onto a fresh plain object, skipping
 * prototype-pollution-shaped keys. Keeps the view entry a normal object so
 * `cache.get(id)?.[model]` reads stay unchanged.
 */
function _safeQuotaCopy(quotas) {
  const out = {};
  for (const [k, v] of Object.entries(quotas || {})) {
    if (FORBIDDEN_QUOTA_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function _writeQuotas(connectionId, quotas, { merge = false } = {}) {
  const windows = Object.entries(quotas || {})
    .map(([modelId, entry]) => _toSnapshotWindow(modelId, entry))
    .filter(Boolean);
  if (windows.length > 0) recordProbeWindows(connectionId, "antigravity", windows);
  const entry = merge
    ? Object.assign(_safeQuotaCopy(quotaCache.get(connectionId)), _safeQuotaCopy(quotas))
    : _safeQuotaCopy(quotas);
  quotaCache.set(connectionId, applyActiveStrikeBlocks(connectionId, entry));
  _stampWrites(connectionId, Object.keys(quotas || {}), merge);
  return quotaCache.get(connectionId);
}

// YAN-1050: write time per cached entry (connectionId → { model → ms }). Kept
// beside the cache so entry objects keep their upstream shape.
const quotaWrittenAt = new Map();

function _stampWrites(connectionId, models, merge) {
  const now = Date.now();
  const stamps = merge ? { ...(quotaWrittenAt.get(connectionId) || {}) } : {};
  for (const model of Object.keys(quotaCache.get(connectionId) || {})) {
    if (!merge || models.includes(model) || stamps[model] === undefined) stamps[model] = now;
  }
  quotaWrittenAt.set(connectionId, stamps);
}

function _isStrikeEntry(connectionId, model, entry) {
  const until = strikeBlocks.get(`${connectionId}|${model}`);
  return until !== undefined && entry?.resetAt === new Date(until).toISOString();
}

/**
 * YAN-1050: drop exhausted CACHE_BLOCK entries a newer probe disproves. While a
 * block is active the account is never selected, so the error path (the only
 * other writer) can't refresh it. RAM-only. An entry goes only when it is an
 * exhausted upstream reading (not a strike block), the probe carries that exact
 * `model:<id>` window below 100% (family overlays map to `model:gemini` /
 * `model:claude`, never a model's exact kind), and the probe started after the
 * entry was written.
 * @param {string} connectionId
 * @param {Array<{ kind: string, usedFraction: number }>} windows probe windows
 * @param {number} probeStartedAt epoch ms when the probe's fetch started
 * @returns {string[]} released model ids
 */
export function releaseExactQuotaBlocks(connectionId, windows, probeStartedAt) {
  const cached = quotaCache.get(connectionId);
  if (!cached || !Number.isFinite(probeStartedAt) || !Array.isArray(windows)) return [];
  const stamps = quotaWrittenAt.get(connectionId) || {};
  const released = [];
  for (const [model, entry] of Object.entries(cached)) {
    if (!(entry?.remainingPercentage <= 0) || _isStrikeEntry(connectionId, model, entry)) continue;
    if (!(probeStartedAt > (stamps[model] ?? Number.POSITIVE_INFINITY))) continue;
    if (!windows.some((w) => w?.kind === `model:${model}` && w.usedFraction < 1)) continue;
    delete cached[model];
    delete stamps[model];
    released.push(model);
  }
  if (released.length > 0) {
    log.info(
      "AG_QUOTA",
      `${connectionId.slice(0, 8)} | CACHE_RELEASE ${released.join(",")} — probe shows quota`,
    );
  }
  return released;
}

/**
 * Re-apply active strike blocks onto a fresh quotas snapshot so the auth
 * pre-filter (which reads this cache) keeps skipping the blocked pair across
 * requests until the block expires — same channel as the exhausted-0% path.
 */
function applyActiveStrikeBlocks(connectionId, quotas) {
  const now = Date.now();
  for (const [key, until] of strikeBlocks) {
    if (!key.startsWith(`${connectionId}|`)) continue;
    if (until <= now) {
      strikeBlocks.delete(key);
      continue;
    }
    quotas[key.slice(connectionId.length + 1)] = {
      remainingPercentage: 0,
      resetAt: new Date(until).toISOString(),
    };
  }
  return quotas;
}

/**
 * Clear strike state for a connection|model after a successful request, so
 * "consecutive" strikes means consecutive. Only removes a synthesized cache
 * entry (resetAt == our block deadline); a real upstream 0% reading stays.
 */
export function clearAntigravityStrikes(connectionId, model) {
  const key = `${connectionId}|${model}`;
  strikeCounts.delete(key);
  const until = strikeBlocks.get(key);
  if (until === undefined) return;
  strikeBlocks.delete(key);
  const cached = quotaCache.get(connectionId);
  if (cached?.[model]?.resetAt === new Date(until).toISOString()) {
    delete cached[model];
    delete quotaWrittenAt.get(connectionId)?.[model];
    quotaCache.set(connectionId, cached);
  }
}

/**
 * Get the quota cache (read-only reference for auth.js pre-filter).
 */
export function getAntigravityQuotaCache() {
  return quotaCache;
}

/**
 * Refresh quota for a single antigravity connection from upstream API.
 * Updates in-memory cache only. Cache expiry is the upstream model resetAt.
 * @returns {object|null} quotas map or null on failure
 */
export async function refreshAntigravityQuota(connectionId, accessToken, providerSpecificData) {
  const now = Date.now();
  // Coalesce concurrent refreshes before applying the interval gate.
  const inflight = inflightRefresh.get(connectionId);
  if (inflight) return inflight;

  const lastRefresh = lastRefreshAt.get(connectionId) || 0;
  if (now - lastRefresh < MIN_REFRESH_INTERVAL_MS) {
    log.debug(
      "AG_QUOTA",
      `${connectionId.slice(0, 8)} | skip refresh (${Math.round((now - lastRefresh) / 1000)}s ago)`,
    );
    return quotaCache.get(connectionId) || null;
  }

  // Record every attempt so failed quota calls cannot amplify an upstream 429 burst.
  lastRefreshAt.set(connectionId, now);
  const promise = _doRefresh(connectionId, accessToken, providerSpecificData);
  inflightRefresh.set(connectionId, promise);
  try {
    return await promise;
  } finally {
    inflightRefresh.delete(connectionId);
  }
}

async function _doRefresh(connectionId, accessToken, providerSpecificData) {
  try {
    const proxyCfg = await resolveConnectionProxyConfig(providerSpecificData || {});
    const proxyOptions = {
      connectionProxyEnabled: proxyCfg.connectionProxyEnabled === true,
      connectionProxyUrl: proxyCfg.connectionProxyUrl || "",
      connectionNoProxy: proxyCfg.connectionNoProxy || "",
      vercelRelayUrl: proxyCfg.vercelRelayUrl || "",
      strictProxy: proxyCfg.strictProxy === true,
    };

    const usage = await getAntigravityUsage(accessToken, providerSpecificData, proxyOptions);
    // 401/403 usage responses can contain an empty quotas object plus message.
    // Preserve known cache instead of replacing it with an upstream error response.
    if (!usage?.quotas || usage.message) return null;

    // Update in-memory cache. Caller logs CACHE_BLOCK only if requested model is exhausted.
    // Strike blocks are re-asserted after every refresh so an optimistic
    // upstream reading cannot resurrect a pair we just circuit-broke.
    return _writeQuotas(connectionId, usage.quotas);
  } catch (e) {
    log.warn("AG_QUOTA", `${connectionId.slice(0, 8)} | refresh failed: ${e.message}`);
    return null;
  }
}

/**
 * Handle Antigravity 409/429 — refresh RAM cache and return model resetAt when exhausted.
 * Called from chat handler error path.
 * @returns {number|null} resetAt timestamp ms (for resetsAtMs passthrough) or null
 */
export async function handleAntigravityQuotaError(
  connectionId,
  status,
  model,
  accessToken,
  providerSpecificData,
) {
  model = model ?? null;
  log.info("AG_QUOTA", `${connectionId.slice(0, 8)} | ${status} on ${model} — refreshing quota`);

  // Throttle applies to error paths too: one quota request per account/30s.
  // The first 409/429 populates cache; concurrent or repeated errors reuse it.
  const quota = (await refreshAntigravityQuota(connectionId, accessToken, providerSpecificData))?.[
    model
  ];

  // Strike breaker: count every 429 whose quota reading is either optimistic
  // (remaining > 0) or unavailable (quota API 403/error). 3 within the window
  // => the pair is unhealthy regardless of what the API claims; block 15m.
  // 409 counts too by design: Antigravity signals pool exhaustion with 409 as
  // well (see #3561 — "skip exhausted account/model quota before upstream
  // retry" was motivated by 409/429 pairs), and poisoning by transient 409s
  // requires 3 of them inside 60 seconds on the same pair.
  if (!quota || quota.remainingPercentage > 0) {
    const key = `${connectionId}|${model}`;
    const now = Date.now();
    const strike = strikeCounts.get(key);
    // Fixed window anchored at the FIRST qualifying strike: three 429s must
    // all land within 60s of that first one, not within 60s of each other.
    const windowStart =
      strike && now - strike.windowStart <= STRIKE_WINDOW_MS ? strike.windowStart : now;
    const count = strike && windowStart === strike.windowStart ? strike.count + 1 : 1;
    strikeCounts.set(key, { count, windowStart });
    if (count >= STRIKE_THRESHOLD) {
      strikeCounts.delete(key);
      const blockedUntil = now + STRIKE_BLOCK_MS;
      const reading = quota ? `${Math.round(quota.remainingPercentage)}%` : "unknown";
      log.warn(
        "AG_QUOTA",
        `${connectionId.slice(0, 8)} | STRIKE_${status} ${model} — ${count}x 429 (quota ${reading}); CACHE_BLOCK 15m`,
      );
      // Synthesize a 0% probe window, then re-assert the routing block in the
      // compat view (the chat handler does not persist modelLock_* here).
      strikeBlocks.set(key, blockedUntil);
      if (model !== null && !FORBIDDEN_QUOTA_KEYS.has(model)) {
        _writeQuotas(
          connectionId,
          { [model]: { remainingPercentage: 0, resetAt: new Date(blockedUntil).toISOString() } },
          { merge: true },
        );
      }
      return blockedUntil;
    }
    return null;
  }

  // Healthy-but-exhausted reading: clear strikes and use the exact resetAt.
  strikeCounts.delete(`${connectionId}|${model}`);
  if (!quota.resetAt) return null;

  const resetMs = new Date(quota.resetAt).getTime();
  if (resetMs <= Date.now()) return null;

  log.warn(
    "AG_QUOTA",
    `${connectionId.slice(0, 8)} | UPSTREAM_${status} ${model} — quota exhausted; CACHE_BLOCK until ${quota.resetAt}`,
  );
  return resetMs;
}
