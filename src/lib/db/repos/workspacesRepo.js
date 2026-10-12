// Workspaces (YAN-353, ADR-0001). Scoped reads and writes only see workspaces
// the principal belongs to. Personal workspaces are created and removed with
// their user (usersRepo).
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { TenancyError, assertCtx, mapConstraintErrors } from "@/lib/users/errors.js";
import { clearCredentialCache } from "../helpers/credentialStorage.js";
import { readApiKeyStorageState } from "../apiKeyState.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { defaultWorkspaceIdUnscoped } from "./ownership.js";
import { auditSync } from "@/lib/users/audit.js";

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

// Admin-only shared directory: personal workspaces stay private. Callers
// assert instance.users.manage. One query counts all membership roles.
export async function listSharedWorkspacesWithMemberCountsUnscoped() {
  const db = await getAdapter();
  return db.all(
    `SELECT w.id, w.name, w.createdAt, COUNT(m.userId) AS memberCount
     FROM workspaces w LEFT JOIN memberships m ON m.workspaceId = w.id
     WHERE w.kind = 'shared'
     GROUP BY w.id ORDER BY w.name ASC, w.id ASC`,
  );
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

// ─── YAN-373: admin workspace detail and guarded deletion ─────────────────
// Instance-admin surface (the route gates instance.users.manage, browser
// session only). Counts never touch decrypted secret material.

const KV_SCOPES = ["modelAliases", "customModels", "disabledModels"];
const GRANT_IDS_SQL = `SELECT cg.id FROM connectionGrants cg
     JOIN providerConnections pc ON pc.id = cg.connectionId
     WHERE pc.workspaceId = ?`;

/**
 * Admin detail for one SHARED workspace, or null for missing/personal (the
 * route answers both with the same 404). apiKeys is null (with
 * apiKeysLegacy) while gateway keys are stored without a workspaceId.
 * @param {string} id
 */
export async function getWorkspaceDetailUnscoped(id) {
  const db = await getAdapter();
  const ws = db.get(
    `SELECT w.id, w.name, w.kind, w.createdAt, w.updatedAt,
            (SELECT COUNT(*) FROM memberships m WHERE m.workspaceId = w.id) AS memberCount
     FROM workspaces w WHERE w.id = ?`,
    [id],
  );
  if (ws?.kind !== "shared") return null;
  const count = (sql) => db.get(sql, [id])?.c ?? 0;
  const grantsOut =
    db.get(
      `SELECT COUNT(*) AS c FROM connectionGrants cg
       JOIN providerConnections pc ON pc.id = cg.connectionId
       WHERE pc.workspaceId = ? AND cg.revokedAt IS NULL`,
      [id],
    )?.c ?? 0;
  const keys = { apiKeys: null, apiKeysLegacy: false };
  const keyState = readApiKeyStorageState(db); // throws API_KEY_STATE_INVALID
  if (keyState.storage === "legacy") {
    keys.apiKeysLegacy = true;
  } else {
    keys.apiKeys = count(`SELECT COUNT(*) AS c FROM apiKeys WHERE workspaceId = ?`);
  }
  return {
    workspace: {
      id: ws.id,
      name: ws.name,
      kind: ws.kind,
      createdAt: ws.createdAt,
      updatedAt: ws.updatedAt,
      memberCount: ws.memberCount,
      isDefault: defaultWorkspaceIdUnscoped(db) === ws.id,
    },
    counts: {
      connections: count(`SELECT COUNT(*) AS c FROM providerConnections WHERE workspaceId = ?`),
      nodes: count(`SELECT COUNT(*) AS c FROM providerNodes WHERE workspaceId = ?`),
      combos: count(`SELECT COUNT(*) AS c FROM combos WHERE workspaceId = ?`),
      ...keys,
      invitations: count(`SELECT COUNT(*) AS c FROM invitations WHERE workspaceId = ?`),
      budgets: count(`SELECT COUNT(*) AS c FROM budgets WHERE workspaceId = ?`),
      grantBudgetsElsewhere:
        db.get(
          `SELECT COUNT(*) AS c FROM budgets
           WHERE workspaceId IS NOT ? AND scopeType = 'grant'
             AND scopeId IN (${GRANT_IDS_SQL})`,
          [id, id],
        )?.c ?? 0,
      grantsOut,
    },
    encryption: {
      dekWrapped: !!db.get(`SELECT 1 AS x FROM workspaceKeys WHERE workspaceId = ?`, [id]),
    },
  };
}

/**
 * Guarded shared-workspace deletion. MUST run inside a caller-started
 * transaction (`db.transaction`): the Default/personal guards, the live
 * owner/admin + sessionVersion re-read, the SSO group-map rewrite, the exact
 * `ws:<id>/` kv prefix delete, the outgoing-grant budget cleanup (even in
 * other workspaces) and the audit row commit or roll back together, and the
 * workspace row delete relies on foreign_keys being ON for the cascades.
 * Post-commit the caller purges the DEK cache (`clearCredentialCache`).
 * Historical usage (usageHistory/usageDaily/requestDetails, SET NULL) and
 * audit rows (no FK) survive. Throws TenancyError: NOT_FOUND (missing or
 * personal), DEFAULT_WORKSPACE_PROTECTED (status 409), FORBIDDEN, STALE.
 * @param {object} db adapter (inside its transaction)
 * @param {string} id
 * @param {{ actorId: string, sessionVersion?: number, ip?: string|null, via?: string }} proof
 * @returns {{ budgetsDeleted: number, kvDeleted: number, ssoMapEntriesRemoved: number }}
 */
export function deleteWorkspaceSyncUnscoped(
  db,
  id,
  { actorId, sessionVersion, ip = null, via = null },
) {
  const current = db.get(`SELECT id, name, kind FROM workspaces WHERE id = ?`, [id]);
  if (!current || current.kind === "personal") {
    throw new TenancyError("NOT_FOUND", "Workspace not found");
  }
  if (defaultWorkspaceIdUnscoped(db) === current.id) {
    throw Object.assign(
      new TenancyError("DEFAULT_WORKSPACE_PROTECTED", "The Default workspace cannot be deleted"),
      { status: 409 },
    );
  }
  // Live re-read in the same transaction: the proof's actor must still be an
  // active owner/admin on the exact sessionVersion the re-auth was bound to.
  const actor = db.get(`SELECT instanceRole, status, sessionVersion FROM users WHERE id = ?`, [
    actorId,
  ]);
  if (actor?.status !== "active" || !["owner", "admin"].includes(actor?.instanceRole)) {
    throw new TenancyError("FORBIDDEN", "Only an instance owner or admin may do this");
  }
  if (!Number.isInteger(sessionVersion) || actor.sessionVersion !== sessionVersion) {
    throw new TenancyError("STALE", "Session is out of date");
  }

  // Budgets scoped to this workspace's outgoing grants, wherever they live.
  const grantIds = db.all(GRANT_IDS_SQL, [id]).map((row) => row.id);
  let budgetsDeleted = 0;
  if (grantIds.length) {
    budgetsDeleted = db.run(
      `DELETE FROM budgets WHERE scopeType = 'grant' AND scopeId IN (${grantIds.map(() => "?").join(",")})`,
      grantIds,
    ).changes;
  }

  // Stale SSO map targets fail EVERY login (ssoProvisioning re-checks each
  // mapped workspace), so the instance blob is rewritten in this transaction.
  let ssoMapEntriesRemoved = 0;
  const settingsRow = db.get(`SELECT data FROM settings WHERE id = 1`);
  if (settingsRow) {
    const blob = parseJson(settingsRow.data, {});
    const map = Array.isArray(blob.ssoGroupWorkspaceMap) ? blob.ssoGroupWorkspaceMap : [];
    const kept = map.filter((entry) => entry?.workspaceId !== id);
    if (kept.length !== map.length) {
      ssoMapEntriesRemoved = map.length - kept.length;
      db.run(`UPDATE settings SET data = ? WHERE id = 1`, [
        stringifyJson({ ...blob, ssoGroupWorkspaceMap: kept }),
      ]);
    }
  }

  // Exact-prefix scoped kv cleanup (parameter length, never LIKE).
  const prefix = `ws:${id}/`;
  let kvDeleted = 0;
  for (const scope of KV_SCOPES) {
    kvDeleted += db.run(`DELETE FROM kv WHERE scope = ? AND substr(key, 1, ?) = ?`, [
      scope,
      prefix.length,
      prefix,
    ]).changes;
  }

  // FK cascade removes connections, nodes, combos, memberships, invitations,
  // apiKeys, workspaceKeys (the DEK), workspaceSettings and the workspace's
  // own budgets/grants.
  db.run(`DELETE FROM workspaces WHERE id = ?`, [id]);

  auditSync(
    db,
    { principal: { userId: actorId, via: via ?? "session" }, ip, workspaceId: id },
    "workspace.delete",
    { type: "workspace", id },
    {
      after: {
        workspaceId: id,
        count: budgetsDeleted + kvDeleted + ssoMapEntriesRemoved,
      },
    },
  );
  return { budgetsDeleted, kvDeleted, ssoMapEntriesRemoved };
}

/** Route wrapper: transaction + post-commit DEK cache purge. */
export async function deleteWorkspaceGuardedUnscoped(id, proof) {
  const db = await getAdapter();
  const summary = db.transaction(() => deleteWorkspaceSyncUnscoped(db, id, proof));
  // Post-commit only: a cached DEK must never resurrect deleted ciphertext.
  clearCredentialCache(db, id);
  return summary;
}
