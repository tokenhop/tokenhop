/** Maximum providers sent in one live frame (the topology draws one node per provider). */
export const LIVE_ACTIVE_CAP = 24;

/** Provider ids are short slugs; clip anything longer so one frame stays under 2 KB. */
const PROVIDER_MAX = 48;

const clip = (value) => String(value || "").slice(0, PROVIDER_MAX);

/**
 * Keep only what the Usage topology renders: in-flight counts per provider,
 * the last provider used and a recently failing provider. Model, account and
 * recent-request details stay off the wire, so a frame is bounded
 * (≤ LIVE_ACTIVE_CAP × ~70 B) no matter how many requests are in flight.
 * @param {{activeRequests?: {provider?: string, count?: number}[], recentRequests?: {provider?: string}[], errorProvider?: string}} snapshot
 * @returns {{activeRequests: {provider: string, count: number}[], lastProvider: string, errorProvider: string}}
 */
export function buildLivePayload({ activeRequests = [], recentRequests = [], errorProvider = "" }) {
  const counts = new Map();
  for (const { provider, count } of activeRequests) {
    const key = clip(provider);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + (Number(count) || 0));
  }
  return {
    activeRequests: [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, LIVE_ACTIVE_CAP)
      .map(([provider, count]) => ({ provider, count })),
    lastProvider: clip(recentRequests[0]?.provider),
    errorProvider: clip(errorProvider),
  };
}
