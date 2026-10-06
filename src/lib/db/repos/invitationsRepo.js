// Workspace invitations (YAN-360). Single-use hashed tokens: only the
// SHA-256 hex of the token is stored, the raw token is returned exactly once
// at mint and never appears in lists, rows or logs. State is derived from
// the timestamps — no mutable status column. Authority is live in-transaction
// actor state (same shape as membershipsRepo.managedWorkspace): pending
// instance users are forbidden, non-members get NOT_FOUND. The `*Sync` seams
// are trusted, token-authorized, and run inside a caller-owned transaction.
import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { TenancyError, assertCtx, mapConstraintErrors } from "@/lib/users/errors.js";
import { mayGrantManager, mayManage, membershipRole } from "./membershipsRepo.js";

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ROLES = ["manager", "member", "viewer"];
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const sha256hex = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

/** SHA-256 hex of a presented token (accept route hashes before lookup). */
export function hashInvitationToken(token) {
  return sha256hex(token);
}

function normalizeEmail(email) {
  if (email === undefined || email === null) return null;
  const s = String(email).trim().toLowerCase();
  return s || null;
}

function stateOf(row, now) {
  if (row.consumedAt) return "consumed";
  if (row.revokedAt) return "revoked";
  if (!(row.expiresAt > now)) return "expired";
  return "live";
}

// Metadata only: tokenHash never leaves this repo.
function toPublic(row, now = new Date().toISOString()) {
  const { tokenHash: _drop, ...rest } = row;
  return { ...rest, state: stateOf(row, now) };
}

function requireSharedWorkspace(db, workspaceId) {
  const ws = db.get(`SELECT id, kind FROM workspaces WHERE id = ?`, [workspaceId]);
  if (!ws) throw new TenancyError("NOT_FOUND", "Workspace not found");
  if (ws.kind !== "shared") {
    throw new TenancyError("PERSONAL_WORKSPACE", "Personal workspaces can't have invitations");
  }
  return ws;
}

// Live management authority (mirrors membershipsRepo.managedWorkspace):
// pending instance users are forbidden even with a workspace row; workspace
// owner/manager or an active instance admin/owner may manage invitations;
// others get NOT_FOUND (the workspace stays invisible).
function requireManager(db, ctx, workspaceId) {
  assertCtx(ctx);
  const user = db.get(`SELECT instanceRole, status FROM users WHERE id = ?`, [ctx.userId]);
  const actor = {
    workspaceRole: membershipRole(db, workspaceId, ctx.userId),
    instanceRole: user?.instanceRole ?? null,
    status: user?.status ?? null,
  };
  if (actor.instanceRole === "pending") {
    throw new TenancyError("FORBIDDEN", "Pending users can't manage invitations");
  }
  const elevated = actor.status === "active" && mayGrantManager(actor);
  if (!actor.workspaceRole && !elevated) throw new TenancyError("NOT_FOUND", "Workspace not found");
  if (!elevated) {
    if (actor.status !== "active" || !mayManage(actor.workspaceRole)) {
      throw new TenancyError("FORBIDDEN", "Only owners and managers may manage invitations");
    }
  }
  return actor;
}

/**
 * Mint an invitation. Authority is the caller's live in-transaction actor
 * state — never a caller-supplied grantor snapshot. Returns metadata + the
 * raw `token` exactly once — the raw value is never stored.
 */
export async function createInvitation(ctx, { workspaceId, role, email = null, now } = {}) {
  assertCtx(ctx);
  if (typeof workspaceId !== "string" || !workspaceId) {
    throw new TenancyError("INVALID", "workspaceId is required");
  }
  if (!ROLES.includes(role)) throw new TenancyError("INVALID", "Invalid role");
  const db = await getAdapter();
  return mapConstraintErrors(() =>
    db.transaction(() => {
      const actor = requireManager(db, ctx, workspaceId);
      requireSharedWorkspace(db, workspaceId);
      if (role === "manager" && !mayGrantManager(actor)) {
        throw new TenancyError(
          "FORBIDDEN",
          "Only the workspace owner or an instance admin may grant the manager role",
        );
      }
      const at = now ?? new Date().toISOString();
      const token = crypto.randomBytes(32).toString("base64url");
      const row = {
        id: uuidv4(),
        workspaceId,
        role,
        email: normalizeEmail(email),
        tokenHash: sha256hex(token),
        createdByUserId: ctx.userId,
        createdAt: at,
        expiresAt: new Date(new Date(at).getTime() + INVITATION_TTL_MS).toISOString(),
        consumedAt: null,
        consumedByUserId: null,
        revokedAt: null,
      };
      db.run(
        `INSERT INTO invitations(id, workspaceId, role, email, tokenHash, createdByUserId, createdAt, expiresAt, consumedAt, consumedByUserId, revokedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.workspaceId,
          row.role,
          row.email,
          row.tokenHash,
          row.createdByUserId,
          row.createdAt,
          row.expiresAt,
          row.consumedAt,
          row.consumedByUserId,
          row.revokedAt,
        ],
      );
      return { invitation: toPublic(row, at), token };
    }),
  );
}

/** Scoped metadata list (no token/hash), newest last. */
export async function listInvitations(ctx, workspaceId) {
  assertCtx(ctx);
  const db = await getAdapter();
  requireManager(db, ctx, workspaceId);
  requireSharedWorkspace(db, workspaceId);
  const now = new Date().toISOString();
  return db
    .all(
      `SELECT id, workspaceId, role, email, createdByUserId, createdAt, expiresAt, consumedAt, consumedByUserId, revokedAt FROM invitations WHERE workspaceId = ? ORDER BY createdAt ASC, id ASC`,
      [workspaceId],
    )
    .map((r) => toPublic(r, now));
}

/**
 * Revoke an invitation. Idempotent: already terminal (revoked/consumed)
 * rows return success without a write — revoke never unconsumes.
 * `expectedWorkspaceId` (when set) is checked before any write: the row's
 * workspace must equal it, else NOT_FOUND with no state change.
 */
export async function revokeInvitation(ctx, inviteId, { expectedWorkspaceId = null } = {}) {
  assertCtx(ctx);
  const db = await getAdapter();
  const now = new Date().toISOString();
  return db.transaction(() => {
    const row = db.get(`SELECT * FROM invitations WHERE id = ?`, [inviteId]);
    if (!row) throw new TenancyError("NOT_FOUND", "Invitation not found");
    // Same NOT_FOUND as a missing row: a foreign-workspace id stays invisible.
    if (expectedWorkspaceId !== null && row.workspaceId !== expectedWorkspaceId) {
      throw new TenancyError("NOT_FOUND", "Invitation not found");
    }
    requireManager(db, ctx, row.workspaceId);
    requireSharedWorkspace(db, row.workspaceId);
    if (row.revokedAt || row.consumedAt) return toPublic(row, now);
    db.run(`UPDATE invitations SET revokedAt = ? WHERE id = ?`, [now, inviteId]);
    return toPublic({ ...row, revokedAt: now }, now);
  });
}

// ─── Caller-owned sync seams (accept service runs these in one tx) ───

function readByToken(db, token) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) {
    throw new TenancyError("INVALID", "Invalid invitation token");
  }
  const given = crypto.createHash("sha256").update(token, "utf8").digest();
  const row = db.get(`SELECT * FROM invitations WHERE tokenHash = ?`, [given.toString("hex")]);
  if (!row) throw new TenancyError("INVALID", "Invalid invitation token");
  const stored = Buffer.from(row.tokenHash, "hex");
  if (stored.length !== given.length || !crypto.timingSafeEqual(stored, given)) {
    throw new TenancyError("INVALID", "Invalid invitation token");
  }
  return row;
}

/**
 * Re-read an invite inside the caller's transaction (full internal row,
 * including tokenHash — never return this to clients). Throws INVALID on
 * unknown/malformed tokens.
 */
export function getInvitationForConsumeSync(db, token) {
  return readByToken(db, token);
}

/**
 * Validate single-use / revocation / expiry / email binding, then consume
 * with a conditional update — `changes === 1` is the single-winner gate, so
 * a lost race throws and the caller's tx rolls back with nothing consumed.
 */
export function consumeInvitationSync(
  db,
  token,
  { email = null, consumedByUserId = null, now } = {},
) {
  const at = now ?? new Date().toISOString();
  const row = readByToken(db, token);
  if (row.consumedAt || row.revokedAt || !(row.expiresAt > at)) {
    throw new TenancyError("INVALID", "Invalid invitation token");
  }
  if (row.email !== null && normalizeEmail(email) !== row.email) {
    throw new TenancyError("INVALID", "Invalid invitation token");
  }
  const { changes } = db.run(
    `UPDATE invitations SET consumedAt = ?, consumedByUserId = ? WHERE id = ? AND consumedAt IS NULL AND revokedAt IS NULL AND expiresAt > ?`,
    [at, consumedByUserId ?? null, row.id, at],
  );
  if (changes !== 1) throw new TenancyError("INVALID", "Invalid invitation token");
  return toPublic({ ...row, consumedAt: at, consumedByUserId: consumedByUserId ?? null }, at);
}
