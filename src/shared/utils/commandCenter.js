/**
 * Pure derivation helpers for the Home command center page (YAN-292).
 */

/**
 * Derive the muted status line above the H1 from provider/connection states.
 * @param {Array<{ status?: string }>} providers `ok` | `warn` | `err` (+ anything else = idle)
 * @returns {string} plain English literal (translated at render)
 */
export function deriveCommandCenterStatus(providers) {
  if (!Array.isArray(providers) || providers.length === 0) return "Connect your first provider";
  const warn = providers.filter((p) => p?.status === "warn").length;
  const err = providers.filter((p) => p?.status === "err").length;
  // Same "needs attention" count as the provider cards: errors and cooldowns (YAN-391).
  const attention = err + warn;
  if (err > 0)
    return attention === 1 ? "1 provider needs attention" : `${attention} providers need attention`;
  if (warn > 0)
    return warn === 1
      ? "All routes humming · 1 provider cooling down"
      : `All routes humming · ${warn} providers cooling down`;
  return "All routes humming";
}

/**
 * Pick the 3 lowest quota accounts by remaining percent (NULLs last).
 * @param {Array<object>} accounts each with numeric `remaining` (0–100) or null
 * @returns {Array<object>} up to 3, ascending
 */
export function pickLowestQuotaAccounts(accounts) {
  if (!Array.isArray(accounts)) return [];
  return [...accounts]
    .sort((a, b) => {
      const ra = Number.isFinite(a?.remaining) ? a.remaining : Number.POSITIVE_INFINITY;
      const rb = Number.isFinite(b?.remaining) ? b.remaining : Number.POSITIVE_INFINITY;
      return ra - rb;
    })
    .slice(0, 3);
}

/**
 * Pick the 2 most used combos.
 * @param {Array<{ requests?: number }>} combos
 * @returns {Array<object>} up to 2, descending by requests
 */
export function pickTopCombos(combos) {
  if (!Array.isArray(combos)) return [];
  return [...combos]
    .sort((a, b) => (Number(b?.requests) || 0) - (Number(a?.requests) || 0))
    .slice(0, 2);
}

/**
 * Delta of the current period vs the previous period.
 * @param {number} current
 * @param {number} previous
 * @returns {{ delta: number, pct: number|null }} pct null when previous is 0
 */
export function periodDelta(current, previous) {
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (prev === 0) return { delta: cur, pct: null };
  return { delta: cur - prev, pct: +(((cur - prev) / prev) * 100).toFixed(1) };
}
