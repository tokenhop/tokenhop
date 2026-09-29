// App-side quota snapshot sync (YAN-259). Maps USAGE_HANDLERS results onto the
// open-sse snapshot store and persists providerSpecificData.planTier.
// App-only: may import @/lib/localDb + open-sse; open-sse never imports this.
import {
  computeEffectiveWeight,
  getSnapshot,
  recordHeaderWindows,
  recordProbeWindows,
  sanitizePlanTier,
} from "open-sse/services/quotaSnapshot.js";
import { QUOTA_SNAPSHOT } from "open-sse/config/quotaSnapshot.js";
import { recordQuotaSample } from "@/lib/quota/forecastStore.js";
import { fetchClaudePlanTier } from "open-sse/services/usage/claude.js";
import { cursorPlanTier } from "open-sse/services/usage/cursor.js";
import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";

export { getSnapshot };

const TIER_PERSIST_DEBOUNCE_MS = 3_600_000;
const CODEX_TIERS = new Set(["plus", "pro", "prolite", "team", "business"]);
const GITHUB_MONTHLY_KEYS = new Set(["chat", "completions", "premium_interactions"]);
// connectionId -> { at, tier } of the last DB persist/check; skips DB reads within the debounce.
const lastPersist = new Map();

function toFinite(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

/** Used fraction from a USAGE_HANDLERS quota: remainingPercentage (0–100) first, else used/total. */
function usedFractionFor(quota) {
  if (!quota || typeof quota !== "object" || quota.unlimited === true) return null;
  const remainingPct = toFinite(quota.remainingPercentage);
  if (remainingPct !== null) return clamp01(1 - remainingPct / 100);
  const used = toFinite(quota.used);
  const total = toFinite(quota.total);
  return used !== null && total !== null && total > 0 ? clamp01(used / total) : null;
}

/**
 * Adapter: USAGE_HANDLERS quota key → snapshot window kind (null = skip).
 * - claude: `session (5h)`→5h; `weekly <model> (7d)`→model:<model> (checked first); `weekly (7d)`→7d
 * - codex: review_*→model:review, spark_<rest>→model:spark-<rest>; session/weekly classified by
 *   quota.windowMinutes (≥6000→7d, ≤300→5h, else day), key name only as fallback
 * - gemini-cli/antigravity: bucket modelId→model:<id>; family weekly overlays
 *   (gemini_weekly→model:gemini, claude_gpt_weekly→model:claude); remaining ≥100% = unknown
 * - github: chat/completions/premium_interactions→month
 * - kiro: resourceType key→model:<key>
 * - groq: Requests/Tokens→requests/tokens
 * - cursor: Total→month (billing-cycle % used); other rows skipped
 * - kimi: `5h`→5h; `Weekly`/`7d`→7d; `Monthly`→month; `… #N` dedup suffix ignored (skips `Monthly (Code)` —
 *   code-subset row, not account-wide — plus `Ratelimit*` legacy rows)
 * - glm/glm-cn: `Session (5h)`→5h; `Weekly (7d)`→7d (skips `Tokens`,
 *   `Limit (*)`, other `Session (Nh)` — ambiguous scope)
 * - opencode-go: `Weekly`→7d; `Monthly`→month (skips `Rolling` — API does not
 *   define it as a 5h window)
 * - commandcode: `Session (5h)`→5h; `Weekly`→7d (skips `Credits` balance)
 * - meta-code: `Session (5h)`→5h; `Weekly`→7d
 * - ollama: `Session (5h)`→5h; `Weekly (7d)`→7d
 * - xiaomi-mimo: `Weekly`→7d
 * - minimax/minimax-cn: skipped (model-scoped display names, not model ids)
 */
export function kindForName(provider, quotaKey, quota) {
  if (typeof quotaKey !== "string" || !quotaKey.trim()) return null;
  const key = quotaKey.trim();
  const lower = key.toLowerCase();

  switch (provider) {
    case "claude": {
      if (lower === "session (5h)") return "5h";
      const scoped = /^weekly (.+) \(7d\)$/i.exec(key);
      if (scoped) return `model:${scoped[1].trim()}`;
      return /^weekly.*\(7d\)$/i.test(key) ? "7d" : null;
    }
    case "codex": {
      // ponytail: review_* collapses to one window (tightest wins via dedupe); split if
      // phase 2 needs per-window review headroom.
      if (lower.startsWith("review_")) return "model:review";
      if (lower.startsWith("spark_")) return `model:spark-${lower.slice("spark_".length)}`;
      const minutes = toFinite(quota?.windowMinutes);
      if (minutes !== null) {
        if (minutes >= 6000) return "7d";
        if (minutes <= 300) return "5h";
        return "day";
      }
      if (lower === "session") return "5h";
      if (lower === "weekly") return "7d";
      return null;
    }
    case "gemini-cli":
    case "antigravity": {
      if (toFinite(quota?.remainingPercentage) >= 100) return null;
      if (lower === "gemini_weekly") return "model:gemini";
      if (lower === "claude_gpt_weekly") return "model:claude";
      return `model:${key}`;
    }
    case "github":
      return GITHUB_MONTHLY_KEYS.has(lower) ? "month" : null;
    case "kiro":
      return `model:${key}`;
    case "groq":
      return lower === "requests" || lower === "tokens" ? lower : null;
    case "cursor":
      return lower === "total" ? "month" : null;
    case "kimi": {
      // limits[] rows are named by window ("5h", "7d") and deduped as "5h #2".
      const base = lower.replace(/\s+#\d+$/, "");
      if (base === "5h") return "5h";
      if (base === "weekly" || base === "7d") return "7d";
      return base === "monthly" ? "month" : null;
    }
    case "glm":
    case "glm-cn":
      if (lower === "session (5h)") return "5h";
      return lower === "weekly (7d)" ? "7d" : null;
    case "opencode-go":
      if (lower === "weekly") return "7d";
      return lower === "monthly" ? "month" : null;
    case "commandcode":
    case "meta-code":
      if (lower === "session (5h)") return "5h";
      return lower === "weekly" ? "7d" : null;
    case "ollama":
      if (lower === "session (5h)") return "5h";
      return lower === "weekly (7d)" ? "7d" : null;
    case "xiaomi-mimo":
      return lower === "weekly" ? "7d" : null;
    default:
      return null;
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function codexTier(raw) {
  const tier = sanitizePlanTier(raw);
  return tier && CODEX_TIERS.has(tier) ? tier : null;
}

/** Plan tier carried by a usage payload. Claude is skipped (profile endpoint via poller). */
function planTierFor(provider, usage) {
  switch (provider) {
    case "codex":
      return codexTier(usage.plan);
    case "github": {
      const plan = nonEmpty(usage.plan);
      return plan?.trim().toLowerCase().startsWith("copilot") ? plan : null;
    }
    case "kiro":
      return (
        nonEmpty(usage.subscriptionInfo?.subscriptionTitle) ??
        nonEmpty(usage.subscriptionInfo?.subscription) ??
        (usage.plan && usage.plan !== "Kiro" ? nonEmpty(usage.plan) : null)
      );
    case "gemini-cli":
    case "antigravity":
      return (
        nonEmpty(usage.subscriptionInfo?.paidTier?.id) ??
        nonEmpty(usage.subscriptionInfo?.currentTier?.id)
      );
    case "cursor":
      return cursorPlanTier(usage.planName ?? usage.plan);
    default:
      return null;
  }
}

/**
 * Persist planTier (and optionally planTierCheckedAt) into providerSpecificData.
 * Debounced per connection: an unchanged tier within 1h skips the DB entirely.
 */
async function persistPlanTier(connectionId, rawTier, { markChecked = false } = {}) {
  const tier = sanitizePlanTier(rawTier);
  if (!tier && !markChecked) return null;

  const cached = lastPersist.get(connectionId);
  if (!markChecked && cached?.tier === tier && Date.now() - cached.at < TIER_PERSIST_DEBOUNCE_MS) {
    return tier;
  }

  const existing = await getProviderConnectionById(connectionId);
  if (!existing) return null;
  const psd = existing.providerSpecificData || {};
  // Manual tier (set via PUT) is never overwritten; check time still persists.
  const changed =
    psd.planTierManual !== true && tier !== null && tier !== sanitizePlanTier(psd.planTier);
  if (changed || markChecked) {
    await updateProviderConnection(connectionId, {
      providerSpecificData: {
        ...psd,
        ...(changed ? { planTier: tier } : {}),
        ...(markChecked ? { planTierCheckedAt: new Date().toISOString() } : {}),
      },
    });
  }
  lastPersist.set(connectionId, { at: Date.now(), tier });
  return tier;
}

/**
 * Record a USAGE_HANDLERS result into the snapshot store and persist a detected
 * plan tier. `source: "header"` records as header windows (no tier). `fallbackTier`
 * (already-known tier, e.g. persisted planTier / chatgptPlanType) fills the snapshot
 * when the payload carries none; it is never re-persisted. Never throws.
 */
export async function recordUsageSnapshot({
  connectionId,
  provider,
  usage,
  source = "probe",
  fallbackTier,
} = {}) {
  try {
    if (!connectionId || !provider || !usage || typeof usage !== "object") return null;

    // Forecast samples (probe only): per raw quota key, regardless of kind
    // mapping — kind mapping is irrelevant for forecasts. Own try/catch so it
    // never breaks the snapshot.
    try {
      if (source === "probe") {
        for (const [quotaKey, quota] of Object.entries(usage.quotas || {})) {
          const usedFraction = usedFractionFor(quota);
          if (usedFraction === null) continue;
          recordQuotaSample(connectionId, quotaKey, {
            remaining: (1 - usedFraction) * 100,
            resetAt: quota.resetAt ?? null,
          });
        }
      }
    } catch (error) {
      console.warn(`[QuotaSnapshot] forecast sample failed for ${provider}: ${error?.message}`);
    }

    // One window per kind; keep the tightest (highest used) when keys collapse.
    const byKind = new Map();
    for (const [quotaKey, quota] of Object.entries(usage.quotas || {})) {
      const kind = kindForName(provider, quotaKey, quota);
      const usedFraction = kind ? usedFractionFor(quota) : null;
      if (usedFraction === null) continue;
      const prev = byKind.get(kind);
      if (!prev || usedFraction > prev.usedFraction) {
        byKind.set(kind, { kind, usedFraction, resetsAt: quota.resetAt ?? null });
      }
    }

    const windows = [...byKind.values()];
    if (source === "header") {
      return windows.length
        ? recordHeaderWindows(connectionId, provider, windows)
        : getSnapshot(connectionId);
    }
    const detectedTier = planTierFor(provider, usage);
    if (windows.length === 0 && !detectedTier) {
      // No fresh data: never bump updatedAt (would mask stale/429 state). A known
      // fallback tier only seeds a tier-only snapshot when none exists yet.
      const existing = getSnapshot(connectionId);
      const seedTier =
        provider === "codex" ? codexTier(fallbackTier) : sanitizePlanTier(fallbackTier);
      if (existing || !seedTier) return existing;
      return recordProbeWindows(connectionId, provider, [], { planTier: seedTier });
    }
    const planTier =
      detectedTier ??
      (provider === "codex" ? codexTier(fallbackTier) : sanitizePlanTier(fallbackTier));

    const snapshot = recordProbeWindows(connectionId, provider, windows, { planTier });
    if (detectedTier) await persistPlanTier(connectionId, detectedTier);
    return snapshot;
  } catch (error) {
    console.warn(`[QuotaSnapshot] record failed for ${provider}: ${error?.message}`);
    return null;
  }
}

/**
 * Claude plan tier via the OAuth profile endpoint, at most once per
 * QUOTA_SNAPSHOT.profileRecheckMs per connection (tracked by planTierCheckedAt).
 * A 403 (setup token) persists only the check time so it is retried after 24h. Never throws.
 */
export async function fetchAndPersistClaudePlanTier(connection, proxyOptions = null) {
  try {
    if (!connection?.id) return null;
    const psd = connection.providerSpecificData || {};
    // Snapshot holds detected tier only; a manual psd.planTier is applied at selection.
    const knownTier = psd.planTierManual === true ? null : sanitizePlanTier(psd.planTier);
    const checkedMs = new Date(psd.planTierCheckedAt).getTime();
    const fresh =
      Number.isFinite(checkedMs) && Date.now() - checkedMs < QUOTA_SNAPSHOT.profileRecheckMs;

    let tier = knownTier;
    if (!fresh) {
      const fetched = await fetchClaudePlanTier(connection.accessToken, proxyOptions);
      await persistPlanTier(connection.id, fetched, { markChecked: true });
      tier = sanitizePlanTier(fetched) ?? knownTier;
    }
    // Mirror the tier into the in-memory snapshot so weights see it without a DB read.
    if (tier) recordProbeWindows(connection.id, "claude", [], { planTier: tier });
    return tier;
  } catch (error) {
    console.warn(`[QuotaSnapshot] claude plan tier failed: ${error?.message}`);
    return null;
  }
}

function toIso(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

/** API view of a connection's snapshot (owned here), or null when none exists. */
export function buildQuotaSnapshotView(connectionId, { manualWeight, model } = {}) {
  try {
    const snapshot = getSnapshot(connectionId);
    if (!snapshot) return null;
    return {
      planTier: snapshot.planTier ?? null,
      windows: snapshot.windows.map((window) => ({
        kind: window.kind,
        usedFraction: window.usedFraction,
        resetsAt: toIso(window.resetsAt),
        source: window.source,
      })),
      updatedAt: toIso(snapshot.updatedAt),
      stale: Date.now() - snapshot.updatedAt >= QUOTA_SNAPSHOT.poller.staleMs,
      effectiveWeight: computeEffectiveWeight({
        manualWeight,
        provider: snapshot.provider,
        planTier: snapshot.planTier,
        snapshot,
        model,
      }),
    };
  } catch (error) {
    console.warn(`[QuotaSnapshot] view failed: ${error?.message}`);
    return null;
  }
}

/** Test helper: clear the planTier persist debounce. */
export function _resetQuotaSnapshotSync() {
  lastPersist.clear();
}
