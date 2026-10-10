// YAN-701 workspace move: input validation, typed errors and the live
// authorization read shared by the plan and apply halves. Nothing here
// mutates the database.
import { membershipRole } from "../db/repos/membershipsRepo.js";
import { can } from "./principal.js";

export const MOVE_TYPES = [
  "connection",
  "node",
  "combo",
  "alias",
  "customModel",
  "disabledModel",
  "apiKey",
];
export const MAX_ITEMS = 500;
const MAX_ID = 512;

// Capability needed per item type, in BOTH the source and the target workspace.
const CAPABILITY_OF = {
  connection: "workspace.connections.manage",
  node: "workspace.connections.manage",
  combo: "workspace.combos.manage",
  alias: "workspace.combos.manage",
  customModel: "workspace.combos.manage",
  disabledModel: "workspace.combos.manage",
  apiKey: "workspace.keys.manage",
};

export function moveError(code, message, extra = {}) {
  throw Object.assign(new Error(message), { code, ...extra });
}

const isId = (v) => typeof v === "string" && v.length > 0 && v.length <= MAX_ID;

/** Strict, copied input: unknown item keys, duplicates and oversize lists are INVALID. */
export function validateMoveInput(input) {
  const { sourceWorkspaceId, targetWorkspaceId, items } = input ?? {};
  if (
    !isId(sourceWorkspaceId) ||
    !isId(targetWorkspaceId) ||
    sourceWorkspaceId === targetWorkspaceId
  ) {
    moveError("INVALID", "Invalid move request");
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
    moveError("INVALID", "Invalid move request");
  }
  const seen = new Set();
  const clean = items.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).some((k) => k !== "type" && k !== "id") ||
      !MOVE_TYPES.includes(item.type) ||
      !isId(item.id)
    ) {
      moveError("INVALID", "Invalid move request");
    }
    const key = `${item.type}\u0000${item.id}`;
    if (seen.has(key)) moveError("INVALID", "Invalid move request");
    seen.add(key);
    return { type: item.type, id: item.id };
  });
  return { sourceWorkspaceId, targetWorkspaceId, items: clean };
}

/** Live snapshot of the user's authority in one workspace; non-member reads as NOT_FOUND. */
function liveAccess(db, userId, workspaceId) {
  const user = db.get(`SELECT instanceRole, status FROM users WHERE id = ?`, [userId]);
  const ws = db.get(`SELECT id, kind FROM workspaces WHERE id = ?`, [workspaceId]);
  const role = user?.status === "active" && ws ? membershipRole(db, workspaceId, userId) : null;
  if (!role) moveError("NOT_FOUND", "Workspace not found");
  const live = { instanceRole: user.instanceRole, workspaceRoles: { [workspaceId]: role } };
  return {
    id: workspaceId,
    kind: ws.kind,
    allowed: (capability) => can(live, capability, { workspaceId }),
  };
}

/**
 * Session-only, no admin bypass: the actor must be a live member of BOTH
 * workspaces (else NOT_FOUND, no existence leak) holding every capability the
 * requested item types need in BOTH (else FORBIDDEN). Re-read from the DB on
 * every call; the ctx role snapshot is never trusted.
 */
export function authorizeMove(db, ctx, sourceId, targetId, items) {
  if (ctx?.via !== "session" || ctx.apiKeyId != null || typeof ctx.userId !== "string") {
    moveError("FORBIDDEN", "Forbidden");
  }
  const source = liveAccess(db, ctx.userId, sourceId);
  const target = liveAccess(db, ctx.userId, targetId);
  for (const capability of new Set(items.map((i) => CAPABILITY_OF[i.type]))) {
    if (!source.allowed(capability) || !target.allowed(capability)) {
      moveError("FORBIDDEN", "Forbidden");
    }
  }
  return { source, target };
}
