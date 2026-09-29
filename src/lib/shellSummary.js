// Shell summary for GET /api/shell/summary: everything the sidebar badges and
// gateway card need in one small payload, so the shell never polls full lists.
import { summarizeProviders } from "@/shared/utils/providerHealth";
import { deriveQuotaAccounts } from "@/lib/home/quota.js";

export const LOW_QUOTA_THRESHOLD = 20;

/**
 * Connected-provider count and needs-attention count/worst status under the
 * shared provider-health rule.
 * @param {Array<object>} connections
 * @param {number} [nowMs]
 * @returns {{ connected: number, attention: { count: number, status: "warn"|"err"|null } }}
 */
export function summarizeProviderBadges(connections, nowMs = Date.now()) {
  const summary = summarizeProviders([], Array.isArray(connections) ? connections : [], nowMs);
  const flagged = summary.providers.filter((p) => p.needsAttention);
  const status = flagged.some((p) => p.status === "err") ? "err" : flagged.length ? "warn" : null;
  return { connected: summary.connected, attention: { count: flagged.length, status } };
}

/**
 * Accounts whose worst quota window has `threshold` percent or less remaining.
 * Accounts without a snapshot (remaining null) don't count.
 * @param {Array<{ remaining: number|null }>} accounts
 * @param {number} [threshold]
 */
export function countLowQuota(accounts, threshold = LOW_QUOTA_THRESHOLD) {
  if (!Array.isArray(accounts)) return 0;
  return accounts.filter((a) => typeof a?.remaining === "number" && a.remaining <= threshold)
    .length;
}

/**
 * Shape the heartbeat traffic payload (YAN-408): 15 integer req/min buckets
 * plus their total. Anything that isn't a numeric series is null (absent
 * heartbeat), never a fake flat line.
 * @param {Array<number>|null|undefined} series
 * @returns {{ series: number[], total: number }|null}
 */
export function shapeHeartbeatTraffic(series) {
  if (!Array.isArray(series)) return null;
  const counts = series.map((value) =>
    Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0,
  );
  return { series: counts, total: counts.reduce((sum, value) => sum + value, 0) };
}

/**
 * Build the shell summary. Pure: IO results and the snapshot lookup are injected.
 * `traffic` is the 15-bucket req/min series for the gateway heartbeat; it rides
 * the existing summary poll (no extra requests). `savingsMilestone` is the
 * pending milestone toast value (number or null); `undefined` means "could not
 * be computed" and omits the block so clients keep their last state.
 * @param {{
 *   connections: Array<object>,
 *   combos: Array<object>,
 *   translatorEnabled: boolean,
 *   gateway: { ok: boolean, uptimeSeconds: number, startedAt: string, port: number|null },
 *   getSnapshotView: (connectionId: string) => object|null,
 *   traffic?: Array<number>|null,
 *   savingsMilestone?: number|null,
 *   nowMs?: number,
 * }} input
 */
export function buildShellSummary({
  connections,
  combos,
  translatorEnabled,
  gateway,
  getSnapshotView,
  traffic,
  savingsMilestone,
  nowMs = Date.now(),
}) {
  const rows = Array.isArray(connections) ? connections : [];
  const active = rows.filter((c) => c?.isActive !== false);
  return {
    gateway,
    providers: summarizeProviderBadges(rows, nowMs),
    combos: (Array.isArray(combos) ? combos : []).filter((c) => !c?.kind || c.kind === "llm")
      .length,
    lowQuota: countLowQuota(deriveQuotaAccounts(active, getSnapshotView)),
    enableTranslator: Boolean(translatorEnabled),
    traffic: shapeHeartbeatTraffic(traffic),
    savings:
      savingsMilestone === undefined
        ? null
        : {
            pendingMilestone:
              Number.isInteger(savingsMilestone) && savingsMilestone > 0 ? savingsMilestone : null,
          },
  };
}
