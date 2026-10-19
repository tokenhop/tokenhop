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
import { detachBudgetCarryUnscoped } from "./usageBudgetCarryRepo.js";
import { clearCredentialCache } from "../helpers/credentialStorage.js";
import { audit } from "@/lib/users/audit.js";

const COLS =
  "id, email, username, displayName, instanceRole, status, sessionVersion, mustChangePassword, createdAt, updatedAt, lastLoginAt";
// instanceRoleSource (YAN-359) is internal: read it explicitly, never via COLS.
function roleSource(db, id) {
  return (
    db.get(`SELECT instanceRoleSource FROM users WHERE id = ?`, [id])?.instanceRoleSource ?? null
  );
}
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

// Public admin-list projection: no passwordHash, sessionVersion or instanceRoleSource.
const PAGE_COLS =
  "id, email, username, displayName, instanceRole, status, mustChangePassword, createdAt, updatedAt, lastLoginAt";

const MAX_SEARCH = 100;
const LIST_ROLES = ["owner", "admin", "user", "pending"];
const LIST_STATUSES = ["active", "disabled"];

// Optional filters. Absent (null/undefined/"") means no filter; anything else
// invalid throws INVALID. Search is a literal, parameter-bound substring match:
// `\`, `%` and `_` are escaped so they never act as wildcards.
function userFilter({ search, role, status } = {}) {
  const absent = (v) => v === undefined || v === null || v === "";
  const where = [];
  const params = [];
  if (!absent(search)) {
    const q = typeof search === "string" ? search.trim() : null;
    if (q === null || q.length > MAX_SEARCH) throw new TenancyError("INVALID", "Invalid search");
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      where.push(
        `(email LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\' OR displayName LIKE ? ESCAPE '\\')`,
      );
      params.push(like, like, like);
    }
  }
  for (const [col, v, allowed] of [
    ["instanceRole", role, LIST_ROLES],
    ["status", status, LIST_STATUSES],
  ]) {
    if (absent(v)) continue;
    if (typeof v !== "string" || !allowed.includes(v)) {
      throw new TenancyError("INVALID", `Invalid ${col}`);
    }
    where.push(`${col} = ?`);
    params.push(v);
  }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

// Adds `identities` (no subject) and `workspaceCount` (all memberships,
// personal included) with one query each for the whole page: no N+1.
function enrichUsers(db, users) {
  if (!users.length) return users;
  const ids = users.map((u) => u.id);
  const marks = ids.map(() => "?").join(",");
  const byUser = new Map();
  for (const { userId, ...ident } of db.all(
    `SELECT userId, id, provider, issuer, emailAtLink, createdAt, lastLoginAt FROM identities WHERE userId IN (${marks}) ORDER BY createdAt ASC, id ASC`,
    ids,
  )) {
    if (!byUser.has(userId)) byUser.set(userId, []);
    byUser.get(userId).push(ident);
  }
  const counts = new Map(
    db
      .all(
        `SELECT userId, COUNT(*) AS c FROM memberships WHERE userId IN (${marks}) GROUP BY userId`,
        ids,
      )
      .map((r) => [r.userId, r.c]),
  );
  return users.map((u) => ({
    ...u,
    identities: byUser.get(u.id) ?? [],
    workspaceCount: counts.get(u.id) ?? 0,
  }));
}

/**
 * SQL-paginated admin user list, stable `createdAt, id` order. Same shape and
 * clamping as auditRepo.list: page >= 1, pageSize 1..100 (default 50); garbage
 * input falls back to the defaults. Optional `search`/`role`/`status` filters
 * (INVALID on bad values) feed the same WHERE for the count and the page.
 * @param {{ page?: number, pageSize?: number, search?: string, role?: string, status?: string }} [opts]
 */
export async function listUsersPageUnscoped({ page, pageSize, search, role, status } = {}) {
  const db = await getAdapter();
  const p = Number.isFinite(Number(page)) ? Math.max(1, Math.floor(page) || 1) : 1;
  const size = Number.isFinite(Number(pageSize))
    ? Math.min(100, Math.max(1, Math.floor(pageSize) || 50))
    : 50;
  const { sql, params } = userFilter({ search, role, status });
  const totalItems = db.get(`SELECT COUNT(*) AS c FROM users ${sql}`, params)?.c ?? 0;
  const users = db.all(
    `SELECT ${PAGE_COLS} FROM users ${sql} ORDER BY createdAt ASC, id ASC LIMIT ? OFFSET ?`,
    [...params, size, (p - 1) * size],
  );
  return {
    users: enrichUsers(db, users),
    pagination: { page: p, pageSize: size, totalItems, totalPages: Math.ceil(totalItems / size) },
  };
}

/** The same enriched admin DTO as one list row, or null when the user is gone. */
export async function getUserDetailUnscoped(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT ${PAGE_COLS} FROM users WHERE id = ?`, [id]);
  return row ? enrichUsers(db, [row])[0] : null;
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
export const SESSION_TTL_MS = 5000;
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

// YAN-359 IdP sync seam: exported cache invalidation for post-sync use, after
// the transaction commits (and conservatively on rollback). Sync helpers never
// call async wrappers inside a transaction.
export function invalidateUserSessionCacheSync(...ids) {
  dropSession(...ids);
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

/**
 * Synchronous user + personal workspace + owner membership insert. Must run
 * inside a caller-owned `db.transaction`; no await, no cache drop (caller drops
 * after commit via invalidateUserSessionCacheSync). `instanceRoleSource` is
 * internal-only (IdP sync); the public wrapper never forwards it.
 * Returns the committed-shape row plus `personalWorkspaceId`.
 */
export function createUserWithPersonalWorkspaceSync(
  db,
  {
    email,
    username,
    displayName,
    instanceRole = "pending",
    instanceRoleSource = null,
    status = "active",
    passwordHash,
  } = {},
) {
  const now = new Date().toISOString();
  const id = uuidv4();
  const wsId = uuidv4();
  const name = optText(displayName) ?? optText(username) ?? optText(email) ?? "Personal";
  db.run(
    `INSERT INTO users(id, email, username, displayName, instanceRole, instanceRoleSource, status, passwordHash, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      optText(email),
      optText(username),
      optText(displayName),
      instanceRole,
      instanceRoleSource,
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
  // Explicit field list: callers can't mass-assign instanceRoleSource.
  return mapConstraintErrors(() =>
    db.transaction(() => {
      const created = createUserWithPersonalWorkspaceSync(db, {
        email,
        username,
        displayName,
        instanceRole,
        status,
        passwordHash,
      });
      dropSession(created.id);
      return created;
    }),
  );
}

// Throws LAST_MANAGER if removing user `id` from service (disable or delete)
// would leave any shared workspace without an active owner/manager.
function assertNotLastSharedManager(db, id) {
  const shared = db.all(
    `SELECT m.workspaceId FROM memberships m JOIN workspaces w ON w.id = m.workspaceId WHERE m.userId = ? AND w.kind = 'shared'`,
    [id],
  );
  for (const { workspaceId } of shared) assertNotLastManager(db, workspaceId, id);
}

// Allow-lists mirror the schema CHECKs; 'owner' stays so the OWNER_IMMUTABLE
// guard (transfer-only) answers instead of a generic INVALID.
const ROLES = ["owner", "admin", "user", "pending"];
const STATUSES = ["active", "disabled"];

// Delegated-admin check, run inside the caller's sync transaction; re-reads the
// persisted actor so a stale/disabled actor fails at write time.
function assertActorAuthority(db, actorUserId, target, patch) {
  const actor = requireRow(db, actorUserId);
  if (actor.status !== "active" || !["owner", "admin"].includes(actor.instanceRole)) {
    throw new TenancyError("FORBIDDEN", "Actor must be an active owner or admin");
  }
  if (target.id === actor.id) {
    throw new TenancyError("FORBIDDEN", "Actors can't modify themselves");
  }
  if (target.instanceRole === "owner") {
    throw new TenancyError("FORBIDDEN", "The owner is managed by ownership transfer");
  }
  if (actor.instanceRole === "admin") {
    if (target.instanceRole === "admin") {
      throw new TenancyError("FORBIDDEN", "Admins can only manage users and pending users");
    }
    if (patch?.instanceRole === "admin") {
      throw new TenancyError("FORBIDDEN", "Only the owner can grant the admin role");
    }
  }
}

export async function updateUserUnscoped(id, patch = {}, options = {}) {
  if (Object.hasOwn(patch, "instanceRole") && !ROLES.includes(patch.instanceRole)) {
    throw new TenancyError("INVALID", "Invalid instanceRole");
  }
  if (Object.hasOwn(patch, "status") && !STATUSES.includes(patch.status)) {
    throw new TenancyError("INVALID", "Invalid status");
  }
  const db = await getAdapter();
  if (patch.status === "active") await assertNotSingleUserMode(db, "active", id);
  return mapConstraintErrors(() =>
    db.transaction(() => {
      const row = requireRow(db, id);
      if (options.actorUserId != null) assertActorAuthority(db, options.actorUserId, row, patch);
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
      // YAN-360: disabling or demoting to pending removes effective management,
      // so neither may leave a shared workspace without an effective manager.
      const losesManagement =
        (next.status === "disabled" && row.status !== "disabled") ||
        (next.instanceRole === "pending" && row.instanceRole !== "pending");
      if (losesManagement) assertNotLastSharedManager(db, id);

      // YAN-359: an explicit manual instanceRole (even same-role) makes the role
      // manual. Clearing non-null provenance is a security change: one sv bump,
      // combined with any role/status/password change below.
      const clearsSource = Object.hasOwn(next, "instanceRole") && roleSource(db, id) !== null;
      const bump =
        (Object.hasOwn(next, "instanceRole") && next.instanceRole !== row.instanceRole) ||
        (Object.hasOwn(next, "status") && next.status !== row.status) ||
        Object.hasOwn(next, "passwordHash") ||
        clearsSource;
      const sets = Object.keys(next).map((k) => `${k} = ?`);
      const values = Object.values(next);
      if (clearsSource) sets.push("instanceRoleSource = NULL");
      sets.push("updatedAt = ?");
      if (bump) sets.push("sessionVersion = sessionVersion + 1");
      const now = new Date().toISOString();
      db.run(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, [...values, now, id]);
      if (next.status === "disabled") revokeUserApiKeysSync(db, id, { now });
      dropSession(id);
      return getRow(db, id);
    }),
  );
}

/**
 * Admin "sign out everywhere" for another user: one transaction re-reads actor
 * and target, applies the same hierarchy as every other admin mutation (no
 * self, owner immutable, admin can't target admin) and bumps the target's
 * sessionVersion once. Nothing else changes: API keys and the actor's own
 * sessions stay valid. The session cache is dropped after commit.
 */
export async function revokeUserSessionsUnscoped(id, { actorUserId } = {}) {
  if (!actorUserId) throw new TenancyError("FORBIDDEN", "Actor must be an active owner or admin");
  const db = await getAdapter();
  try {
    return db.transaction(() => {
      const target = requireRow(db, id);
      assertActorAuthority(db, actorUserId, target);
      db.run(`UPDATE users SET sessionVersion = sessionVersion + 1, updatedAt = ? WHERE id = ?`, [
        new Date().toISOString(),
        id,
      ]);
      return true;
    });
  } finally {
    dropSession(id);
  }
}

export async function deleteUserUnscoped(id, options = {}) {
  const db = await getAdapter();
  let deletedPersonal = [];
  const result = db.transaction(() => {
    const row = requireRow(db, id);
    if (options.actorUserId != null) assertActorAuthority(db, options.actorUserId, row);
    if (row.instanceRole === "owner") {
      throw new TenancyError("OWNER_IMMUTABLE", "Transfer ownership before deleting the owner");
    }
    assertNotLastSharedManager(db, id);
    // kv has no FK to workspaces: drop scoped `ws:<id>/` rows (exact prefix) first.
    const personal = db.all(`SELECT id FROM workspaces WHERE createdBy = ? AND kind = 'personal'`, [
      id,
    ]);
    for (const { id: wsId } of personal) {
      const prefix = `ws:${wsId}/`;
      db.run(`DELETE FROM kv WHERE substr(key, 1, ?) = ?`, [prefix.length, prefix]);
    }
    // YAN-424: usageHistory FKs go SET NULL; the pruned-spend carry follows.
    for (const { id: wsId } of personal) detachBudgetCarryUnscoped(db, "workspaceId", wsId);
    detachBudgetCarryUnscoped(db, "userId", id);
    db.run(`DELETE FROM workspaces WHERE createdBy = ? AND kind = 'personal'`, [id]);
    // identities and memberships cascade.
    dropSession(id);
    const removed = db.run(`DELETE FROM users WHERE id = ?`, [id]).changes > 0;
    deletedPersonal = personal.map((p) => p.id);
    return removed;
  });
  // Post-commit: purge each deleted personal workspace's DEK from the cache.
  for (const wsId of deletedPersonal) clearCredentialCache(db, wsId);
  return result;
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
// `options.expectedSessionVersion` binds a fresh credential proof to the live
// actor row read inside this transaction (STALE on mismatch, nothing written).
export async function transferOwnership(ctx, toUserId, options = {}) {
  assertCtx(ctx);
  const db = await getAdapter();
  let oldOwnerId = null;
  const result = db.transaction(() => {
    const from = requireRow(db, ctx.userId);
    if (from.instanceRole !== "owner" || from.status !== "active") {
      throw new TenancyError("OWNER_IMMUTABLE", "Only the owner can transfer ownership");
    }
    if (
      options.expectedSessionVersion !== undefined &&
      from.sessionVersion !== options.expectedSessionVersion
    ) {
      throw new TenancyError("STALE", "Session is out of date");
    }
    const to = requireRow(db, toUserId);
    if (to.id === from.id) return getRow(db, to.id);
    if (to.status !== "active" || to.instanceRole === "pending") {
      throw new TenancyError("INVALID", "The new owner must be an active, approved user");
    }
    const now = new Date().toISOString();
    // Both rows leave IdP provenance: owner and demoted admin are manual.
    const sql = `UPDATE users SET instanceRole = ?, instanceRoleSource = NULL, updatedAt = ?, sessionVersion = sessionVersion + 1 WHERE id = ?`;
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
