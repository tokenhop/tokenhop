import { getActiveReliabilityPolicy } from "../config/reliabilityPolicy.js";
import { PLAN_CAPACITY, QUOTA_SNAPSHOT } from "../config/quotaSnapshot.js";
import { isDurationString } from "../utils/duration.js";

// Pin the store on globalThis so Next.js route bundles share one in-process
// snapshot map (matching forecastStore.js and quotaSnapshotPoller.js).
const SNAPSHOTS_KEY = "__tokenhopQuotaSnapshots";
if (!(globalThis[SNAPSHOTS_KEY] instanceof Map)) {
  globalThis[SNAPSHOTS_KEY] = new Map();
}
const snapshots = globalThis[SNAPSHOTS_KEY];
const HEADER_OBSERVER_KEY = "__tokenhopQuotaHeaderObserver";
const GLOBAL_WINDOW_KINDS = new Set([
  "5h",
  "7d",
  "day",
  "month",
  "requests",
  "tokens",
  "input-tokens",
  "output-tokens",
]);
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const RESET_PAST_TOLERANCE_MS = 86_400_000;
const RESET_FUTURE_HORIZON_MS = 400 * 86_400_000;

function finiteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function validNow(nowMs) {
  return Number.isFinite(nowMs) ? nowMs : Date.now();
}

function copySnapshot(snapshot, windows = snapshot.windows) {
  return { ...snapshot, windows: windows.map((window) => ({ ...window })) };
}

function isLiveWindow(window, nowMs) {
  if (window.resetsAt > 0) return window.resetsAt > nowMs;
  return window.observedAt + QUOTA_SNAPSHOT.snapshotTtlMs > nowMs;
}

function evictOldestIfNeeded(connectionId, nowMs) {
  if (snapshots.has(connectionId) || snapshots.size < QUOTA_SNAPSHOT.maxConnections) return;

  let oldestId;
  let oldestUpdatedAt = Infinity;
  for (const [id, snapshot] of snapshots) {
    const hasLiveWindow = snapshot.windows.some((window) => isLiveWindow(window, nowMs));
    if (!hasLiveWindow && snapshot.updatedAt + QUOTA_SNAPSHOT.snapshotTtlMs <= nowMs) {
      snapshots.delete(id);
    } else if (snapshot.updatedAt < oldestUpdatedAt) {
      oldestId = id;
      oldestUpdatedAt = snapshot.updatedAt;
    }
  }
  if (snapshots.size >= QUOTA_SNAPSHOT.maxConnections && oldestId !== undefined) {
    snapshots.delete(oldestId);
  }
}

function normalizeWindows(windows, source, nowMs) {
  if (!Array.isArray(windows)) return [];

  const normalized = [];
  for (const window of windows) {
    if (!window || typeof window !== "object") continue;
    const kind = sanitizedWindowKind(window.kind);
    const usedFraction = normalizeUsedFraction(window.usedFraction, "used01");
    if (!kind || usedFraction === null) continue;

    const observedAt = finiteNumber(window.observedAt) ?? nowMs;
    const rawUsed = finiteNumber(window.used);
    const rawLimit = finiteNumber(window.limit ?? window.total);
    const hasCounts = rawUsed !== null && rawUsed >= 0 && rawLimit !== null && rawLimit > 0;
    normalized.push({
      kind,
      usedFraction,
      ...(hasCounts ? { used: rawUsed, limit: rawLimit } : {}),
      resetsAt: parseResetMs(window.resetsAt, nowMs) || 0,
      observedAt,
      source,
    });
  }
  return normalized;
}

function recordWindows(connectionId, provider, windows, planTier, source, nowMs) {
  try {
    if (typeof connectionId !== "string" || !connectionId.trim()) return null;
    if (typeof provider !== "string" || !provider.trim()) return null;

    const now = validNow(nowMs);
    const current = snapshots.get(connectionId);
    const incoming = normalizeWindows(windows, source, now);
    const merged = current?.windows
      ? current.windows.filter((window) => isLiveWindow(window, now))
      : [];

    for (const window of incoming) {
      const kindLower = window.kind.toLowerCase();
      const existingIndex = merged.findIndex(
        (candidate) => candidate.kind.toLowerCase() === kindLower,
      );
      if (existingIndex < 0) {
        merged.push(window);
      } else if (window.observedAt >= merged[existingIndex].observedAt) {
        merged.splice(existingIndex, 1, window);
      }
    }
    merged.sort((a, b) => b.observedAt - a.observedAt);

    const sanitizedTier = sanitizePlanTier(planTier);
    const snapshot = {
      provider: provider.trim().toLowerCase(),
      windows: merged.slice(0, QUOTA_SNAPSHOT.maxWindowsPerConnection),
      planTier: sanitizedTier ?? current?.planTier ?? null,
      updatedAt: now,
    };

    evictOldestIfNeeded(connectionId, now);
    snapshots.set(connectionId, snapshot);
    return copySnapshot(snapshot);
  } catch {
    return null;
  }
}

/**
 * Register a fail-open observer invoked when response headers record live quota
 * windows (YAN-422). Pass null to unregister. Keeps open-sse free of DB imports.
 */
export function setHeaderSnapshotObserver(observer) {
  globalThis[HEADER_OBSERVER_KEY] = typeof observer === "function" ? observer : null;
}

/** Record normalized quota windows observed in response headers. */
export function recordHeaderWindows(connectionId, provider, windows, nowMs = Date.now()) {
  const now = validNow(nowMs);
  const snapshot = recordWindows(connectionId, provider, windows, null, "header", now);
  const observer = globalThis[HEADER_OBSERVER_KEY];
  if (snapshot && typeof observer === "function") {
    try {
      const normalized = normalizeWindows(windows, "header", now);
      if (normalized.length > 0) {
        Promise.resolve(observer(connectionId, snapshot.provider, normalized)).catch(() => {});
      }
    } catch {
      /* observer never breaks response header ingestion */
    }
  }
  return snapshot;
}

/** Record normalized quota windows and optional plan tier observed by a usage probe. */
export function recordProbeWindows(connectionId, provider, windows, opts = {}, nowMs = Date.now()) {
  return recordWindows(connectionId, provider, windows, opts?.planTier ?? null, "probe", nowMs);
}

/**
 * Restore a previously persisted snapshot on startup (YAN-422).
 * Filters expired windows against `nowMs`, preserves each window's original
 * `observedAt`/`source` and true `updatedAt` (so staleness stays truthful), and
 * never overwrites an already-present fresher in-memory snapshot. Never throws.
 */
export function restoreSnapshot(connectionId, provider, windows, opts = {}, nowMs = Date.now()) {
  try {
    if (typeof connectionId !== "string" || !connectionId.trim()) return null;
    if (typeof provider !== "string" || !provider.trim()) return null;

    const now = validNow(nowMs);
    const liveIncoming = [];
    let latestObservedAt = 0;

    if (Array.isArray(windows)) {
      for (const window of windows) {
        if (!window || typeof window !== "object") continue;
        const kind = sanitizedWindowKind(window.kind);
        const usedFraction = normalizeUsedFraction(window.usedFraction, "used01");
        const observedAt = finiteNumber(window.observedAt);
        if (!kind || usedFraction === null || observedAt === null || observedAt > now) continue;
        const resetsAt = parseResetMs(window.resetsAt, now) || 0;
        const candidate = {
          kind,
          usedFraction,
          resetsAt,
          observedAt,
          source: window.source === "header" ? "header" : "probe",
        };
        if (!isLiveWindow(candidate, now)) continue;
        liveIncoming.push(candidate);
        if (observedAt > latestObservedAt) latestObservedAt = observedAt;
      }
    }

    const sanitizedTier = sanitizePlanTier(opts?.planTier);
    const rawUpdatedAt = finiteNumber(opts?.updatedAt);
    const restoredUpdatedAt = Math.min(
      now,
      rawUpdatedAt !== null && rawUpdatedAt > 0 ? rawUpdatedAt : latestObservedAt,
    );

    if (liveIncoming.length === 0) {
      if (!sanitizedTier) return null;
      if (restoredUpdatedAt <= 0 || restoredUpdatedAt + QUOTA_SNAPSHOT.snapshotTtlMs <= now) {
        return null;
      }
    }

    const current = snapshots.get(connectionId);
    if (current && current.updatedAt >= restoredUpdatedAt) {
      return copySnapshot(current);
    }

    const merged = current?.windows
      ? current.windows.filter((window) => isLiveWindow(window, now))
      : [];
    for (const window of liveIncoming) {
      const kindLower = window.kind.toLowerCase();
      const existingIndex = merged.findIndex(
        (candidate) => candidate.kind.toLowerCase() === kindLower,
      );
      if (existingIndex < 0) {
        merged.push(window);
      } else if (window.observedAt > merged[existingIndex].observedAt) {
        merged.splice(existingIndex, 1, window);
      }
    }
    merged.sort((a, b) => b.observedAt - a.observedAt);

    const snapshot = {
      provider: provider.trim().toLowerCase(),
      windows: merged.slice(0, QUOTA_SNAPSHOT.maxWindowsPerConnection),
      planTier: sanitizedTier ?? current?.planTier ?? null,
      updatedAt: Math.max(current?.updatedAt ?? 0, restoredUpdatedAt),
    };

    evictOldestIfNeeded(connectionId, now);
    snapshots.set(connectionId, snapshot);
    return copySnapshot(snapshot);
  } catch {
    return null;
  }
}

/**
 * Return a defensive snapshot copy with expired windows removed.
 * Stored state is never mutated by reads.
 */
export function getSnapshot(connectionId, nowMs = Date.now()) {
  try {
    const snapshot = snapshots.get(connectionId);
    if (!snapshot) return null;

    const now = validNow(nowMs);
    const windows = snapshot.windows.filter((window) => isLiveWindow(window, now));
    if (windows.length === 0 && snapshot.updatedAt + QUOTA_SNAPSHOT.snapshotTtlMs <= now) {
      snapshots.delete(connectionId);
      return null;
    }
    return copySnapshot(snapshot, windows);
  } catch {
    return null;
  }
}

/** Clear all in-memory quota snapshots. Intended for tests and lifecycle reset. */
export function clearQuotaSnapshots() {
  snapshots.clear();
}

/** Forget a manual tier when its override is cleared; keep quota windows intact. */
export function clearSnapshotPlanTier(connectionId, tier) {
  const snapshot = snapshots.get(connectionId);
  if (snapshot?.planTier === tier) snapshots.set(connectionId, { ...snapshot, planTier: null });
}

/** Normalize used/remaining quota values to a used fraction in [0, 1]. */
export function normalizeUsedFraction(raw, scale) {
  const value = finiteNumber(raw);
  if (value === null) return null;

  let used;
  switch (scale) {
    case "used01":
      used = value;
      break;
    case "used100":
      used = value / 100;
      break;
    case "remaining01":
      used = 1 - value;
      break;
    case "remaining100":
      used = 1 - value / 100;
      break;
    default:
      return null;
  }
  return Math.min(1, Math.max(0, used));
}

/**
 * Parse an absolute reset timestamp (epoch s/ms number or numeric string, ISO string)
 * into epoch ms within [now-1d, now+400d]. Returns 0 when unknown/out of range.
 * Duration strings (e.g. "6m0s") are not absolute times: returns null so callers
 * convert them first (duration parsing lives with the header parsers).
 */
export function parseResetMs(value, nowMs = Date.now()) {
  try {
    if (value === null || value === undefined || value === "") return 0;
    const now = validNow(nowMs);
    let parsed;

    if (typeof value === "number") {
      if (!Number.isFinite(value)) return 0;
      parsed = value < 1e12 ? value * 1000 : value;
    } else if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return 0;
      if (isDurationString(trimmed)) return null;
      const numeric = finiteNumber(trimmed);
      if (numeric !== null) parsed = numeric < 1e12 ? numeric * 1000 : numeric;
      else parsed = Date.parse(trimmed);
    } else {
      return 0;
    }

    if (!Number.isFinite(parsed)) return 0;
    if (parsed < now - RESET_PAST_TOLERANCE_MS) return 0;
    if (parsed > now + RESET_FUTURE_HORIZON_MS) return 0;
    return parsed;
  } catch {
    return 0;
  }
}

/** Sanitize a quota window kind while preserving model ids after the `model:` prefix. */
export function sanitizedWindowKind(kind) {
  if (typeof kind !== "string") return null;
  const trimmed = kind.trim();
  if (!trimmed || trimmed.length > 128) return null;

  const lower = trimmed.toLowerCase();
  if (GLOBAL_WINDOW_KINDS.has(lower)) return lower;
  if (!lower.startsWith("model:")) return null;

  const modelId = trimmed.slice(trimmed.indexOf(":") + 1).trim();
  if (!modelId || BLOCKED_KEYS.has(modelId.toLowerCase())) return null;
  const sanitized = `model:${modelId}`;
  return sanitized.length <= 128 ? sanitized : null;
}

/** Sanitize a provider plan tier for capacity-table lookup and persistence. */
export function sanitizePlanTier(tier) {
  if (typeof tier !== "string") return null;
  const sanitized = tier.trim().toLowerCase();
  if (!sanitized || sanitized.length > 64 || BLOCKED_KEYS.has(sanitized)) return null;
  return sanitized;
}

/**
 * Model-window match: every token of the window's model id must appear as a
 * contiguous token run in the request model (tokens split on /[^a-z0-9]+/), so
 * a window for `claude-opus-5` matches `claude-opus-5` and
 * `model:claude-opus-5` but not `claude-opus-5.5` or `claude-opus-5-mini`.
 */
function modelWindowMatches(windowModel, modelLower) {
  const windowTokens = windowModel.split(/[^a-z0-9]+/).filter(Boolean);
  if (windowTokens.length === 0) return false;
  const modelTokens = modelLower.split(/[^a-z0-9]+/).filter(Boolean);
  const limit = modelTokens.length - windowTokens.length;
  for (let start = 0; start <= limit; start++) {
    if (windowTokens.every((token, i) => token === modelTokens[start + i])) return true;
  }
  return false;
}

function windowApplies(kind, modelLower) {
  if (GLOBAL_WINDOW_KINDS.has(kind)) return true;
  if (kind.toLowerCase().startsWith("model:") && modelLower) {
    const windowModel = kind.slice(kind.indexOf(":") + 1).toLowerCase();
    return modelWindowMatches(windowModel, modelLower);
  }
  return false;
}

/** Find minimum applicable quota headroom for a snapshot and optional model. */
export function getHeadroom(_provider, snapshot, model) {
  try {
    if (!snapshot || typeof snapshot !== "object") {
      return { headroom: 1, source: "static", stale: true };
    }

    const modelLower = typeof model === "string" ? model.trim().toLowerCase() : "";
    let binding = null;
    for (const window of Array.isArray(snapshot.windows) ? snapshot.windows : []) {
      if (!window || typeof window !== "object") continue;
      const kind = sanitizedWindowKind(window.kind);
      const usedFraction = normalizeUsedFraction(window.usedFraction, "used01");
      if (!kind || usedFraction === null) continue;

      if (!windowApplies(kind, modelLower)) continue;

      const headroom = 1 - usedFraction;
      if (!binding || headroom < binding.headroom) {
        binding = {
          headroom,
          source: window.source === "probe" ? "probe" : "header",
          stale: false,
        };
      }
    }
    return binding ?? { headroom: 1, source: "static", stale: false };
  } catch {
    return { headroom: 1, source: "static", stale: !snapshot };
  }
}

const SHORT_WINDOW_KINDS = new Set(QUOTA_SNAPSHOT.shortWindowKinds);

/**
 * Epoch ms until which the snapshot shows the model's quota exhausted (0 = not
 * known exhausted). Each exhausted window is capped at observedAt + the
 * configured rate-limit cap so a stale zero gets re-probed. Never throws.
 */
export function getExhaustedUntil(snapshot, model, nowMs = Date.now()) {
  try {
    if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.windows)) return 0;
    const now = validNow(nowMs);
    const modelLower = typeof model === "string" ? model.trim().toLowerCase() : "";
    let until = 0;
    for (const window of snapshot.windows) {
      if (!window || typeof window !== "object") continue;
      const kind = sanitizedWindowKind(window.kind);
      const usedFraction = normalizeUsedFraction(window.usedFraction, "used01");
      const observedAt = finiteNumber(window.observedAt);
      if (!kind || usedFraction === null || usedFraction < 1 || observedAt === null) continue;
      const resetsAt = finiteNumber(window.resetsAt) ?? 0;
      if (!isLiveWindow({ resetsAt, observedAt }, now) || !windowApplies(kind, modelLower)) {
        continue;
      }

      const policy = getActiveReliabilityPolicy();
      const cap = observedAt + policy.cooldowns.rateLimitCapMs;
      let windowUntil = cap;
      if (resetsAt > 0) windowUntil = Math.min(resetsAt, cap);
      else if (SHORT_WINDOW_KINDS.has(kind))
        windowUntil = observedAt + policy.cooldowns.transientMs;
      if (windowUntil > now && windowUntil > until) until = windowUntil;
    }
    return until;
  } catch {
    return 0;
  }
}

/**
 * Return best (maximum) headroom across a provider's connections. Phase 3
 * combo weighting calls this instead of reading the store directly so unknown
 * connections stay fail-open (headroom 1), never appearing exhausted.
 * Ties resolve to first input connection. Never throws.
 */
export function getProviderHeadroom(provider, connectionIds, model, nowMs = Date.now()) {
  const fallback = { headroom: 1, source: "static", connectionId: null };
  try {
    if (!Array.isArray(connectionIds)) return fallback;
    const providerKey = typeof provider === "string" ? provider.trim().toLowerCase() : "";
    const seen = new Set();
    let best = null;

    for (const connectionId of connectionIds) {
      if (typeof connectionId !== "string" || !connectionId.trim() || seen.has(connectionId)) {
        continue;
      }
      seen.add(connectionId);

      const snapshot = getSnapshot(connectionId, nowMs);
      if (snapshot && snapshot.provider !== providerKey) continue;

      // Unknown ≠ 0: a connection without a snapshot is fail-open headroom 1.
      const { headroom, source } = snapshot
        ? getHeadroom(providerKey, snapshot, model)
        : { headroom: 1, source: "static" };
      if (!best || headroom > best.headroom) {
        best = { headroom, source, connectionId };
      }
    }

    return best ?? fallback;
  } catch {
    return fallback;
  }
}

/** Compute base capacity multiplied by current applicable quota headroom. */
export function computeEffectiveWeight(options = {}) {
  try {
    const input = options && typeof options === "object" ? options : {};
    const { manualWeight, provider, planTier, snapshot, model } = input;
    const manual = Number.isFinite(manualWeight) && manualWeight >= 0 ? manualWeight : null;
    const providerKey = typeof provider === "string" ? provider.trim().toLowerCase() : "";
    const tier = sanitizePlanTier(planTier) ?? sanitizePlanTier(snapshot?.planTier);

    let base = 1;
    let baseSource = "default";
    if (manual !== null) {
      base = manual;
      baseSource = "manual";
    } else if (
      tier &&
      Object.hasOwn(PLAN_CAPACITY, providerKey) &&
      Object.hasOwn(PLAN_CAPACITY[providerKey], tier)
    ) {
      base = PLAN_CAPACITY[providerKey][tier];
      baseSource = "plan";
    }

    const quota = getHeadroom(providerKey, snapshot, model);
    if (manual === 0) {
      return {
        weight: 0,
        base,
        baseSource,
        headroom: quota.headroom,
        headroomSource: quota.source,
        belowFloor: false,
      };
    }

    const configuredFloor = Number.isFinite(input.floor) ? input.floor : QUOTA_SNAPSHOT.floor;
    const floor = Math.min(1, Math.max(0, configuredFloor));
    const belowFloor = quota.headroom < floor;
    return {
      weight: belowFloor ? 0 : base * quota.headroom,
      base,
      baseSource,
      headroom: quota.headroom,
      headroomSource: quota.source,
      belowFloor,
    };
  } catch {
    return {
      weight: 1,
      base: 1,
      baseSource: "default",
      headroom: 1,
      headroomSource: "static",
      belowFloor: false,
    };
  }
}
