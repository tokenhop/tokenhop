// Workspaces (YAN-353, ADR-0001). Scoped reads and writes only see workspaces
// the principal belongs to. Personal workspaces are created and removed with
// their user (usersRepo).
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { TenancyError, assertCtx, mapConstraintErrors } from "@/lib/users/errors.js";
import { clearCredentialCache } from "../helpers/credentialStorage.js";

const COLS = "w.id, w.name, w.kind, w.createdBy, w.createdAt, w.updatedAt";

function validName(name) {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n) throw new TenancyError("INVALID", "Workspace name is required");
  return n;
}

export async function listWorkspaces(ctx) {
  assertCtx(ctx);
  const db = await getAdapter();
  return db.all(
    `SELECT ${COLS}, m.role FROM workspaces w JOIN memberships m ON m.workspaceId = w.id WHERE m.userId = ? ORDER BY w.createdAt ASC`,
    [ctx.userId],
  );
}

export async function getWorkspace(ctx, id) {
  assertCtx(ctx);
  const db = await getAdapter();
  return (
    db.get(
      `SELECT ${COLS}, m.role FROM workspaces w JOIN memberships m ON m.workspaceId = w.id WHERE w.id = ? AND m.userId = ?`,
      [id, ctx.userId],
    ) ?? null
  );
}

// Admin-only: every workspace on the instance. Callers assert the admin role.
export async function listWorkspacesUnscoped() {
  const db = await getAdapter();
  return db.all(`SELECT ${COLS} FROM workspaces w ORDER BY w.createdAt ASC`);
}

// YAN-356 UI gate: how many shared workspaces exist on the instance.
export async function countSharedWorkspacesUnscoped() {
  const db = await getAdapter();
  return db.get(`SELECT COUNT(*) AS n FROM workspaces WHERE kind = 'shared'`)?.n ?? 0;
}

export async function createSharedWorkspace(ctx, { name }) {
  assertCtx(ctx);
  const db = await getAdapter();
  const now = new Date().toISOString();
  const ws = {
    id: uuidv4(),
    name: validName(name),
    kind: "shared",
    createdBy: ctx.userId,
    createdAt: now,
    updatedAt: now,
  };
  mapConstraintErrors(() =>
    db.transaction(() => {
      db.run(
        `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [ws.id, ws.name, ws.kind, ws.createdBy, now, now],
      );
      db.run(
        `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?, ?, 'owner', 'manual', ?)`,
        [ws.id, ctx.userId, now],
      );
    }),
  );
  return { ...ws, role: "owner" };
}

export async function renameWorkspace(ctx, id, name) {
  const n = validName(name);
  const current = await getWorkspace(ctx, id);
  if (!current) throw new TenancyError("NOT_FOUND", "Workspace not found");
  const db = await getAdapter();
  const updatedAt = new Date().toISOString();
  db.run(`UPDATE workspaces SET name = ?, updatedAt = ? WHERE id = ?`, [n, updatedAt, id]);
  return { ...current, name: n, updatedAt };
}

// YAN-365 (D5): the Default workspace (`_meta.defaultWorkspaceId`) is never
// deletable, secrets or not; the check and the delete share one transaction.
// Post-commit, the deleted workspace's DEK is purged from the cache so a
// cached key can never resurrect deleted data (crypto-shredding of live
// state).
export async function deleteWorkspace(ctx, id) {
  const db = await getAdapter();
  assertCtx(ctx);
  const deleted = db.transaction(() => {
    const current = db.get(
      `SELECT ${COLS}, m.role FROM workspaces w JOIN memberships m ON m.workspaceId = w.id WHERE w.id = ? AND m.userId = ?`,
      [id, ctx.userId],
    );
    if (!current) throw new TenancyError("NOT_FOUND", "Workspace not found");
    const defaultId = db.get(`SELECT value FROM _meta WHERE key = 'defaultWorkspaceId'`)?.value;
    if (defaultId && defaultId === current.id) {
      throw Object.assign(
        new TenancyError("DEFAULT_WORKSPACE_PROTECTED", "The Default workspace cannot be deleted"),
        { status: 409 },
      );
    }
    if (current.kind === "personal") {
      throw new TenancyError("PERSONAL_WORKSPACE", "A personal workspace goes with its user");
    }
    return db.run(`DELETE FROM workspaces WHERE id = ?`, [id]).changes > 0;
  });
  // Always purge, even for an unchanged outcome: cheap and never wrong.
  clearCredentialCache(db, id);
  return deleted;
}

/**
 * Adapter-passed twin for maintenance/tests: the same Default guard and
 * post-commit DEK purge, with the actor passed explicitly instead of a
 * principal ctx (assertCtx shape: `{ userId: actor.id }`).
 */
export async function deleteWorkspaceUnscoped(db, id, _opts = {}) {
  return db.transaction(() => {
    const current = db.get(`SELECT id, kind FROM workspaces WHERE id = ?`, [id]);
    if (!current) throw new TenancyError("NOT_FOUND", "Workspace not found");
    const defaultId = db.get(`SELECT value FROM _meta WHERE key = 'defaultWorkspaceId'`)?.value;
    if (defaultId && defaultId === current.id) {
      throw Object.assign(
        new TenancyError("DEFAULT_WORKSPACE_PROTECTED", "The Default workspace cannot be deleted"),
        { status: 409 },
      );
    }
    if (current.kind === "personal") {
      throw new TenancyError("PERSONAL_WORKSPACE", "A personal workspace goes with its user");
    }
    const deleted = db.run(`DELETE FROM workspaces WHERE id = ?`, [id]).changes > 0;
    clearCredentialCache(db, id);
    return deleted;
  });
}
