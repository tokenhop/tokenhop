// Workspace memberships (YAN-353). Scoped: the principal must belong to the
// workspace. Role checks (who may manage members) belong to YAN-357.
import { getAdapter } from "../driver.js";
import { revokeUserApiKeysSync } from "./apiKeysRepo.js";
import { TenancyError, assertCtx, mapConstraintErrors } from "@/lib/users/errors.js";
import { audit } from "@/lib/users/audit.js";

const mTarget = (workspaceId, userId) => ({ type: "membership", id: `${workspaceId}:${userId}` });

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
  audit({ principal: ctx, workspaceId }, "membership.add", mTarget(workspaceId, userId), {
    after: { userId, role, workspaceId },
  });
  return membership;
}

export async function updateMembershipRole(ctx, workspaceId, userId, role) {
  const db = await getAdapter();
  let prevRole = null;
  const row = mapConstraintErrors(() =>
    db.transaction(() => {
      sharedWorkspace(db, ctx, workspaceId);
      prevRole = membershipRole(db, workspaceId, userId);
      if (!prevRole) {
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
  audit({ principal: ctx, workspaceId }, "membership.roleChange", mTarget(workspaceId, userId), {
    before: { role: prevRole },
    after: { role },
  });
  return row;
}

export async function removeMembership(ctx, workspaceId, userId) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  let prevRole = null;
  const removed = db.transaction(() => {
    sharedWorkspace(db, ctx, workspaceId);
    assertNotLastManager(db, workspaceId, userId);
    prevRole = membershipRole(db, workspaceId, userId);
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
