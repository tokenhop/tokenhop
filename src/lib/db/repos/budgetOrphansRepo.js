// YAN-1913: budgets orphaned by a destructive import; YAN-1934: switch-off
// budgets restored from a snapshot. No feature-switch or settings imports,
// so the snapshot apply paths can call it without widening their import
// graph (ownership.js is already theirs).
import { auditSync } from "@/lib/users/audit.js";
import { resetAtIso } from "@/lib/users/budgets.js";
import {
  ensurePendingDefaultWorkspaceUnscoped,
  offBudgetWorkspaceIdUnscoped,
} from "./ownership.js";

const COLS =
  "id, workspaceId, scopeType, scopeId, window, limitUsd, limitTokens, limitRequests, softLimitPct, resetAt, createdByUserId, createdAt";

// Target table per scope and its "still exists" test.
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
  },
  {
    scopeType: "grant",
    table: "connectionGrants",
    exists: () => "SELECT 1 FROM connectionGrants g WHERE g.id = budgets.scopeId",
  },
  {
    scopeType: "membership",
    table: "memberships",
    exists: () =>
      "SELECT 1 FROM memberships m WHERE m.workspaceId = budgets.workspaceId AND m.userId = substr(budgets.scopeId, length(budgets.workspaceId) + 2) AND budgets.scopeId = m.workspaceId || ':' || m.userId",
  },
  {
    scopeType: "user",
    table: "users",
    exists: () => "SELECT 1 FROM users u WHERE u.id = budgets.scopeId",
  },
];

const tableExists = (db, name) =>
  Boolean(db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [name]));

// Delete each budget row and audit it as `actor` inside the caller's
// transaction; a failed audit throws and rolls the deletion back.
function deleteAuditedSync(db, rows, actor, reason) {
  for (const row of rows) {
    db.run("DELETE FROM budgets WHERE id = ?", [row.id]);
    auditSync(
      db,
      { principal: actor?.principal ?? null, ip: actor?.ip ?? null, workspaceId: row.workspaceId },
      "budget.delete",
      { type: "budget", id: row.id },
      { before: row, after: { reason, scopeType: row.scopeType } },
    );
  }
}

/**
 * Delete budgets whose target no longer exists: key, grant, membership and
 * user budgets. Audit reason `target_missing_at_import` (with the scopeType):
 * the import may have removed the target or merely not carried it. Runs inside the caller's import transaction; each removal is
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
    db.all(
      `SELECT ${COLS} FROM budgets WHERE scopeType = ? AND NOT EXISTS (${s.exists(legacyStorage)})`,
      [s.scopeType],
    ),
  );
  deleteAuditedSync(db, doomed, actor, "target_missing_at_import");
  return doomed.length;
}

/**
 * YAN-1935: delete every budget on a hard-deleted key (legacy key storage),
 * audited with reason `key_deleted`. Runs inside the caller's transaction;
 * notices cascade.
 * @returns {number} Rows removed.
 */
export function deleteKeyBudgetsUnscoped(db, keyId, { actor = null } = {}) {
  if (!tableExists(db, "budgets")) return 0;
  const rows = db.all(`SELECT ${COLS} FROM budgets WHERE scopeType = 'key' AND scopeId = ?`, [
    keyId,
  ]);
  deleteAuditedSync(db, rows, actor, "key_deleted");
  return rows.length;
}

const OFF_KEY_COLS = ["workspaceId", "scopeType", "scopeId", "window"];
const OFF_LIMIT_COLS = ["limitUsd", "limitTokens", "limitRequests", "softLimitPct"];

/**
 * YAN-1934: switch-off budgets for an instance snapshot (`offBudgets`): the
 * switch-off budget workspace's workspace and key budgets (the selection of
 * the switch-off config document, exportPortableBudgetsUnscoped), raw with
 * their ids so a restore keeps them and their notice claims. Limits only:
 * never spend, carry, notices, the creator or the derived resetAt.
 */
export function exportOffModeBudgetsUnscoped(db) {
  const ws = offBudgetWorkspaceIdUnscoped(db);
  if (!ws || !tableExists(db, "budgets")) return [];
  const cols = ["id", ...OFF_KEY_COLS, ...OFF_LIMIT_COLS, "createdAt"].join(", ");
  return db.all(
    `SELECT ${cols} FROM budgets WHERE workspaceId = ? AND scopeType IN ('workspace', 'key') ORDER BY scopeType <> 'workspace', createdAt, id`,
    [ws],
  );
}

/**
 * YAN-1934: restore a snapshot's switch-off budgets (`offBudgets`, checked by
 * validateOffBudgets) onto this instance's switch-off budget workspace
 * (Default, else the pending Default, created only when there is a row).
 * The snapshot is authoritative for that workspace's workspace/key budgets:
 * live ones it lacks, and rows holding a restored row's scope/window slot
 * under another id, are deleted and audited (reason `not_in_backup`). Rows
 * keep their ids and are updated in place (never REPLACE, which would
 * cascade the notice claims); a row whose id now names another scope or
 * window is deleted first and starts clean. Creator is NULL (the audit
 * trail names actors) and resetAt is recomputed. Runs inside the caller's
 * import transaction, before the orphan prune and foreign_key_check.
 * @param {ReadonlyArray<object>|null} rows null: older snapshot, no change.
 * @returns {number} Rows written.
 */
export function restoreOffBudgetsUnscoped(db, rows, { actor = null } = {}) {
  if (!rows || !tableExists(db, "budgets")) return 0;
  const ws =
    offBudgetWorkspaceIdUnscoped(db) ??
    (rows.length ? ensurePendingDefaultWorkspaceUnscoped(db) : null);
  if (!ws) return 0;
  const mapped = rows.map((row) => ({
    ...row,
    workspaceId: ws,
    scopeId: row.scopeType === "workspace" ? ws : row.scopeId,
  }));
  const ids = new Set(mapped.map((row) => row.id));
  const stale = db
    .all(
      `SELECT ${COLS} FROM budgets WHERE workspaceId = ? AND scopeType IN ('workspace', 'key')`,
      [ws],
    )
    .filter((row) => !ids.has(row.id));
  deleteAuditedSync(db, stale, actor, "not_in_backup");
  const upsert = `INSERT INTO budgets(${COLS}) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(id) DO UPDATE SET ${[...OFF_LIMIT_COLS, "resetAt"].map((c) => `${c} = excluded.${c}`).join(", ")}`;
  for (const row of mapped) {
    const clashes = db
      .all(
        `SELECT ${COLS} FROM budgets WHERE id = ? OR (scopeType = ? AND scopeId = ? AND window = ?)`,
        [row.id, row.scopeType, row.scopeId, row.window],
      )
      .filter((live) => live.id !== row.id || OFF_KEY_COLS.some((c) => live[c] !== row[c]));
    deleteAuditedSync(db, clashes, actor, "not_in_backup");
    db.run(upsert, [
      row.id,
      ...OFF_KEY_COLS.map((c) => row[c]),
      ...OFF_LIMIT_COLS.map((c) => row[c] ?? null),
      resetAtIso(row.window),
      row.createdAt,
    ]);
  }
  return mapped.length;
}
