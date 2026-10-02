// Workspace memberships (YAN-353). Scoped: the principal must belong to the
// workspace. Role checks (who may manage members) belong to YAN-357.
import { getAdapter } from "../driver.js";
import { TenancyError, assertCtx, mapConstraintErrors } from "@/lib/users/errors.js";

const MANAGER_ROLES = ["owner", "manager"];

// ─── Internal helpers (sync, inside a transaction; not exported via the barrel) ───
export function membershipRole(db, workspaceId, userId) {
  return (
    db.get(`SELECT role FROM memberships WHERE workspaceId = ? AND userId = ?`, [
      workspaceId,
      userId,
    ])?.role ?? null
  );
}

// Throws LAST_MANAGER when `userId` is the workspace's only owner/manager.
export function assertNotLastManager(db, workspaceId, userId) {
  if (!MANAGER_ROLES.includes(membershipRole(db, workspaceId, userId))) return;
  const { c } = db.get(
    `SELECT COUNT(*) AS c FROM memberships WHERE workspaceId = ? AND role IN ('owner', 'manager') AND userId != ?`,
    [workspaceId, userId],
  );
  if (c === 0) {
    throw new TenancyError("LAST_MANAGER", "A workspace needs at least one owner or manager");
  }
}

// The workspace row, once the principal is known to be a member of it.
function memberWorkspace(db, ctx, workspaceId) {
  assertCtx(ctx);
  const ws = db.get(
    `SELECT w.id, w.kind FROM workspaces w JOIN memberships m ON m.workspaceId = w.id WHERE w.id = ? AND m.userId = ?`,
    [workspaceId, ctx.userId],
  );
  if (!ws) throw new TenancyError("NOT_FOUND", "Workspace not found");
  return ws;
}

function sharedWorkspace(db, ctx, workspaceId) {
  const ws = memberWorkspace(db, ctx, workspaceId);
  if (ws.kind === "personal") {
    throw new TenancyError("PERSONAL_WORKSPACE", "Personal workspaces have a single member");
  }
  return ws;
}

function rowToMembership(row) {
  return row && { ...row };
}

export async function listMemberships(ctx, workspaceId) {
  const db = await getAdapter();
  memberWorkspace(db, ctx, workspaceId);
  return db
    .all(
      `SELECT workspaceId, userId, role, source, createdAt FROM memberships WHERE workspaceId = ? ORDER BY createdAt ASC`,
      [workspaceId],
    )
    .map(rowToMembership);
}

export async function addMembership(
  ctx,
  workspaceId,
  { userId, role = "member", source = "manual" },
) {
  const db = await getAdapter();
  const membership = { workspaceId, userId, role, source, createdAt: new Date().toISOString() };
  mapConstraintErrors(() =>
    db.transaction(() => {
      sharedWorkspace(db, ctx, workspaceId);
      db.run(
        `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?, ?, ?, ?, ?)`,
        [workspaceId, userId, role, source, membership.createdAt],
      );
    }),
  );
  return membership;
}

export async function updateMembershipRole(ctx, workspaceId, userId, role) {
  const db = await getAdapter();
  return mapConstraintErrors(() =>
    db.transaction(() => {
      sharedWorkspace(db, ctx, workspaceId);
      if (!membershipRole(db, workspaceId, userId)) {
        throw new TenancyError("NOT_FOUND", "Membership not found");
      }
      if (!MANAGER_ROLES.includes(role)) assertNotLastManager(db, workspaceId, userId);
      db.run(`UPDATE memberships SET role = ? WHERE workspaceId = ? AND userId = ?`, [
        role,
        workspaceId,
        userId,
      ]);
      return rowToMembership(
        db.get(
          `SELECT workspaceId, userId, role, source, createdAt FROM memberships WHERE workspaceId = ? AND userId = ?`,
          [workspaceId, userId],
        ),
      );
    }),
  );
}

export async function removeMembership(ctx, workspaceId, userId) {
  const db = await getAdapter();
  return db.transaction(() => {
    sharedWorkspace(db, ctx, workspaceId);
    assertNotLastManager(db, workspaceId, userId);
    const { changes } = db.run(`DELETE FROM memberships WHERE workspaceId = ? AND userId = ?`, [
      workspaceId,
      userId,
    ]);
    return changes > 0;
  });
}
