// Workspace memberships (YAN-353, hardened YAN-360). Scoped reads: the
// principal must belong to the workspace. Manual mutators (add/update/remove)
// re-verify authority live inside the transaction: the actor must be an active
// owner/manager of that workspace, or an active instance admin/owner; only the
// workspace owner or an instance admin may grant `manager`; `owner` rows are
// bootstrap-only. `source` is server-controlled (manual APIs never write
// `idp`), and `source='idp'` rows are read-only to manual mutators — SSO sync
// (`syncIdpMembershipsSync`) owns those rows exclusively.
import { getAdapter } from "../driver.js";
import { revokeUserApiKeysSync } from "./apiKeysRepo.js";
import { TenancyError, assertCtx, mapConstraintErrors } from "@/lib/users/errors.js";
import { audit } from "@/lib/users/audit.js";

const mTarget = (workspaceId, userId) => ({ type: "membership", id: `${workspaceId}:${userId}` });

const MANAGER_ROLES = ["owner", "manager"];

// Roles a manual mutation may grant. `owner` membership rows are created only
// by bootstrap/personal-workspace creation; the repo seam never grants them.
const MANAGED_ROLES = ["manager", "member", "viewer"];

/** True when a workspace role may manage members (YAN-360 handler seam). */
export function mayManage(role) {
  return MANAGER_ROLES.includes(role);
}

/** True when the actor may grant the `manager` role (YAN-360 handler seam). */
export function mayGrantManager({ workspaceRole = null, instanceRole = null } = {}) {
  return workspaceRole === "owner" || instanceRole === "owner" || instanceRole === "admin";
}

// ─── Internal helpers (sync, inside a transaction; not exported via the barrel) ───
export function membershipRole(db, workspaceId, userId) {
  return (
    db.get(`SELECT role FROM memberships WHERE workspaceId = ? AND userId = ?`, [
      workspaceId,
      userId,
    ])?.role ?? null
  );
}

// Throws LAST_MANAGER when `userId` is the workspace's only EFFECTIVE owner/manager
// (YAN-360: disabled or pending managers can't manage, so they don't count).
export function assertNotLastManager(db, workspaceId, userId) {
  if (!MANAGER_ROLES.includes(membershipRole(db, workspaceId, userId))) return;
  const { c } = db.get(
    `SELECT COUNT(*) AS c FROM memberships m JOIN users u ON u.id = m.userId
     WHERE m.workspaceId = ? AND m.role IN ('owner', 'manager') AND m.userId != ?
       AND u.status = 'active' AND u.instanceRole != 'pending'`,
    [workspaceId, userId],
  );
  if (c === 0) {
    throw new TenancyError("LAST_MANAGER", "A workspace needs at least one owner or manager");
  }
}

const IDP_ROLES = ["manager", "member", "viewer"];

/**
 * Reconcile a user's `source='idp'` memberships to `wanted` ([{ workspaceId, role }]).
 * Sync, no own tx: the caller owns the transaction (and one sessionVersion bump +
 * cache drop after commit when `changed`). manual/invite rows are never touched.
 * Throws TenancyError INVALID/LAST_MANAGER; everything is validated and guarded
 * before the first write. Returns safe deltas (ids and roles only).
 * ponytail: duplicate workspaceIds are rejected, caller resolves the highest role.
 */
export function syncIdpMembershipsSync(db, userId, wanted) {
  const bad = (msg) => new TenancyError("INVALID", msg);
  if (typeof userId !== "string" || !userId) throw bad("userId is required");
  if (!db.get(`SELECT 1 AS x FROM users WHERE id = ?`, [userId])) throw bad("Unknown user");
  if (!Array.isArray(wanted)) throw bad("wanted must be an array");

  const want = new Map();
  for (const w of wanted) {
    if (!w || typeof w !== "object") throw bad("Invalid membership entry");
    const { workspaceId, role } = w;
    if (typeof workspaceId !== "string" || !workspaceId) throw bad("Invalid workspaceId");
    if (!IDP_ROLES.includes(role)) throw bad("Invalid role");
    if (want.has(workspaceId)) throw bad("Duplicate workspaceId");
    const ws = db.get(`SELECT kind FROM workspaces WHERE id = ?`, [workspaceId]);
    if (!ws || ws.kind === "personal") throw bad("Invalid workspace");
    want.set(workspaceId, role);
  }

  const have = new Map(
    db
      .all(`SELECT workspaceId, role, source FROM memberships WHERE userId = ?`, [userId])
      .map((r) => [r.workspaceId, r]),
  );
  const added = [];
  const updated = [];
  const removed = [];
  for (const [workspaceId, role] of want) {
    const cur = have.get(workspaceId);
    if (!cur) added.push({ workspaceId, role });
    else if (cur.source === "idp" && cur.role !== role) {
      updated.push({ workspaceId, before: cur.role, after: role });
    }
  }
  for (const [workspaceId, cur] of have) {
    if (cur.source === "idp" && !want.has(workspaceId)) {
      removed.push({ workspaceId, role: cur.role });
    }
  }

  // Guards first: a throw here leaves nothing written.
  for (const u of updated) {
    if (!MANAGER_ROLES.includes(u.after)) assertNotLastManager(db, u.workspaceId, userId);
  }
  for (const r of removed) assertNotLastManager(db, r.workspaceId, userId);

  const now = new Date().toISOString();
  for (const a of added) {
    db.run(
      `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?, ?, ?, 'idp', ?)`,
      [a.workspaceId, userId, a.role, now],
    );
  }
  for (const u of updated) {
    db.run(
      `UPDATE memberships SET role = ? WHERE workspaceId = ? AND userId = ? AND source = 'idp'`,
      [u.after, u.workspaceId, userId],
    );
  }
  for (const r of removed) {
    const { changes } = db.run(
      `DELETE FROM memberships WHERE workspaceId = ? AND userId = ? AND source = 'idp'`,
      [r.workspaceId, userId],
    );
    if (changes > 0) revokeUserApiKeysSync(db, userId, { workspaceId: r.workspaceId, now });
  }
  return {
    changed: added.length + updated.length + removed.length > 0,
    added,
    updated,
    removed,
  };
}

/**
 * Trusted insert for caller-owned transactions (bootstrap, YAN-360 accept
 * service, fixtures). Accepts the full schema-valid role and source options —
 * unlike the manual mutators below, no authority or manager-grant policy runs
 * here; the caller owns those checks inside its transaction.
 */
export function addMembershipUnscoped(db, { workspaceId, userId, role, source = "manual" }) {
  if (typeof workspaceId !== "string" || !workspaceId) {
    throw new TenancyError("INVALID", "workspaceId is required");
  }
  if (typeof userId !== "string" || !userId)
    throw new TenancyError("INVALID", "userId is required");
  if (!["owner", ...MANAGED_ROLES].includes(role)) {
    throw new TenancyError("INVALID", "Invalid role");
  }
  if (!["manual", "invite", "idp"].includes(source)) {
    throw new TenancyError("INVALID", "Invalid source");
  }
  const createdAt = new Date().toISOString();
  return mapConstraintErrors(() => {
    db.run(
      `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?, ?, ?, ?, ?)`,
      [workspaceId, userId, role, source, createdAt],
    );
    return {
      workspaceId,
      userId,
      role,
      source,
      createdAt,
    };
  });
}

// Live in-transaction authority for manual mutations (YAN-360): the actor's
// workspace role and instance role are re-read here, never trusted from the
// request principal. Visibility first — a caller who is neither a member nor
// an instance admin/owner gets NOT_FOUND, so the workspace stays invisible.
// `granting` additionally validates the role being granted.
function managedWorkspace(db, ctx, workspaceId, { granting = null } = {}) {
  assertCtx(ctx);
  const ws = db.get(`SELECT id, kind FROM workspaces WHERE id = ?`, [workspaceId]);
  if (!ws) throw new TenancyError("NOT_FOUND", "Workspace not found");
  const user = db.get(`SELECT instanceRole, status FROM users WHERE id = ?`, [ctx.userId]);
  const actor = {
    workspaceRole: membershipRole(db, workspaceId, ctx.userId),
    instanceRole: user?.instanceRole ?? null,
    status: user?.status ?? null,
  };
  // Pending instance users hold no capabilities (YAN-360), even with an
  // owner workspace row (e.g. a stale pre-approval grant). They may still
  // read via memberWorkspace, so this is FORBIDDEN, not NOT_FOUND.
  if (actor.instanceRole === "pending") {
    throw new TenancyError("FORBIDDEN", "Pending users can't manage memberships");
  }
  const elevated = actor.status === "active" && mayGrantManager(actor);
  if (!actor.workspaceRole && !elevated) throw new TenancyError("NOT_FOUND", "Workspace not found");
  if (ws.kind === "personal") {
    throw new TenancyError("PERSONAL_WORKSPACE", "Personal workspaces have a single member");
  }
  if (!elevated) {
    if (actor.status !== "active") {
      throw new TenancyError("FORBIDDEN", "Disabled members can't manage memberships");
    }
    if (!mayManage(actor.workspaceRole)) {
      throw new TenancyError("FORBIDDEN", "Only owners and managers may manage members");
    }
  }
  if (granting !== null) {
    if (!MANAGED_ROLES.includes(granting)) {
      throw new TenancyError("INVALID", "Manual grants allow only manager, member or viewer");
    }
    if (granting === "manager" && !mayGrantManager(actor)) {
      throw new TenancyError(
        "FORBIDDEN",
        "Only the workspace owner or an instance admin may grant the manager role",
      );
    }
  }
  return { ws, actor };
}

// Owner rows outrank managers: only the workspace owner or an instance
// admin/owner may change or remove one (the last-manager guard still applies).
function assertMayTouchRow(actor, role) {
  if (role === "owner" && !mayGrantManager(actor)) {
    throw new TenancyError("FORBIDDEN", "Managers can't change or remove the workspace owner");
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

// Management read (YAN-360): same live in-transaction authority as the
// mutators (workspace owner/manager or active instance admin/owner, shared
// workspaces only), so an admin who is not a member can list. Explicit
// metadata columns only. listMemberships keeps its member-scoped semantics.
export async function listManagedMemberships(ctx, workspaceId) {
  assertCtx(ctx);
  const db = await getAdapter();
  return db.transaction(() => {
    managedWorkspace(db, ctx, workspaceId);
    return db
      .all(
        `SELECT workspaceId, userId, role, source, createdAt FROM memberships WHERE workspaceId = ? ORDER BY createdAt ASC`,
        [workspaceId],
      )
      .map(rowToMembership);
  });
}

// Manual add: `source` is server-controlled — manual APIs write `manual`
// only and reject any caller-supplied `invite`/`idp` value (`invite` belongs
// to the accept service via addMembershipUnscoped, `idp` to SSO sync).
export async function addMembership(
  ctx,
  workspaceId,
  { userId, role = "member", source = "manual" },
) {
  assertCtx(ctx);
  if (typeof userId !== "string" || !userId) {
    throw new TenancyError("INVALID", "userId is required");
  }
  if (source !== "manual") {
    throw source === "idp"
      ? new TenancyError("IDP_MANAGED", "IdP-sourced memberships are managed by SSO sync")
      : new TenancyError("INVALID", "Manual adds always use source manual");
  }
  const db = await getAdapter();
  const membership = mapConstraintErrors(() =>
    db.transaction(() => {
      managedWorkspace(db, ctx, workspaceId, { granting: role });
      const cur = db.get(`SELECT source FROM memberships WHERE workspaceId = ? AND userId = ?`, [
        workspaceId,
        userId,
      ]);
      if (cur?.source === "idp") {
        throw new TenancyError("IDP_MANAGED", "IdP-sourced memberships are managed by SSO sync");
      }
      const createdAt = new Date().toISOString();
      db.run(
        `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?, ?, ?, ?, ?)`,
        [workspaceId, userId, role, source, createdAt],
      );
      return { workspaceId, userId, role, source, createdAt };
    }),
  );
  audit({ principal: ctx, workspaceId }, "membership.add", mTarget(workspaceId, userId), {
    after: { userId, role, workspaceId },
  });
  return membership;
}

// Manual role change: allow-listed roles only; IdP rows are read-only here.
export async function updateMembershipRole(ctx, workspaceId, userId, role) {
  assertCtx(ctx);
  const db = await getAdapter();
  let prevRole = null;
  const row = mapConstraintErrors(() =>
    db.transaction(() => {
      const { actor } = managedWorkspace(db, ctx, workspaceId, { granting: role });
      const cur = db.get(
        `SELECT role, source FROM memberships WHERE workspaceId = ? AND userId = ?`,
        [workspaceId, userId],
      );
      if (!cur) {
        throw new TenancyError("NOT_FOUND", "Membership not found");
      }
      if (cur.source === "idp") {
        throw new TenancyError("IDP_MANAGED", "IdP-sourced memberships are managed by SSO sync");
      }
      assertMayTouchRow(actor, cur.role);
      prevRole = cur.role;
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
  audit({ principal: ctx, workspaceId }, "membership.roleChange", mTarget(workspaceId, userId), {
    before: { role: prevRole },
    after: { role },
  });
  return row;
}

// Manual removal: IdP rows are read-only; the active last-manager guard runs
// in this transaction and removal revokes the user's keys in this workspace only.
export async function removeMembership(ctx, workspaceId, userId) {
  assertCtx(ctx);
  const db = await getAdapter();
  const now = new Date().toISOString();
  let prevRole = null;
  const removed = db.transaction(() => {
    const { actor } = managedWorkspace(db, ctx, workspaceId);
    const cur = db.get(
      `SELECT role, source FROM memberships WHERE workspaceId = ? AND userId = ?`,
      [workspaceId, userId],
    );
    if (!cur) return false;
    if (cur.source === "idp") {
      throw new TenancyError("IDP_MANAGED", "IdP-sourced memberships are managed by SSO sync");
    }
    assertMayTouchRow(actor, cur.role);
    prevRole = cur.role;
    assertNotLastManager(db, workspaceId, userId);
    const { changes } = db.run(`DELETE FROM memberships WHERE workspaceId = ? AND userId = ?`, [
      workspaceId,
      userId,
    ]);
    if (changes > 0) revokeUserApiKeysSync(db, userId, { workspaceId, now });
    return changes > 0;
  });
  if (removed) {
    audit({ principal: ctx, workspaceId }, "membership.remove", mTarget(workspaceId, userId), {
      before: { userId, role: prevRole, workspaceId },
    });
  }
  return removed;
}
