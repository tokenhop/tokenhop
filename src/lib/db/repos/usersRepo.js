// Users (YAN-353, ADR-0002/0003). Invariants live here, not in the UI:
// exactly one owner, changed only by transferOwnership; the owner can't be
// deleted, disabled or demoted; deleting a user can't leave a shared
// workspace without an owner/manager. `passwordHash` never leaves this repo
// except through getUserPasswordHashUnscoped.
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { TenancyError, assertCtx, mapConstraintErrors } from "@/lib/users/errors.js";
import { assertNotLastManager } from "./membershipsRepo.js";
import { revokeUserApiKeysSync } from "./apiKeysRepo.js";
import { getSettings } from "./settingsRepo.js";
import { setMetaSync } from "../helpers/metaStore.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { adoptOwnerlessRowsUnscoped } from "./ownership.js";
import { audit } from "@/lib/users/audit.js";

const COLS =
  "id, email, username, displayName, instanceRole, status, sessionVersion, mustChangePassword, createdAt, updatedAt, lastLoginAt";
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

// Session validation reads (ADR-0004), asked by the guard on every request:
// cached <= 5 s and dropped by every write in this repo that changes them, so
// revocation lands on the next request.
// ponytail: single process. Another process sharing DATA_DIR sees a bump only
// when its entry expires (<= 5 s); a sessions table or shared invalidation lifts that.
const SESSION_TTL_MS = 5000;
const SESSION_COLS = "id, instanceRole, status, sessionVersion, mustChangePassword";
const ACTIVE_COUNT = Symbol.for("tokenhop.activeUserCount");
// On globalThis: Next bundles the proxy and route handlers separately, each with
// its own copy of this module, and a bump in a route must reach the guard's cache.
globalThis.__tokenhopSessionCache ??= new Map();
const sessionCache = globalThis.__tokenhopSessionCache;

function cached(key, read) {
  const hit = sessionCache.get(key);
  if (hit && Date.now() - hit.at < SESSION_TTL_MS) return hit.value;
  const value = read();
  sessionCache.set(key, { value, at: Date.now() });
  return value;
}

function dropSession(...ids) {
  for (const id of ids) sessionCache.delete(id);
  sessionCache.delete(ACTIVE_COUNT);
}

export async function countActiveUsersUnscoped() {
  const db = await getAdapter();
  return cached(
    ACTIVE_COUNT,
    () => db.get(`SELECT COUNT(*) AS n FROM users WHERE status = 'active'`)?.n ?? 0,
  );
}

/** `{ id, instanceRole, status, sessionVersion, mustChangePassword }` or null. */
export async function getSessionUserUnscoped(id) {
  const db = await getAdapter();
  return cached(id, () => db.get(`SELECT ${SESSION_COLS} FROM users WHERE id = ?`, [id]) ?? null);
}

export async function bumpSessionVersion(id) {
  const db = await getAdapter();
  const changed = db.run(
    `UPDATE users SET sessionVersion = sessionVersion + 1, updatedAt = ? WHERE id = ?`,
    [new Date().toISOString(), id],
  ).changes;
  dropSession(id);
  return changed > 0;
}

export async function getUserPasswordHashUnscoped(id) {
  const db = await getAdapter();
  return db.get(`SELECT passwordHash FROM users WHERE id = ?`, [id])?.passwordHash ?? null;
}

/**
 * YAN-358 login lookup: users whose email OR username equals `login`
 * (trimmed, case-insensitive). At most 2 rows so the caller can refuse an
 * ambiguous identifier. No `passwordHash` — read it with getUserPasswordHashUnscoped.
 */
export async function findUsersByLoginUnscoped(login) {
  const id = typeof login === "string" ? login.trim() : "";
  if (!id) return [];
  const db = await getAdapter();
  return db.all(
    `SELECT ${COLS} FROM users WHERE email = ? COLLATE NOCASE OR username = ? COLLATE NOCASE ORDER BY createdAt ASC LIMIT 2`,
    [id, id],
  );
}

/**
 * YAN-358 credential write, one transaction: recheck `expectedSessionVersion`
 * (STALE on mismatch, nothing written), set hash + mustChangePassword, bump
 * sessionVersion once, and mirror the owner's `settings.password` so the two
 * stores never split. Caller hashes first (async) — this part is sync.
 * @param {string} id
 * @param {{ passwordHash: string, mustChangePassword?: boolean, expectedSessionVersion?: number }} p
 */
export async function setUserPasswordUnscoped(
  id,
  { passwordHash, mustChangePassword = false, expectedSessionVersion } = {},
) {
  // null only for the owner reset (CLI): clears the hash, login falls back to
  // INITIAL_PASSWORD/default and the flag forces a new password.
  if (passwordHash !== null && (typeof passwordHash !== "string" || !passwordHash)) {
    throw new TenancyError("INVALID", "passwordHash is required");
  }
  const db = await getAdapter();
  try {
    return mapConstraintErrors(() =>
      db.transaction(() => {
        const row = requireRow(db, id);
        if (expectedSessionVersion !== undefined && row.sessionVersion !== expectedSessionVersion) {
          throw new TenancyError("STALE", "Session is out of date");
        }
        const now = new Date().toISOString();
        db.run(
          `UPDATE users SET passwordHash = ?, mustChangePassword = ?, sessionVersion = sessionVersion + 1, updatedAt = ? WHERE id = ?`,
          [passwordHash, mustChangePassword ? 1 : 0, now, id],
        );
        if (row.instanceRole === "owner") {
          // Same read-merge-write as settingsRepo.updateSettings, inside this tx.
          const s = db.get(`SELECT data FROM settings WHERE id = 1`);
          const next = { ...(s ? parseJson(s.data, {}) : {}), password: passwordHash };
          db.run(
            `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
            [stringifyJson(next)],
          );
        }
        return getRow(db, id);
      }),
    );
  } finally {
    dropSession(id);
  }
}

// YAN-356: while login is off every request acts as the owner, so a second
// active user is refused (created or re-activated). The bootstrap bypasses it.
async function assertNotSingleUserMode(db, status, exceptId = null) {
  if (status !== "active" || (await getSettings())?.requireLogin !== false) return;
  const n = db.get(`SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND id IS NOT ?`, [
    exceptId,
  ])?.n;
  if (n >= 1) {
    throw new TenancyError("SINGLE_USER_MODE", "Turn on Require login before adding a second user");
  }
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
  await assertNotSingleUserMode(db, status);
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
      dropSession(id);
      return { ...getRow(db, id), personalWorkspaceId: wsId };
    }),
  );
}

export async function updateUserUnscoped(id, patch = {}) {
  const db = await getAdapter();
  if (patch.status === "active") await assertNotSingleUserMode(db, "active", id);
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
      const now = new Date().toISOString();
      db.run(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, [...Object.values(next), now, id]);
      if (next.status === "disabled") revokeUserApiKeysSync(db, id, { now });
      dropSession(id);
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
    dropSession(id);
    return db.run(`DELETE FROM users WHERE id = ?`, [id]).changes > 0;
  });
}

/**
 * YAN-356 bootstrap (ADR-0003), one transaction: the owner (username "owner",
 * the settings password hash), their personal workspace, a `password`
 * identity, and the shared "Default" workspace, whose id goes to
 * `_meta.defaultWorkspaceId`. A second run fails on idx_users_owner
 * (OWNER_EXISTS). Bypasses the single-user refusal: it creates the first user.
 * @param {{ passwordHash?: string|null }} [opts]
 */
export async function bootstrapOwnerUnscoped({ passwordHash } = {}) {
  const db = await getAdapter();
  const owner = await mapConstraintErrors(() =>
    db.transaction(() => {
      const now = new Date().toISOString();
      const id = uuidv4();
      db.run(
        `INSERT INTO users(id, username, instanceRole, status, passwordHash, mustChangePassword, createdAt, updatedAt) VALUES(?, 'owner', 'owner', 'active', ?, ?, ?, ?)`,
        [id, passwordHash ?? null, passwordHash == null ? 1 : 0, now, now],
      );
      const workspaces = { Personal: "personal", Default: "shared" };
      const ids = {};
      for (const [name, kind] of Object.entries(workspaces)) {
        ids[name] = uuidv4();
        db.run(
          `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
          [ids[name], name, kind, id, now, now],
        );
        db.run(
          `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?, ?, 'owner', 'manual', ?)`,
          [ids[name], id, now],
        );
      }
      db.run(
        `INSERT INTO identities(id, userId, provider, issuer, subject, createdAt) VALUES(?, ?, 'password', '', ?, ?)`,
        [uuidv4(), id, id, now],
      );
      setMetaSync(db, "defaultWorkspaceId", ids.Default);
      adoptOwnerlessRowsUnscoped(db); // YAN-361: existing connections/nodes → Default
      dropSession(id);
      return {
        ...getRow(db, id),
        personalWorkspaceId: ids.Personal,
        defaultWorkspaceId: ids.Default,
      };
    }),
  );
  audit(
    { principal: null },
    "instance.bootstrap",
    { type: "user", id: owner.id },
    { after: { userId: owner.id, workspaceId: owner.defaultWorkspaceId } },
  );
  return owner;
}

// Owner → admin, target → owner, both sessions revoked. Only the owner may.
export async function transferOwnership(ctx, toUserId) {
  assertCtx(ctx);
  const db = await getAdapter();
  let oldOwnerId = null;
  const result = db.transaction(() => {
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
    dropSession(from.id, to.id);
    oldOwnerId = from.id;
    return getRow(db, to.id);
  });
  if (oldOwnerId) {
    audit(
      { principal: ctx },
      "instance.ownership.transfer",
      { type: "user", id: result.id },
      { before: { userId: oldOwnerId }, after: { userId: result.id } },
    );
  }
  return result;
}
