/** Maximum providers sent in one live frame (the topology draws one node per provider). */
export const LIVE_ACTIVE_CAP = 24;

/** Provider ids are short slugs; clip anything longer so one frame stays under 2 KB. */
const PROVIDER_MAX = 40;

const clip = (value) => String(value || "").slice(0, PROVIDER_MAX);

/**
 * Keep only what the Usage topology renders: in-flight counts per provider,
 * the last provider used and a recently failing provider. Model, account and
 * recent-request details stay off the wire, so a frame is bounded
 * (≤ LIVE_ACTIVE_CAP × ~70 B) no matter how many requests are in flight.
 * Aggregation runs on the full provider id so distinct providers never
 * merge; the 40-char clip applies only when emitting a frame. Worst case
 * (24 providers × 40 chars, 7-digit counts, both strings clipped) is < 2 KB.
 * @param {{activeRequests?: {provider?: string, count?: number}[], lastProvider?: string, errorProvider?: string}} snapshot
 * @returns {{activeRequests: {provider: string, count: number}[], lastProvider: string, errorProvider: string}}
 */
export function buildLivePayload({ activeRequests = [], lastProvider = "", errorProvider = "" }) {
  const counts = new Map();
  for (const item of activeRequests) {
    const { provider, count } = item || {};
    if (!provider) continue;
    counts.set(provider, (counts.get(provider) || 0) + (Number(count) || 0));
  }
  return {
    activeRequests: [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, LIVE_ACTIVE_CAP)
      .map(([provider, count]) => ({ provider: clip(provider), count })),
    lastProvider: clip(lastProvider),
    errorProvider: clip(errorProvider),
  };
}
