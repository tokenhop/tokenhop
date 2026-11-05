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

// Audit one removed budget row as `actor` inside the caller's transaction; a
// failed audit throws and rolls the removal back.
function auditRemovalSync(db, row, actor, reason) {
  auditSync(
    db,
    { principal: actor?.principal ?? null, ip: actor?.ip ?? null, workspaceId: row.workspaceId },
    "budget.delete",
    { type: "budget", id: row.id },
    { before: row, after: { reason, scopeType: row.scopeType } },
  );
}

// Delete each budget row and audit it as `actor` inside the caller's
// transaction; a failed audit throws and rolls the deletion back.
function deleteAuditedSync(db, rows, actor, reason) {
  for (const row of rows) {
    db.run("DELETE FROM budgets WHERE id = ?", [row.id]);
    auditRemovalSync(db, row, actor, reason);
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
const OFF_SCOPE_SQL = "scopeType IN ('workspace', 'key')";

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
    `SELECT ${cols} FROM budgets WHERE workspaceId = ? AND ${OFF_SCOPE_SQL} ORDER BY scopeType <> 'workspace', createdAt, id`,
    [ws],
  );
}

/**
 * Live switch-off budget rows (full columns), captured before a destructive
 * apply whose workspace delete cascades them away, so restoreOffBudgetsUnscoped
 * can still audit the ones the backup does not keep. [] without a workspace.
 */
export function captureOffBudgetsUnscoped(db) {
  const ws = offBudgetWorkspaceIdUnscoped(db);
  if (!ws || !tableExists(db, "budgets")) return [];
  return db.all(`SELECT ${COLS} FROM budgets WHERE workspaceId = ? AND ${OFF_SCOPE_SQL}`, [ws]);
}

// A budget's slot: what its notice claims are bound to (restoreBudgetNotices
// checks the same columns). The workspace is not part of it: a kept id moves
// into the target workspace in place, keeping its claims.
const SLOT_COLS = ["scopeType", "scopeId", "window"];
const slotOf = (row) => SLOT_COLS.map((c) => row[c]).join("\u0000");

/**
 * YAN-1934: restore a snapshot's switch-off budgets (`offBudgets`, checked by
 * validateOffBudgets) onto this instance's switch-off budget workspace
 * (Default, else the pending Default, created only when there is a row).
 * The snapshot is authoritative for that workspace's workspace/key budgets.
 * Every removal is audited as `budget.delete`:
 *  - `replaced_from_backup`: the backup keeps the id under another scope,
 *    target or window; the row is deleted first and starts clean (no notice
 *    claims);
 *  - `not_in_backup`: a live row the backup lacks, or one holding a restored
 *    row's scope/window slot under an id the backup lacks.
 * Kept rows are updated in place (never REPLACE, which would cascade their
 * notice claims). Creator is NULL (the audit trail names actors) and resetAt
 * is recomputed. `prior` (captureOffBudgetsUnscoped before the apply's
 * deletes) audits rows a workspace cascade already removed, by the same
 * rules; rows still live here are audited once, by the deletes below. Runs
 * inside the caller's import transaction, before the orphan prune and
 * foreign_key_check.
 * @param {ReadonlyArray<object>|null} rows null: older snapshot, no change.
 * @returns {number} Rows written.
 */
export function restoreOffBudgetsUnscoped(db, rows, { actor = null, prior = [] } = {}) {
  if (!rows || !tableExists(db, "budgets")) return 0;
  const cascaded = prior.filter(
    (row) => !db.get("SELECT 1 AS x FROM budgets WHERE id = ?", [row.id]),
  );
  const ws =
    offBudgetWorkspaceIdUnscoped(db) ??
    (rows.length ? ensurePendingDefaultWorkspaceUnscoped(db) : null);
  const mapped = (ws ? rows : []).map((row) => ({
    ...row,
    workspaceId: ws,
    scopeId: row.scopeType === "workspace" ? ws : row.scopeId,
  }));
  const slots = new Map(mapped.map((row) => [row.id, slotOf(row)]));
  // Removal reason of a row no longer (or not yet) at its backup slot.
  const reason = (row) => (slots.has(row.id) ? "replaced_from_backup" : "not_in_backup");
  for (const row of cascaded) {
    if (slots.get(row.id) !== slotOf(row)) auditRemovalSync(db, row, actor, reason(row));
  }
  if (!ws) return 0;
  // First every live row off its backup slot (ids the backup lacks, or ids it
  // moved to another scope, target or window), so the slot check below meets
  // only rows under ids the backup lacks.
  const live = new Map(
    db
      .all(`SELECT ${COLS} FROM budgets WHERE workspaceId = ? AND ${OFF_SCOPE_SQL}`, [ws])
      .concat(mapped.flatMap((row) => db.all(`SELECT ${COLS} FROM budgets WHERE id = ?`, [row.id])))
      .map((row) => [row.id, row]),
  );
  for (const row of live.values()) {
    if (slots.get(row.id) !== slotOf(row)) deleteAuditedSync(db, [row], actor, reason(row));
  }
  const upsert = `INSERT INTO budgets(${COLS}) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(id) DO UPDATE SET ${["workspaceId", ...OFF_LIMIT_COLS, "resetAt"].map((c) => `${c} = excluded.${c}`).join(", ")}`;
  for (const row of mapped) {
    const clashes = db.all(
      `SELECT ${COLS} FROM budgets WHERE scopeType = ? AND scopeId = ? AND window = ? AND id <> ?`,
      [row.scopeType, row.scopeId, row.window, row.id],
    );
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
