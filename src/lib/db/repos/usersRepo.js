// Users (YAN-353, ADR-0002/0003). Invariants live here, not in the UI:
// exactly one owner, changed only by transferOwnership; the owner can't be
// deleted, disabled or demoted; deleting a user can't leave a shared
// workspace without an owner/manager. `passwordHash` never leaves this repo
// except through getUserPasswordHashUnscoped.
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { TenancyError, assertCtx, mapConstraintErrors } from "@/lib/users/errors.js";
import { assertNotLastManager } from "./membershipsRepo.js";

const COLS =
  "id, email, username, displayName, instanceRole, status, sessionVersion, createdAt, updatedAt, lastLoginAt";
// Changing any of these revokes the user's sessions (ADR-0004).
const SESSION_FIELDS = ["instanceRole", "status", "passwordHash"];

function optText(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s || null;
}

function getRow(db, id) {
  return db.get(`SELECT ${COLS} FROM users WHERE id = ?`, [id]) ?? null;
}

function requireRow(db, id) {
  const row = getRow(db, id);
  if (!row) throw new TenancyError("NOT_FOUND", "User not found");
  return row;
}

// Self only; other users are read through the admin *Unscoped functions.
export async function getUser(ctx, id) {
  assertCtx(ctx);
  if (ctx.userId !== id) return null;
  const db = await getAdapter();
  return getRow(db, id);
}

export async function getUserUnscoped(id) {
  const db = await getAdapter();
  return getRow(db, id);
}

export async function listUsersUnscoped() {
  const db = await getAdapter();
  return db.all(`SELECT ${COLS} FROM users ORDER BY createdAt ASC`);
}

export async function getOwnerUnscoped() {
  const db = await getAdapter();
  return db.get(`SELECT ${COLS} FROM users WHERE instanceRole = 'owner'`) ?? null;
}

export async function countActiveUsersUnscoped() {
  const db = await getAdapter();
  return db.get(`SELECT COUNT(*) AS n FROM users WHERE status = 'active'`)?.n ?? 0;
}

// Session validation reads (ADR-0004): cached <= 5 s, dropped by every
// sessionVersion write in this process, so revocation lands on the next request.
const SESSION_TTL_MS = 5000;
// On globalThis: Next bundles the proxy and route handlers separately, each with
// its own copy of this module, and a bump in a route must reach the guard's cache.
globalThis.__tokenhopSessionCache ??= new Map();
const sessionCache = globalThis.__tokenhopSessionCache;

export async function getSessionUserUnscoped(id) {
  const hit = sessionCache.get(id);
  if (hit && Date.now() - hit.at < SESSION_TTL_MS) return hit.row;
  const row = await getUserUnscoped(id);
  sessionCache.set(id, { row, at: Date.now() });
  return row;
}

export async function bumpSessionVersion(id) {
  const db = await getAdapter();
  const changed = db.run(
    `UPDATE users SET sessionVersion = sessionVersion + 1, updatedAt = ? WHERE id = ?`,
    [new Date().toISOString(), id],
  ).changes;
  sessionCache.delete(id);
  return changed > 0;
}

export async function getUserPasswordHashUnscoped(id) {
  const db = await getAdapter();
  return db.get(`SELECT passwordHash FROM users WHERE id = ?`, [id])?.passwordHash ?? null;
}

// Creates the user, their personal workspace and its owner membership together.
export async function createUserUnscoped({
  email,
  username,
  displayName,
  instanceRole = "pending",
  status = "active",
  passwordHash,
} = {}) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const id = uuidv4();
  const wsId = uuidv4();
  const name = optText(displayName) ?? optText(username) ?? optText(email) ?? "Personal";
  return mapConstraintErrors(() =>
    db.transaction(() => {
      db.run(
        `INSERT INTO users(id, email, username, displayName, instanceRole, status, passwordHash, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          optText(email),
          optText(username),
          optText(displayName),
          instanceRole,
          status,
          passwordHash ?? null,
          now,
          now,
        ],
      );
      db.run(
        `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES(?, ?, 'personal', ?, ?, ?)`,
        [wsId, name, id, now, now],
      );
      db.run(
        `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?, ?, 'owner', 'manual', ?)`,
        [wsId, id, now],
      );
      return { ...getRow(db, id), personalWorkspaceId: wsId };
    }),
  );
}

export async function updateUserUnscoped(id, patch = {}) {
  const db = await getAdapter();
  return mapConstraintErrors(() =>
    db.transaction(() => {
      const row = requireRow(db, id);
      const next = {};
      for (const k of ["email", "username", "displayName"]) {
        if (Object.hasOwn(patch, k)) next[k] = optText(patch[k]);
      }
      for (const k of SESSION_FIELDS) if (Object.hasOwn(patch, k)) next[k] = patch[k] ?? null;

      if (next.instanceRole !== undefined && next.instanceRole !== row.instanceRole) {
        if (row.instanceRole === "owner" || next.instanceRole === "owner") {
          throw new TenancyError("OWNER_IMMUTABLE", "Ownership changes only by transfer");
        }
      }
      if (row.instanceRole === "owner" && next.status && next.status !== "active") {
        throw new TenancyError("OWNER_IMMUTABLE", "The owner can't be disabled");
      }

      const bump =
        (Object.hasOwn(next, "instanceRole") && next.instanceRole !== row.instanceRole) ||
        (Object.hasOwn(next, "status") && next.status !== row.status) ||
        Object.hasOwn(next, "passwordHash");
      const sets = Object.keys(next).map((k) => `${k} = ?`);
      sets.push("updatedAt = ?");
      if (bump) sets.push("sessionVersion = sessionVersion + 1");
      db.run(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, [
        ...Object.values(next),
        new Date().toISOString(),
        id,
      ]);
      sessionCache.delete(id);
      return getRow(db, id);
    }),
  );
}

export async function deleteUserUnscoped(id) {
  const db = await getAdapter();
  return db.transaction(() => {
    const row = requireRow(db, id);
    if (row.instanceRole === "owner") {
      throw new TenancyError("OWNER_IMMUTABLE", "Transfer ownership before deleting the owner");
    }
    const shared = db.all(
      `SELECT m.workspaceId FROM memberships m JOIN workspaces w ON w.id = m.workspaceId WHERE m.userId = ? AND w.kind = 'shared'`,
      [id],
    );
    for (const { workspaceId } of shared) assertNotLastManager(db, workspaceId, id);
    db.run(`DELETE FROM workspaces WHERE createdBy = ? AND kind = 'personal'`, [id]);
    // identities and memberships cascade.
    sessionCache.delete(id);
    return db.run(`DELETE FROM users WHERE id = ?`, [id]).changes > 0;
  });
}

// Owner → admin, target → owner, both sessions revoked. Only the owner may.
export async function transferOwnership(ctx, toUserId) {
  assertCtx(ctx);
  const db = await getAdapter();
  return db.transaction(() => {
    const from = requireRow(db, ctx.userId);
    if (from.instanceRole !== "owner") {
      throw new TenancyError("OWNER_IMMUTABLE", "Only the owner can transfer ownership");
    }
    const to = requireRow(db, toUserId);
    if (to.id === from.id) return getRow(db, to.id);
    if (to.status !== "active" || to.instanceRole === "pending") {
      throw new TenancyError("INVALID", "The new owner must be an active, approved user");
    }
    const now = new Date().toISOString();
    const sql = `UPDATE users SET instanceRole = ?, updatedAt = ?, sessionVersion = sessionVersion + 1 WHERE id = ?`;
    // Demote first: idx_users_owner allows one owner at a time.
    db.run(sql, ["admin", now, from.id]);
    db.run(sql, ["owner", now, to.id]);
    sessionCache.delete(from.id);
    sessionCache.delete(to.id);
    return getRow(db, to.id);
  });
}
