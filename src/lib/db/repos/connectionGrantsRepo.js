// Connection grants (YAN-369, ADR-0006): one workspace/user may use another
// workspace's connection. Owner-side authority is live in-transaction, same
// shape as invitationsRepo.requireManager: the ctx principal must manage the
// connection's owning workspace (owner/manager, or an active instance
// admin/owner); foreign ids read as NOT_FOUND so they stay invisible. The
// provider-terms matrix (@/lib/users/grants.js assertGrantable) runs inside
// createGrant, so no caller can skip it. One active grant per
// (connection, grantee): partial UNIQUE indexes → GRANT_EXISTS. Grant rows carry no secrets; the
// credential data of the joined connection never leaves the gateway reader.
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { TenancyError, assertCtx, mapConstraintErrors } from "@/lib/users/errors.js";
import { mayGrantManager, mayManage, membershipRole } from "./membershipsRepo.js";
import { audit } from "@/lib/users/audit.js";
import { getSettings } from "./settingsRepo.js";

const COLS =
  "id, connectionId, workspaceId, userId, allowedModels, rpm, tpm, budgetId, createdByUserId, tosAcknowledgedAt, createdAt, revokedAt";

// allowedModels is a JSON array in storage, an array in every returned row.
function toGrant(row) {
  return {
    ...row,
    allowedModels: row.allowedModels == null ? null : JSON.parse(row.allowedModels),
  };
}

function normalizeModels(models) {
  if (models == null) return null;
  // Canonical "provider/model" ids only: the gateway compares exactly that form.
  if (
    !Array.isArray(models) ||
    models.length === 0 ||
    !models.every((m) => typeof m === "string" && /^[^/\s]+\/\S+$/.test(m) && m.length <= 512)
  ) {
    throw new TenancyError(
      "INVALID",
      "allowedModels must be a non-empty array of provider/model ids",
    );
  }
  return JSON.stringify(models);
}

function normalizeLimit(value, name) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 1) {
    throw new TenancyError("INVALID", `${name} must be a positive integer`);
  }
  return value;
}

/**
 * The grant source: the connection plus the caller's live authority over its
 * owning workspace. Pending users are forbidden; anyone else without manager
 * rights gets NOT_FOUND (the connection stays invisible).
 */
function requireConnectionManager(db, ctx, connectionId) {
  assertCtx(ctx);
  if (typeof connectionId !== "string" || !connectionId) {
    throw new TenancyError("INVALID", "connectionId is required");
  }
  const conn = db.get(
    `SELECT id, provider, authType, workspaceId FROM providerConnections WHERE id = ?`,
    [connectionId],
  );
  if (!conn?.workspaceId) throw new TenancyError("NOT_FOUND", "Connection not found");
  const user = db.get(`SELECT instanceRole, status FROM users WHERE id = ?`, [ctx.userId]);
  const actor = {
    workspaceRole: membershipRole(db, conn.workspaceId, ctx.userId),
    instanceRole: user?.instanceRole ?? null,
    status: user?.status ?? null,
  };
  if (actor.instanceRole === "pending") {
    throw new TenancyError("FORBIDDEN", "Pending users can't manage grants");
  }
  const elevated = actor.status === "active" && mayGrantManager(actor);
  if (!actor.workspaceRole && !elevated)
    throw new TenancyError("NOT_FOUND", "Connection not found");
  if (!elevated) {
    if (actor.status !== "active" || !mayManage(actor.workspaceRole)) {
      throw new TenancyError("FORBIDDEN", "Only owners and managers may manage grants");
    }
  }
  return conn;
}

/** Grants of one connection (owner side), oldest first. No secrets on grants. */
export async function listGrantsForConnection(ctx, connectionId) {
  assertCtx(ctx);
  const db = await getAdapter();
  requireConnectionManager(db, ctx, connectionId);
  return db
    .all(
      `SELECT ${COLS} FROM connectionGrants WHERE connectionId = ? ORDER BY createdAt ASC, id ASC`,
      [connectionId],
    )
    .map(toGrant);
}

/** A grant the ctx principal may manage (connection owner side), else null. */
export async function getGrantById(ctx, grantId) {
  assertCtx(ctx);
  const db = await getAdapter();
  const row = db.get(`SELECT ${COLS} FROM connectionGrants WHERE id = ?`, [grantId]);
  if (!row) return null;
  try {
    requireConnectionManager(db, ctx, row.connectionId);
  } catch (err) {
    if (err instanceof TenancyError && ["NOT_FOUND", "FORBIDDEN"].includes(err.code)) return null;
    throw err;
  }
  return toGrant(row);
}

/**
 * Create a grant. Exactly one of workspaceId/userId names the grantee (the
 * CHECK is the backstop; the repo rejects earlier with INVALID).
 * `tosAcknowledged`, when it echoes {providerId, sharing:"personal"} for the
 * connection's provider, stamps tosAcknowledgedAt=now (ADR-0006 §Override);
 * the toggle/admin gate itself is assertGrantable in @/lib/users/grants.js.
 * Audits connectionGrant.create — never credential material.
 */
export async function createGrant(
  ctx,
  {
    connectionId,
    workspaceId = null,
    userId = null,
    allowedModels = null,
    rpm = null,
    tpm = null,
    budgetId = null,
    tosAcknowledged = null,
  } = {},
) {
  assertCtx(ctx);
  for (const [name, value] of [
    ["workspaceId", workspaceId],
    ["userId", userId],
  ]) {
    if (value != null && (typeof value !== "string" || !value)) {
      throw new TenancyError("INVALID", `${name} must be a non-empty string`);
    }
  }
  if ((workspaceId == null) === (userId == null)) {
    throw new TenancyError("INVALID", "Exactly one of workspaceId or userId must be set");
  }
  const models = normalizeModels(allowedModels);
  const rpmVal = normalizeLimit(rpm, "rpm");
  const tpmVal = normalizeLimit(tpm, "tpm");
  if (budgetId != null && (typeof budgetId !== "string" || !budgetId)) {
    throw new TenancyError("INVALID", "budgetId must be a non-empty string");
  }
  const db = await getAdapter();
  const conn = requireConnectionManager(db, ctx, connectionId);
  // ToS gate lives here, not only in the route: no caller can create a grant
  // without it. Judged on the live instance role, not the session snapshot.
  // Lazy: grants.js loads the provider registry; keep it off the @/lib/db import graph.
  const { assertGrantable } = await import("@/lib/users/grants.js");
  const live = db.get(`SELECT instanceRole FROM users WHERE id = ?`, [ctx.userId]);
  const { sharing, tosAcknowledgedAt } = assertGrantable({
    principal: { instanceRole: live?.instanceRole ?? null },
    connection: conn,
    body: { tosAcknowledged },
    settings: await getSettings(),
  });
  const at = Date.now();
  const acked = tosAcknowledgedAt ? at : null;
  const row = {
    id: uuidv4(),
    connectionId: conn.id,
    workspaceId: workspaceId ?? null,
    userId: userId ?? null,
    allowedModels: allowedModels ?? null,
    rpm: rpmVal,
    tpm: tpmVal,
    budgetId: budgetId ?? null,
    createdByUserId: ctx.userId,
    tosAcknowledgedAt: acked,
    createdAt: at,
    revokedAt: null,
  };
  const stored = mapConstraintErrors(() =>
    db.transaction(() => {
      db.run(
        `INSERT INTO connectionGrants(id, connectionId, workspaceId, userId, allowedModels, rpm, tpm, budgetId, createdByUserId, tosAcknowledgedAt, createdAt, revokedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.connectionId,
          row.workspaceId,
          row.userId,
          models,
          row.rpm,
          row.tpm,
          row.budgetId,
          row.createdByUserId,
          row.tosAcknowledgedAt,
          row.createdAt,
          row.revokedAt,
        ],
      );
      return row;
    }),
  );
  await audit(
    { principal: ctx, workspaceId: conn.workspaceId },
    "connectionGrant.create",
    { type: "connectionGrant", id: row.id },
    {
      after: {
        id: row.id,
        connectionId: row.connectionId,
        provider: conn.provider,
        sharing,
        granteeWorkspaceId: row.workspaceId,
        granteeUserId: row.userId,
        allowedModels: row.allowedModels,
        rpm: row.rpm,
        tpm: row.tpm,
        budgetId: row.budgetId,
        tosAcknowledgedAt: row.tosAcknowledgedAt,
      },
    },
  );
  return stored;
}

/**
 * Revoke a grant. Idempotent: an already-revoked row returns unchanged.
 * No grant cache exists — every gateway selection re-reads revokedAt IS NULL
 * fresh, so revocation is effective on the next request by construction.
 * Audits connectionGrant.revoke on the state change.
 */
export async function revokeGrant(ctx, grantId) {
  assertCtx(ctx);
  if (typeof grantId !== "string" || !grantId) {
    throw new TenancyError("INVALID", "grantId is required");
  }
  const db = await getAdapter();
  const out = db.transaction(() => {
    const row = db.get(`SELECT ${COLS} FROM connectionGrants WHERE id = ?`, [grantId]);
    if (!row) throw new TenancyError("NOT_FOUND", "Grant not found");
    const conn = requireConnectionManager(db, ctx, row.connectionId);
    if (row.revokedAt != null) return { row, conn, changed: false };
    const now = Date.now();
    db.run(`UPDATE connectionGrants SET revokedAt = ? WHERE id = ? AND revokedAt IS NULL`, [
      now,
      grantId,
    ]);
    return { row: { ...row, revokedAt: now }, conn, changed: true };
  });
  if (out.changed) {
    await audit(
      { principal: ctx, workspaceId: out.conn.workspaceId },
      "connectionGrant.revoke",
      { type: "connectionGrant", id: grantId },
      {
        before: { id: grantId, connectionId: out.row.connectionId },
        after: { id: grantId, connectionId: out.row.connectionId, revokedAt: out.row.revokedAt },
      },
    );
  }
  return toGrant(out.row);
}

/**
 * Active grants for a gateway principal's workspace and/or user, each joined
 * with the full raw connection row (credential envelope undecoded — the
 * gateway decodes it under its own trusted keyContext). Shape per plan §2:
 * top-level grant fields ({grantId, connectionId, workspaceId, userId,
 * allowedModels (parsed), rpm, tpm, budgetId, tosAcknowledgedAt, createdAt,
 * revokedAt}) plus `connection` = the providerConnections row. Unscoped
 * gateway-only reader (tenancy-guard allow-list): the caller is the resolved
 * key context, never a session ctx. Returns [] for a null-scope principal.
 */
export function listActiveGrantsForPrincipal(db, { workspaceId = null, userId = null } = {}) {
  const grantee = [];
  const params = [];
  if (workspaceId != null) {
    grantee.push("g.workspaceId = ?");
    params.push(workspaceId);
  }
  if (userId != null) {
    grantee.push("g.userId = ?");
    params.push(userId);
  }
  if (!params.length) return [];
  // revokedAt must AND with the grantee match — never OR it in.
  return db
    .all(
      `SELECT pc.*, g.id AS grantId, g.connectionId AS gConn, g.workspaceId AS gWs, g.userId AS gUser, g.allowedModels AS gModels, g.rpm AS gRpm, g.tpm AS gTpm, g.budgetId AS gBudget, g.tosAcknowledgedAt AS gAck, g.createdAt AS gCreated, g.revokedAt AS gRevoked FROM connectionGrants g JOIN providerConnections pc ON pc.id = g.connectionId WHERE g.revokedAt IS NULL AND (${grantee.join(" OR ")}) ORDER BY g.createdAt, g.id`,
      params,
    )
    .map(
      ({
        grantId,
        gConn,
        gWs,
        gUser,
        gModels,
        gRpm,
        gTpm,
        gBudget,
        gAck,
        gCreated,
        gRevoked,
        ...connection
      }) => ({
        grantId,
        connectionId: gConn,
        workspaceId: gWs,
        userId: gUser,
        allowedModels: gModels == null ? null : JSON.parse(gModels),
        rpm: gRpm,
        tpm: gTpm,
        budgetId: gBudget,
        tosAcknowledgedAt: gAck,
        createdAt: gCreated,
        revokedAt: gRevoked,
        connection,
      }),
    );
}
