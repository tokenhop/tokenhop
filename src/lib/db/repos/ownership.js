// Workspace ownership of provider connections and nodes (YAN-361, ADR-0001).
// Sync helpers that run inside the caller's transaction.
import { getAdapter } from "../driver.js";
import { TenancyError, assertCtx } from "@/lib/users/errors.js";

const OWNED = ["providerConnections", "providerNodes"];

/** The Default workspace id once the owner bootstrap created it, else null. */
export function defaultWorkspaceIdUnscoped(db) {
  return (
    db.get(
      `SELECT w.id FROM _meta m JOIN workspaces w ON w.id = m.value WHERE m.key = 'defaultWorkspaceId'`,
    )?.id ?? null
  );
}

/**
 * Ownerless connections and nodes (rows written before the switch was first
 * on) → Default workspace, created by the owner. Idempotent; 0 before bootstrap.
 */
export function adoptOwnerlessRowsUnscoped(db) {
  const ws = defaultWorkspaceIdUnscoped(db);
  if (!ws) return 0;
  const owner = db.get(`SELECT id FROM users WHERE instanceRole = 'owner'`)?.id ?? null;
  let n = 0;
  for (const t of OWNED) {
    n += db.run(
      `UPDATE ${t} SET workspaceId = ?, createdByUserId = COALESCE(createdByUserId, ?) WHERE workspaceId IS NULL`,
      [ws, owner],
    ).changes;
  }
  return n;
}

export async function adoptOwnerlessUnscoped() {
  const db = await getAdapter();
  return db.transaction(() => adoptOwnerlessRowsUnscoped(db));
}

/**
 * `workspaceId` when the principal belongs to it, else NOT_FOUND. A client
 * value is only a selector; never "forbidden", so ids don't leak existence.
 */
export function memberWorkspaceId(ctx, db, workspaceId) {
  assertCtx(ctx);
  const ok =
    typeof workspaceId === "string" &&
    db.get(`SELECT 1 AS x FROM memberships WHERE workspaceId = ? AND userId = ?`, [
      workspaceId,
      ctx.userId,
    ]);
  if (!ok) throw new TenancyError("NOT_FOUND", "Workspace not found");
  return workspaceId;
}
