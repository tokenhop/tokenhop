// YAN-1049: release quota-reset model locks once a usage poll shows headroom.
// Only locks carrying `modelLockMeta_<key>` ownership metadata (written by the
// quota-reset branches of markAccountUnavailable) are ever released here;
// 401/404/5xx/per-model locks have none and wait out their expiry. Never
// touches billingLock*, reauthRequired or isActive.
import {
  getProviderConnectionByIdUnscoped,
  mutateProviderConnectionUnscoped,
} from "@/lib/db/index.js";
import {
  MODEL_LOCK_ALL,
  MODEL_LOCK_META_PREFIX,
  MODEL_LOCK_PREFIX,
  QUOTA_KEY_WINDOW_PREFIX,
  getModelLockKeyForMeta,
  isQuotaLockMeta,
} from "open-sse/services/accountFallback.js";
import { getHeadroom, sanitizedWindowKind } from "open-sse/services/quotaSnapshot.js";
import * as log from "../utils/logger.js";

const HEALTH_RESET = {
  testStatus: "active",
  lastError: null,
  errorCode: null,
  lastErrorAt: null,
  backoffLevel: 0,
};

// Only these providers' failures write quota-lock metadata (markAccountUnavailable):
// github 402 monthly and codex usage_limit_reached resets_at (executors/codex.js
// parseError). Polls for every other provider skip the row read entirely.
const QUOTA_LOCK_PROVIDERS = new Set(["github", "codex"]);

function lockModel(lockKey) {
  return lockKey === MODEL_LOCK_ALL ? "" : lockKey.slice(MODEL_LOCK_PREFIX.length);
}

function lockIsSet(connection, lockKey) {
  return typeof connection?.[lockKey] === "string" && connection[lockKey] !== "";
}

// No-window (provider-reset) locks: raw usage keys every poll must carry below
// 100% before the lock may release. Codex usage_limit_reached does not say which
// window ran out, so both the primary session and the secondary weekly window
// must be present and positive; a poll missing one proves nothing (fail safe).
const REQUIRED_RAW_KEYS = { codex: ["session", "weekly"] };
// Model-scoped window families: when the locked model belongs to one, the poll
// must carry a window of that family (kindForName: review_* → model:review,
// spark_* → model:spark-<rest>).
const MODEL_WINDOW_FAMILIES = {
  codex: [
    { token: "review", matches: (kind) => kind === "model:review" },
    { token: "spark", matches: (kind) => kind.startsWith("model:spark-") },
  ],
};

function modelTokens(model) {
  return model
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Every window the provider defines for this model is present in the poll. */
function pollCoversModel(provider, model, windows, readings) {
  for (const key of REQUIRED_RAW_KEYS[provider] ?? []) {
    const used = readings?.get(key);
    if (!Number.isFinite(used) || !(used < 1)) return false;
  }
  const tokens = modelTokens(model);
  for (const family of MODEL_WINDOW_FAMILIES[provider] ?? []) {
    if (!tokens.includes(family.token)) continue;
    const present = windows.some((w) => family.matches(sanitizedWindowKind(w.kind)?.toLowerCase()));
    if (!present) return false;
  }
  return true;
}

/**
 * Does the poll show headroom for this lock?
 * - `quota:<key>` window: that raw usage key must be present with a usable
 *   reading below 100% (a merged window shared with other keys proves nothing);
 * - snapshot window kind: the poll must carry that kind below 100%;
 * - no window: every window the provider defines for the locked model must be
 *   present (pollCoversModel), and every applicable window below 100%.
 */
function pollShowsHeadroom(meta, lockKey, windows, readings, provider) {
  if (meta.window?.startsWith(QUOTA_KEY_WINDOW_PREFIX)) {
    const used = readings?.get(meta.window.slice(QUOTA_KEY_WINDOW_PREFIX.length));
    return Number.isFinite(used) && used < 1;
  }
  if (meta.window) {
    const kind = sanitizedWindowKind(meta.window)?.toLowerCase();
    return windows.some(
      (w) => sanitizedWindowKind(w.kind)?.toLowerCase() === kind && w.usedFraction < 1,
    );
  }
  const model = lockModel(lockKey);
  if (!pollCoversModel(provider, model, windows, readings)) return false;
  const binding = getHeadroom(null, { windows }, model);
  return binding.source !== "static" && binding.headroom > 0;
}

/**
 * Plan which quota-owned locks a poll may release (pure; no DB access).
 * @param {object|null} connection row as read before the transaction
 * @param {Array<{kind: string, usedFraction: number}>} windows this poll's windows
 * @param {number|undefined} probeStartedAt epoch ms when the poll's fetch started
 * @param {Map<string, number|null>} [readings] raw usage quota key → used fraction
 * @returns {Array<{ lockKey: string, metaKey: string, generation: number }>}
 */
export function planQuotaLockRelease(connection, windows, probeStartedAt, readings = new Map()) {
  if (!connection || !Number.isFinite(probeStartedAt) || !Array.isArray(windows)) return [];
  const plan = [];
  for (const [metaKey, meta] of Object.entries(connection)) {
    if (!metaKey.startsWith(MODEL_LOCK_META_PREFIX) || !isQuotaLockMeta(meta)) continue;
    const lockKey = getModelLockKeyForMeta(metaKey);
    if (!lockIsSet(connection, lockKey)) continue;
    // A poll already in flight when the lock was written proves nothing.
    if (!(probeStartedAt > meta.lockedAt)) continue;
    if (!pollShowsHeadroom(meta, lockKey, windows, readings, connection.provider)) continue;
    plan.push({ lockKey, metaKey, generation: meta.generation });
  }
  return plan;
}

/** Health reset when no other active lock remains on a routing-failed row. */
function withHealthReset(live, clearedLockKeys, patch) {
  const now = Date.now();
  const otherActive = Object.keys(live).some(
    (k) =>
      k.startsWith(MODEL_LOCK_PREFIX) &&
      !clearedLockKeys.includes(k) &&
      lockIsSet(live, k) &&
      Date.parse(live[k]) > now,
  );
  return !otherActive && live.testStatus === "unavailable" ? { ...patch, ...HEALTH_RESET } : patch;
}

/**
 * Apply a release plan in one transaction: a lock is cleared only when its live
 * metadata generation still equals the planned one (a re-lock in between wins).
 * @param {string} connectionId
 * @param {Array<{ lockKey: string, metaKey: string, generation: number }>} plan
 * @returns {Promise<{ released: string[] }>}
 */
export async function applyQuotaLockRelease(connectionId, plan) {
  if (!connectionId || !Array.isArray(plan) || plan.length === 0) return { released: [] };
  let released = [];
  const { applied } = await mutateProviderConnectionUnscoped(connectionId, (live) => {
    const hits = plan.filter(({ metaKey, generation }) => {
      const meta = live[metaKey];
      return isQuotaLockMeta(meta) && meta.generation === generation;
    });
    if (hits.length === 0) return null;
    released = hits.map((h) => h.lockKey);
    const patch = {};
    for (const { lockKey, metaKey } of hits) {
      patch[lockKey] = null;
      patch[metaKey] = null;
    }
    return withHealthReset(live, released, patch);
  });
  return { released: applied ? released : [] };
}

/**
 * Poll hook (recordUsageSnapshot, probe source only). Never throws.
 * @param {object} input
 * @param {string} input.connectionId
 * @param {string} input.provider
 * @param {Array<object>} input.windows this poll's snapshot windows
 * @param {Map<string, number|null>} [input.readings] raw usage quota key → used fraction
 * @param {number} [input.probeStartedAt] epoch ms when the poll's fetch started
 * @param {boolean} [input.limitReached] provider says the limit is still reached
 * @returns {Promise<string[]>} released lock keys
 */
export async function releaseQuotaLocksFromPoll({
  connectionId,
  provider,
  windows,
  readings = new Map(),
  probeStartedAt,
  limitReached = false,
} = {}) {
  try {
    if (!connectionId || !QUOTA_LOCK_PROVIDERS.has(provider) || limitReached) return [];
    if (!Number.isFinite(probeStartedAt) || !Array.isArray(windows)) return [];
    const headroom =
      windows.some((w) => w.usedFraction < 1) ||
      [...readings.values()].some((u) => Number.isFinite(u) && u < 1);
    if (!headroom) return [];
    // Pre-read outside the write transaction: the common no-op path never locks the row.
    const connection = await getProviderConnectionByIdUnscoped(connectionId);
    const plan = planQuotaLockRelease(connection, windows, probeStartedAt, readings);
    if (plan.length === 0) return [];
    const { released } = await applyQuotaLockRelease(connectionId, plan);
    if (released.length > 0) {
      log.info(
        "QUOTA_LOCK",
        `${connectionId.slice(0, 8)} | released ${released.join(",")} on positive poll`,
      );
    }
    return released;
  } catch (error) {
    log.warn(
      "QUOTA_LOCK",
      `${String(connectionId).slice(0, 8)} | release failed: ${error?.message}`,
    );
    return [];
  }
}

/**
 * Clear every quota-owned lock written before `before` (e.g. after a Codex
 * reset-credit spend). Locks without quota metadata stay.
 * @param {string} connectionId
 * @param {{ before?: number }} [opts]
 * @returns {Promise<{ released: string[] }>}
 */
export async function clearQuotaOwnedLocks(connectionId, { before = Date.now() } = {}) {
  if (!connectionId) return { released: [] };
  let released = [];
  const { applied } = await mutateProviderConnectionUnscoped(connectionId, (live) => {
    const patch = {};
    released = [];
    for (const [metaKey, meta] of Object.entries(live)) {
      if (!metaKey.startsWith(MODEL_LOCK_META_PREFIX)) continue;
      if (isQuotaLockMeta(meta) && !(meta.lockedAt < before)) continue;
      const lockKey = getModelLockKeyForMeta(metaKey);
      patch[metaKey] = null;
      if (isQuotaLockMeta(meta) && lockIsSet(live, lockKey)) {
        patch[lockKey] = null;
        released.push(lockKey);
      }
    }
    if (Object.keys(patch).length === 0) return null;
    return withHealthReset(live, released, patch);
  });
  return { released: applied ? released : [] };
}
