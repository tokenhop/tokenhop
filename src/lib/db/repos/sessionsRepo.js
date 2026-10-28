// Device sessions (YAN-751): one row per login, keyed by the non-secret `sid`
// JWT claim. Timestamps are ISO strings so string comparison orders correctly.
import { getAdapter } from "../driver.js";
import { TenancyError, assertCtx } from "@/lib/users/errors.js";
import {
  SESSION_CACHE_TTL_MS,
  dropSessionCache as dropCache,
  invalidateSessionCache,
  lastTouch,
  sessionCache,
  sessionCacheKey as cacheKey,
} from "../helpers/sessionCache.js";

export { invalidateSessionCache };

const MAX_ACTIVE_PER_USER = 50;
const TOUCH_WINDOW_MS = 5 * 60 * 1000;
const CACHE_MAX = 5000;
const REVOKED_RETENTION_MS = 60 * 60 * 1000;

/**
 * Insert a session row for a fresh login (or a legacy-token adoption). Runs in
 * one transaction: sweeps this user's expired rows, drops the row being
 * replaced, inserts, then evicts the least recently used rows above the per-user cap.
 * Insert errors propagate: the caller must fail the login.
 */
export async function createSessionUnscoped({
  id,
  userId,
  sv,
  amr = null,
  userAgent = null,
  ip = null,
  createdAt,
  expiresAt,
  replacesId = null,
}) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const dropped = [id];
  db.transaction(() => {
    db.run(`DELETE FROM sessions WHERE userId = ? AND expiresAt <= ?`, [userId, now]);
    // Revoked rows stay visible briefly (cache/audit), then go.
    db.run(`DELETE FROM sessions WHERE userId = ? AND revokedAt IS NOT NULL AND revokedAt < ?`, [
      userId,
      new Date(Date.now() - REVOKED_RETENTION_MS).toISOString(),
    ]);
    if (typeof replacesId === "string" && replacesId) {
      db.run(`DELETE FROM sessions WHERE id = ? AND userId = ?`, [replacesId, userId]);
      dropped.push(replacesId);
    }
    db.run(
      `INSERT INTO sessions (id, userId, sv, amr, userAgent, ip, createdAt, lastSeenAt, expiresAt, revokedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      [id, userId, sv, amr, userAgent, ip, createdAt ?? now, expiresAt],
    );
    const active = db.all(
      `SELECT id FROM sessions WHERE userId = ? AND revokedAt IS NULL AND expiresAt > ? AND id != ?
       ORDER BY COALESCE(lastSeenAt, createdAt) ASC, rowid ASC`,
      [userId, now, id],
    );
    // The just-inserted row counts toward the cap but is never evicted.
    const excess = active.length + 1 - MAX_ACTIVE_PER_USER;
    for (let i = 0; i < excess; i++) {
      db.run(`DELETE FROM sessions WHERE id = ? AND userId = ?`, [active[i].id, userId]);
      dropped.push(active[i].id);
    }
  });
  dropCache(...dropped);
}

export async function getSessionForValidationUnscoped(id) {
  if (typeof id !== "string" || !id) return null;
  const key = cacheKey(id);
  const hit = sessionCache.get(key);
  if (hit && Date.now() - hit.at < SESSION_CACHE_TTL_MS) return hit.value;
  const db = await getAdapter();
  const row = db.get(`SELECT id, userId, sv, expiresAt, revokedAt FROM sessions WHERE id = ?`, [
    id,
  ]);
  if (!row) return null;
  if (sessionCache.size >= CACHE_MAX) sessionCache.clear();
  sessionCache.set(key, { value: row, at: Date.now() });
  return row;
}

/** Best-effort lastSeenAt bump, at most once per 5-minute window per sid. */
export async function touchSessionUnscoped(id) {
  if (typeof id !== "string" || !id) return;
  const nowMs = Date.now();
  const memo = lastTouch.get(id);
  if (memo !== undefined && nowMs - memo < TOUCH_WINDOW_MS) return;
  const db = await getAdapter();
  if (lastTouch.size >= CACHE_MAX) lastTouch.clear();
  lastTouch.set(id, nowMs);
  db.run(
    `UPDATE sessions SET lastSeenAt = ?
     WHERE id = ? AND revokedAt IS NULL AND (lastSeenAt IS NULL OR lastSeenAt < ?)`,
    [new Date(nowMs).toISOString(), id, new Date(nowMs - TOUCH_WINDOW_MS).toISOString()],
  );
}

/**
 * Re-mint path: move a live row from `expectedSv` (the sv on the cookie being
 * replaced) to the new `sv`. Compare-and-set: false when revoked/expired/foreign
 * or the row's sv no longer matches, so a concurrent rewrite fails closed.
 */
export async function rebindSessionUnscoped(id, userId, expectedSv, sv) {
  if (!Number.isInteger(expectedSv)) return false;
  const db = await getAdapter();
  const { changes } = db.run(
    `UPDATE sessions SET sv = ?
     WHERE id = ? AND userId = ? AND sv = ? AND revokedAt IS NULL AND expiresAt > ?`,
    [sv, id, userId, expectedSv, new Date().toISOString()],
  );
  dropCache(id);
  return changes > 0;
}

export async function listSessions(ctx) {
  assertCtx(ctx);
  const db = await getAdapter();
  // s.sv = u.sessionVersion hides rows made stale by "sign out everywhere".
  return db.all(
    `SELECT s.id, s.amr, s.userAgent, s.ip, s.createdAt, s.lastSeenAt, s.expiresAt
     FROM sessions s JOIN users u ON u.id = s.userId
     WHERE s.userId = ? AND s.revokedAt IS NULL AND s.expiresAt > ? AND s.sv = u.sessionVersion
     ORDER BY COALESCE(s.lastSeenAt, s.createdAt) DESC`,
    [ctx.userId, new Date().toISOString()],
  );
}

const REVOKE_SQL = `UPDATE sessions SET revokedAt = ?
  WHERE id = ? AND userId = ? AND revokedAt IS NULL AND expiresAt > ?`;

/** Uniform NOT_FOUND: foreign, unknown, expired, revoked and malformed ids look the same. */
export async function revokeSession(ctx, id) {
  assertCtx(ctx);
  const db = await getAdapter();
  const now = new Date().toISOString();
  const { changes } = db.run(REVOKE_SQL, [now, String(id), ctx.userId, now]);
  dropCache(String(id));
  if (changes === 0) throw new TenancyError("NOT_FOUND", "Session not found");
}

/** Logout path (D4): best-effort, never throws on a missing row. */
export async function revokeSessionUnscoped(id, userId) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const { changes } = db.run(REVOKE_SQL, [now, String(id), userId, now]);
  dropCache(String(id));
  return changes > 0;
}

export async function pruneExpiredSessionsUnscoped(nowIso) {
  const db = await getAdapter();
  const { changes } = db.run(`DELETE FROM sessions WHERE expiresAt < ?`, [nowIso]);
  invalidateSessionCache();
  return changes;
}
