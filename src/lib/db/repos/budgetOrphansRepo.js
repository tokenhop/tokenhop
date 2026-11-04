// YAN-1913: budgets orphaned by a destructive import. Leaf module (no
// feature-switch or settings imports) so the snapshot apply paths can call it
// without widening their import graph.
import { auditSync } from "@/lib/users/audit.js";

const COLS =
  "id, workspaceId, scopeType, scopeId, window, limitUsd, limitTokens, limitRequests, softLimitPct, resetAt, createdByUserId, createdAt";

/**
 * Delete key budgets whose key no longer exists (hashed storage: in the
 * budget's workspace, the API's scope rule; legacy storage: by id), and
 * grant budgets whose grant no longer exists. Runs inside the caller's
 * import transaction; each removal is audited (a removed budget is a raise,
 * ADR-0007). Notices cascade; the usage carry ledger is left alone.
 * @returns {number} Rows removed.
 */
export function pruneOrphanedScopeBudgetsUnscoped(db, { legacyStorage = false } = {}) {
  const keyMatch = legacyStorage
    ? "k.id = budgets.scopeId"
    : "k.id = budgets.scopeId AND k.workspaceId = budgets.workspaceId";
  const doomed = [
    ...db
      .all(
        `SELECT ${COLS} FROM budgets WHERE scopeType = 'key' AND NOT EXISTS (SELECT 1 FROM apiKeys k WHERE ${keyMatch})`,
      )
      .map((row) => ({ row, reason: "key_removed_by_import" })),
    ...db
      .all(
        `SELECT ${COLS} FROM budgets WHERE scopeType = 'grant' AND NOT EXISTS (SELECT 1 FROM connectionGrants g WHERE g.id = budgets.scopeId)`,
      )
      .map((row) => ({ row, reason: "grant_removed_by_import" })),
  ];
  for (const { row, reason } of doomed) {
    db.run("DELETE FROM budgets WHERE id = ?", [row.id]);
    auditSync(
      db,
      { workspaceId: row.workspaceId },
      "budget.delete",
      { type: "budget", id: row.id },
      { before: row, after: { reason } },
    );
  }
  return doomed.length;
}
