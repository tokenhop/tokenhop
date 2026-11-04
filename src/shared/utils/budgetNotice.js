// Budget notice identity (YAN-1830, YAN-1832), shared by the gateway guard,
// the budget GET routes and the dashboard toast dedupe. Pure, no imports.

const LIMITS = ["limitUsd", "limitTokens", "limitRequests"];

/**
 * What a notice was claimed against: the budget's limits, plus softLimitPct
 * for the soft notice. A claim whose signature no longer matches the budget
 * is not a claim, so changing a limit (or the soft %) in-window re-arms it.
 * @param {{ limitUsd?: number|null, limitTokens?: number|null, limitRequests?: number|null, softLimitPct?: number|null }} budget
 * @param {"soft"|"hard"} kind
 */
export function noticeSignature(budget, kind) {
  const parts = LIMITS.map((f) => budget?.[f] ?? "");
  if (kind === "soft") parts.push(budget?.softLimitPct ?? "");
  return parts.join("|");
}

/** Stable notice id: one per budget, kind and window. */
export const noticeId = (budgetId, kind, windowStartIso) => `${budgetId}:${kind}:${windowStartIso}`;
