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
 * Build the shell summary. Pure: IO results and the snapshot lookup are injected.
 * @param {{
 *   connections: Array<object>,
 *   combos: Array<object>,
 *   translatorEnabled: boolean,
 *   gateway: { ok: boolean, uptimeSeconds: number, startedAt: string, port: number|null },
 *   getSnapshotView: (connectionId: string) => object|null,
 *   nowMs?: number,
 * }} input
 */
export function buildShellSummary({
  connections,
  combos,
  translatorEnabled,
  gateway,
  getSnapshotView,
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
  };
}
