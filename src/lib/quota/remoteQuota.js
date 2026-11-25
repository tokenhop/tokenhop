// Pure remote quota derivation & gateway scope filtering (YAN-2014).
// Reads only allow-listed connection metadata and cached in-memory snapshots —
// no DB/crypto/network IO and never handles credentials or refreshes tokens.

import { ALIAS_TO_ID } from "@/shared/constants/providers";
import { QUOTA_SNAPSHOT } from "open-sse/config/quotaSnapshot.js";

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function toIso(value) {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  return null;
}

function resolveProviderAlias(raw) {
  return Object.hasOwn(ALIAS_TO_ID, raw) ? ALIAS_TO_ID[raw] : raw;
}

/**
 * Normalize an optional `?provider=` query parameter to a canonical provider id.
 * Safe against Object.prototype keys (`constructor`, `__proto__`, `toString`).
 * Returns null when absent or empty.
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
export function normalizeProviderFilter(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  return resolveProviderAlias(trimmed);
}

function canonicalModelId(raw) {
  if (typeof raw !== "string") return null;
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return null;
  const providerRaw = raw.slice(0, slash).trim().toLowerCase();
  const model = raw.slice(slash + 1).trim();
  if (!providerRaw || !model) return null;
  return { provider: resolveProviderAlias(providerRaw), model };
}

/**
 * Narrow connections to those reachable by the gateway key's `allowedModels`
 * allow-list (empty allow-list = unrestricted, matching /v1/models and
 * /v1/audio/voices). Granted connections carrying `grantAllowedModels` must
 * also intersect the key's `allowedModels` when both are non-empty.
 *
 * @param {Array<object>} connections
 * @param {object|null|undefined} principal
 * @returns {Array<object>}
 */
export function filterConnectionsByGatewayScope(connections, principal) {
  if (!Array.isArray(connections)) return [];
  const allowedModels = principal?.scopes?.allowedModels;
  if (!Array.isArray(allowedModels) || allowedModels.length === 0) return connections;

  const allowedProviders = new Set();
  const allowedCanonical = new Set();
  for (const entry of allowedModels) {
    const parsed = canonicalModelId(entry);
    if (!parsed) continue;
    allowedProviders.add(parsed.provider);
    allowedCanonical.add(`${parsed.provider}/${parsed.model}`);
  }

  return connections.filter((conn) => {
    if (!conn || typeof conn.provider !== "string") return false;
    if (!allowedProviders.has(conn.provider)) return false;
    if (
      conn.grantId &&
      Array.isArray(conn.grantAllowedModels) &&
      conn.grantAllowedModels.length > 0
    ) {
      return conn.grantAllowedModels.some((entry) => {
        const parsed = canonicalModelId(entry);
        return parsed ? allowedCanonical.has(`${parsed.provider}/${parsed.model}`) : false;
      });
    }
    return true;
  });
}

/**
 * Format one snapshot window into the remote quota window shape.
 * Uses exact provider `used`/`limit` when recorded on the snapshot (`unit: "provider"`);
 * otherwise expresses `used` out of `limit: 100` (`unit: "percentage"`).
 *
 * @param {object|null|undefined} window
 * @returns {{ used: number, limit: number, unit: "provider"|"percentage", percentage: number, remainingPercentage: number, nextReset: string|null, observedAt: string|null }|null}
 */
export function formatRemoteQuotaWindow(window) {
  if (!window || typeof window !== "object") return null;
  const usedFraction =
    typeof window.usedFraction === "number" && Number.isFinite(window.usedFraction)
      ? Math.min(1, Math.max(0, window.usedFraction))
      : null;
  if (usedFraction === null) return null;

  const percentage = round1(usedFraction * 100);
  const remainingPercentage = round1((1 - usedFraction) * 100);
  const hasCounts =
    typeof window.used === "number" &&
    Number.isFinite(window.used) &&
    window.used >= 0 &&
    typeof window.limit === "number" &&
    Number.isFinite(window.limit) &&
    window.limit > 0;

  return {
    used: hasCounts ? window.used : percentage,
    limit: hasCounts ? window.limit : 100,
    unit: hasCounts ? "provider" : "percentage",
    percentage,
    remainingPercentage,
    nextReset: toIso(window.resetsAt),
    observedAt: toIso(window.observedAt),
  };
}

/**
 * Derive secret-free remote quota accounts from connection metadata and a
 * cached snapshot lookup (`open-sse/services/quotaSnapshot.js` `getSnapshot`).
 * Strictly allow-lists output fields. `stale` is true whenever no live windows
 * exist (including tier-only or expired snapshots) or the newest observation is
 * at or past `QUOTA_SNAPSHOT.poller.staleMs`.
 *
 * @param {Array<object>} connections metadata rows ({ id, provider, name, email?, grantId? })
 * @param {(connectionId: string) => object|null} getSnapshotFn cached snapshot lookup
 * @param {number} [nowMs=Date.now()]
 * @returns {Array<object>}
 */
export function deriveRemoteQuotaAccounts(connections, getSnapshotFn, nowMs = Date.now()) {
  if (!Array.isArray(connections)) return [];
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const staleMs = QUOTA_SNAPSHOT.poller.staleMs;

  return connections.map((connection) => {
    const id = typeof connection?.id === "string" ? connection.id : "";
    const provider = typeof connection?.provider === "string" ? connection.provider : "";
    // Granted connections never fall back to grantor email or email-like names.
    const rawName = nonEmpty(connection?.name);
    const safeName = connection?.grantId && rawName?.includes("@") ? null : rawName;
    const name = safeName || (connection?.grantId ? null : nonEmpty(connection?.email)) || id;

    let planTier = null;
    let fiveHour = null;
    let weekly = null;
    let windows = [];
    let updatedAt = null;
    let stale = true;

    try {
      const snap = getSnapshotFn?.(id) ?? null;
      if (snap && typeof snap === "object") {
        planTier = typeof snap.planTier === "string" ? snap.planTier : null;
        updatedAt = toIso(snap.updatedAt);
        const rawWindows = Array.isArray(snap.windows) ? snap.windows : [];
        const formattedWindows = [];
        let newestObservedMs = 0;

        for (const w of rawWindows) {
          const kind = nonEmpty(w?.kind);
          const formatted = formatRemoteQuotaWindow(w);
          if (!kind || !formatted) continue;
          const observedMs =
            typeof w.observedAt === "number" && Number.isFinite(w.observedAt)
              ? w.observedAt
              : formatted.observedAt
                ? Date.parse(formatted.observedAt)
                : 0;
          if (Number.isFinite(observedMs) && observedMs > newestObservedMs) {
            newestObservedMs = observedMs;
          }
          formattedWindows.push({
            kind,
            ...formatted,
            source: w.source === "probe" || w.source === "header" ? w.source : null,
          });
          if (kind === "5h" && !fiveHour) fiveHour = formatted;
          else if (kind === "7d" && !weekly) weekly = formatted;
        }

        windows = formattedWindows;
        if (windows.length > 0) {
          const refMs =
            newestObservedMs > 0
              ? newestObservedMs
              : typeof snap.updatedAt === "number" && Number.isFinite(snap.updatedAt)
                ? snap.updatedAt
                : updatedAt
                  ? Date.parse(updatedAt)
                  : 0;
          stale = !(Number.isFinite(refMs) && refMs > 0 && now - refMs < staleMs);
        }
      }
    } catch {
      /* a broken snapshot row degrades this account only */
    }

    return {
      id,
      name,
      provider,
      planTier,
      fiveHour,
      weekly,
      windows,
      updatedAt,
      stale,
    };
  });
}
