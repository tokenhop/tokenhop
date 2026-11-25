/**
 * Quota snapshot tunables (YAN-259 phase 1).
 * Threshold/floor semantics (floor vs weight-0 exclusion) are phase-2-owned;
 * computeEffectiveWeight signature carried there — this file holds values only.
 */
export const QUOTA_SNAPSHOT = {
  snapshotTtlMs: 3_600_000,
  floor: 0.05,
  maxConnections: 1000,
  maxWindowsPerConnection: 32,
  profileRecheckMs: 86_400_000,
  poller: { tickMs: 60_000, staleMs: 900_000, failureCooldownMs: 900_000 },
  // Persisted quota snapshot history (YAN-422).
  history: {
    // At most one persisted sample per (connection, window, key) per 5 minutes.
    minSampleIntervalMs: 5 * 60_000,
    // Minimum usedFraction change (0.5%) to record a new sample before heartbeat.
    minChangeDelta: 0.005,
    // Reset timestamp shift (>= 5m) marks a window rollover and records once rate limit passes.
    resetShiftMs: 5 * 60_000,
    // Record a heartbeat even when unchanged after 6h so 7d sparklines stay continuous.
    heartbeatIntervalMs: 6 * 3_600_000,
    // Bounded retention window (30–90 days; default 60d), pruned in batches.
    defaultRetentionDays: 60,
    minRetentionDays: 30,
    maxRetentionDays: 90,
    pruneBatchSize: 1000,
    // Quota page 7d sparkline query window and max points per window.
    sparklineWindowMs: 7 * 24 * 3_600_000,
    maxSparklinePoints: 48,
    maxWriteCacheKeys: 4000,
  },
  // Per-minute rate windows: a 0 without a reset is re-probed after a transient cooldown.
  shortWindowKinds: ["requests", "tokens", "input-tokens", "output-tokens"],
};

/**
 * Relative capacity per provider plan tier. Values are estimates; `_verify`
 * marks rows needing runtime confirmation. Tiers lowercased/trimmed at use.
 */
export const PLAN_CAPACITY = {
  claude: {
    pro: 1,
    default_claude_max_5x: 5,
    default_claude_max_20x: 20,
  },
  codex: {
    plus: 1,
    team: 1,
    business: 1,
    prolite: 5, // _verify
    pro: 20, // _verify
  },
  github: {
    copilot_pro: 1,
    copilot_pro_plus: 4.7, // _verify
    copilot_max: 13.3, // _verify
  },
  "gemini-cli": {
    free: 1,
    "g1-pro-tier": 1.5,
    "g1-ultra-tier": 2, // _verify
  },
  antigravity: {
    "free-tier": 1,
    "legacy-tier": 1,
    "g1-pro-tier": 1.5,
    "g1-ultra-tier": 5, // _verify, no SKU split 5 vs 20
  },
  kiro: {
    free: 0.05,
    pro: 1,
    pro_plus: 2, // _verify ids
    pro_max: 5, // _verify ids
    power: 10, // _verify ids
  },
  cursor: {
    free: 0.1, // _verify
    pro: 1,
    pro_plus: 3, // _verify
    ultra: 20, // _verify
    team: 1,
    business: 1,
    enterprise: 1,
  },
};
