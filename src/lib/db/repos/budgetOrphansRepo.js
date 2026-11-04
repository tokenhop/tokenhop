// YAN-1913: budgets orphaned by a destructive import. Leaf module (no
// feature-switch or settings imports) so the snapshot apply paths can call it
// without widening their import graph.
import { auditSync } from "@/lib/users/audit.js";

const COLS =
  "id, workspaceId, scopeType, scopeId, window, limitUsd, limitTokens, limitRequests, softLimitPct, resetAt, createdByUserId, createdAt";

// Target table per scope, the "still exists" test, and the audit reason.
// Key: hashed storage needs the key in the budget's workspace (the budget
// API's rule); legacy storage has no apiKeys.workspaceId, so id only.
const SCOPES = [
  {
    scopeType: "key",
    table: "apiKeys",
    exists: (legacy) =>
      legacy
        ? "SELECT 1 FROM apiKeys k WHERE k.id = budgets.scopeId"
        : "SELECT 1 FROM apiKeys k WHERE k.id = budgets.scopeId AND k.workspaceId = budgets.workspaceId",
    reason: "key_removed_by_import",
  },
  {
    scopeType: "grant",
    table: "connectionGrants",
    exists: () => "SELECT 1 FROM connectionGrants g WHERE g.id = budgets.scopeId",
    reason: "grant_removed_by_import",
  },
  {
    scopeType: "membership",
    table: "memberships",
    exists: () =>
      "SELECT 1 FROM memberships m WHERE m.workspaceId || ':' || m.userId = budgets.scopeId",
    reason: "membership_removed_by_import",
  },
  {
    scopeType: "user",
    table: "users",
    exists: () => "SELECT 1 FROM users u WHERE u.id = budgets.scopeId",
    reason: "user_removed_by_import",
  },
];

const tableExists = (db, name) =>
  Boolean(db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [name]));

/**
 * Delete budgets whose target no longer exists: key, grant, membership and
 * user budgets. Runs inside the caller's import transaction; each removal is
 * audited as the importing `actor` ({ principal, ip }) — a removed budget is
 * a raise (ADR-0007). Notices cascade; the usage carry ledger is left alone.
 * Scopes whose target table is absent (pristine schemas) are skipped.
 * @returns {number} Rows removed.
 */
export function pruneOrphanedScopeBudgetsUnscoped(
  db,
  { legacyStorage = false, actor = null } = {},
) {
  if (!tableExists(db, "budgets")) return 0;
  const doomed = SCOPES.filter((s) => tableExists(db, s.table)).flatMap((s) =>
    db
      .all(
        `SELECT ${COLS} FROM budgets WHERE scopeType = ? AND NOT EXISTS (${s.exists(legacyStorage)})`,
        [s.scopeType],
      )
      .map((row) => ({ row, reason: s.reason })),
  );
  for (const { row, reason } of doomed) {
    db.run("DELETE FROM budgets WHERE id = ?", [row.id]);
    auditSync(
      db,
      { principal: actor?.principal ?? null, ip: actor?.ip ?? null, workspaceId: row.workspaceId },
      "budget.delete",
      { type: "budget", id: row.id },
      { before: row, after: { reason } },
    );
  }
  return doomed.length;
}
