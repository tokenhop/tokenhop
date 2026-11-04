// YAN-1829: budget subject while the users & teams switch is off. Only
// workspace and key budgets apply. A pristine install routes with no
// principal; its legacy requests get a budget-only subject, the same
// attribution the usage writer stores, so reservations and settle agree.
import { legacyKeyId } from "@/lib/db/repos/usageRollupRepo.js";

export const OFF_LEVELS = ["key", "workspace"];

/** Budget rows enforced with the switch off. */
export const offScoped = (budget) => OFF_LEVELS.includes(budget.scopeType);

/**
 * Subject for a null (legacy-storage) principal: the raw key's keys-table id
 * (as usageHistory.apiKeyId) and the pending Default workspace.
 * @param {object} db adapter
 * @param {string|null|undefined} apiKey raw legacy key, null when keyless
 * @param {string|null} workspaceId pending Default id, null when none
 */
export function legacySubject(db, apiKey, workspaceId) {
  let apiKeyId = null;
  try {
    apiKeyId = legacyKeyId(db, apiKey);
  } catch (e) {
    // Fail open on the key level only (ADR-0007); the workspace still applies.
    console.warn("[budgetGuard] key lookup failed, key budgets not enforced:", e?.message);
  }
  return { apiKeyId, workspaceId, userId: null, grantId: null };
}
