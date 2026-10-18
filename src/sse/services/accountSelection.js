import { computeEffectiveWeight, getSnapshot } from "open-sse/services/quotaSnapshot.js";
import { pickSmoothWeighted } from "open-sse/services/weightedRoundRobin.js";

// OAuth subscription accounts: per-request rotation risks anti-abuse flags.
const OAUTH_SUBSCRIPTION_PROVIDERS = new Set([
  "claude",
  "codex",
  "github",
  "gemini-cli",
  "antigravity",
  "kiro",
  "cursor",
]);

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Weighted sticky window. Provider override wins; subscription providers then
 * inherit global limit (default 3); others default to 1.
 */
export function resolveWeightedStickyLimit(providerId, providerOverride = {}, settings = {}) {
  const explicit = positiveInt(providerOverride?.stickyRoundRobinLimit);
  if (explicit) return explicit;
  // ponytail: global stickyRoundRobinLimit is always materialized (default 3), so it only
  // applies to subscription providers; add per-strategy global key if others need it.
  if (!OAUTH_SUBSCRIPTION_PROVIDERS.has(providerId)) return 1;
  return positiveInt(settings?.stickyRoundRobinLimit) ?? 3;
}

/**
 * Decomposed effective weight for one connection. Manual psd.planTier wins; else the
 * detected snapshot tier, with persisted auto tier only when the snapshot lacks one.
 */
export function effectiveWeightFor(
  connection,
  { provider = connection?.provider, model, snapshot } = {},
) {
  const psd = connection?.providerSpecificData || {};
  const planTier = psd.planTierManual === true || !snapshot?.planTier ? psd.planTier : null;
  return computeEffectiveWeight({ provider, model, snapshot, planTier, manualWeight: psd.weight });
}

/** Select from already-available accounts without mutating DB or SWRR state. */
export function selectWeightedConnection({
  connections,
  provider,
  model,
  stickyLimit,
  state,
  getSnapshot: snapshotFor = getSnapshot,
  now = Date.now(),
}) {
  const weighted = connections.map((connection) => {
    const snapshot = snapshotFor(connection.id, now);
    const { weight } = effectiveWeightFor(connection, { provider, model, snapshot });
    return { connection, weight };
  });

  const current = weighted.reduce((latest, entry) => {
    const time = Date.parse(entry.connection.lastUsedAt || "");
    return Number.isFinite(time) && (!latest || time > latest.time) ? { ...entry, time } : latest;
  }, null);
  if (current?.weight > 0 && (current.connection.consecutiveUseCount || 0) < stickyLimit) {
    return { connection: current.connection, nextState: state ?? new Map(), continued: true };
  }

  const eligible = weighted.some(({ weight }) => weight > 0)
    ? weighted.filter(({ weight }) => weight > 0)
    : weighted.map(({ connection }) => ({ connection, weight: 1 }));
  const { id, currentWeights } = pickSmoothWeighted(
    eligible.map(({ connection, weight }) => ({ id: connection.id, weight })),
    state,
  );
  return {
    connection: eligible.find(({ connection }) => connection.id === id)?.connection ?? null,
    nextState: currentWeights,
    continued: false,
  };
}

/**
 * The pinned connection if it is still eligible, else null. Pure (no DB/state writes).
 * Eligible = present in `connections` (the already-filtered available set, so locks,
 * exclusions, grants and budgets are never bypassed); for "weighted" also weight > 0.
 */
export function pickPinnedConnection({
  pinnedId,
  connections,
  strategy,
  provider,
  model,
  getSnapshot: snapshotFor = getSnapshot,
  now = Date.now(),
}) {
  const pinned = pinnedId ? connections.find((c) => c.id === pinnedId) : null;
  if (!pinned) return null;
  if (strategy !== "weighted") return pinned;
  const { weight } = effectiveWeightFor(pinned, {
    provider,
    model,
    snapshot: snapshotFor(pinned.id, now),
  });
  return weight > 0 ? pinned : null;
}
