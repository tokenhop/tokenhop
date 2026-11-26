import { getAdapter } from "../driver.js";
import { assertCtx } from "@/lib/users/errors.js";
import { audit } from "@/lib/users/audit.js";
import { memberWorkspaceId } from "./ownership.js";
import { clearCredentialCache } from "../helpers/credentialStorage.js";
import { recordAbsorbed } from "../helpers/codexDuplicateMerge.js";
import { prepareCredentialCtx } from "../helpers/connectionCredentialCtx.js";
import { rowToConn, rowToConnMetadata } from "../helpers/connectionRows.js";
import { createInTx, deleteInTx, updateInTx } from "../helpers/connectionWrites.js";

// ─── Scoped API (YAN-361): every call takes the request principal ─────────
// Rows are looked up by (id, member workspace), so an id from another
// workspace reads as "not found" (no IDOR). `workspaceId` arguments are only
// selectors: membership is re-verified in SQL. Role checks are the route's job.
const MEMBER_ROW = `SELECT pc.* FROM providerConnections pc JOIN memberships m ON m.workspaceId = pc.workspaceId WHERE pc.id = ? AND m.userId = ?`;

/** Connections of one workspace the principal belongs to, by priority. */
export async function listConnections(ctx, workspaceId, filter = {}) {
  const db = await getAdapter();
  memberWorkspaceId(ctx, db, workspaceId);
  const credCtx = await prepareCredentialCtx(db);
  const where = ["workspaceId = ?"];
  const params = [workspaceId];
  if (filter.provider) {
    where.push("provider = ?");
    params.push(filter.provider);
  }
  if (filter.isActive !== undefined) {
    where.push("isActive = ?");
    params.push(filter.isActive ? 1 : 0);
  }
  const rows = db.all(`SELECT * FROM providerConnections WHERE ${where.join(" AND ")}`, params);
  return rows
    .map((row) => rowToConn(db, row, credCtx))
    .sort((a, b) => (a.priority || 999) - (b.priority || 999));
}

/**
 * Metadata list for responses (YAN-365): covered leaves are never decrypted;
 * each row reports its `configured` dotted paths instead. A corrupt envelope
 * in one row cannot break the list.
 */
export async function listConnectionsMetadata(ctx, workspaceId, filter = {}) {
  const db = await getAdapter();
  memberWorkspaceId(ctx, db, workspaceId);
  const where = ["workspaceId = ?"];
  const params = [workspaceId];
  if (filter.provider) {
    where.push("provider = ?");
    params.push(filter.provider);
  }
  if (filter.isActive !== undefined) {
    where.push("isActive = ?");
    params.push(filter.isActive ? 1 : 0);
  }
  const rows = db.all(`SELECT * FROM providerConnections WHERE ${where.join(" AND ")}`, params);
  return rows.map(rowToConnMetadata).sort((a, b) => (a.priority || 999) - (b.priority || 999));
}

/** A connection in any workspace the principal belongs to, else null. */
export async function getConnection(ctx, id) {
  assertCtx(ctx);
  const db = await getAdapter();
  const credCtx = await prepareCredentialCtx(db);
  return rowToConn(db, db.get(MEMBER_ROW, [id, ctx.userId]), credCtx);
}

/** Create (or re-login upsert) inside `workspaceId`; the creator is the principal. */
export async function createConnection(ctx, workspaceId, data, opts = {}) {
  const db = await getAdapter();
  const credCtx = await prepareCredentialCtx(db);
  const removed = [];
  let authorizedWs = null;
  let conn;
  try {
    conn = await db.transaction(() => {
      authorizedWs = memberWorkspaceId(ctx, db, workspaceId);
      return createInTx(
        db,
        data,
        opts,
        { workspaceId: authorizedWs, createdByUserId: ctx.userId },
        credCtx,
        removed,
      );
    });
  } catch (err) {
    // Scope cleanup to a workspace that passed authorization so a rejected
    // or undefined workspaceId never evicts unrelated workspaces' cached DEKs.
    if (credCtx.encrypted && authorizedWs) clearCredentialCache(db, authorizedWs);
    throw err;
  }
  recordAbsorbed(removed, conn);
  // YAN-367: never audit credential fields — only the allow-listed identity fields.
  await audit(
    { principal: ctx, workspaceId },
    "connection.create",
    { type: "connection", id: conn.id },
    {
      after: {
        id: conn.id,
        provider: conn.provider,
        name: conn.name,
        email: conn.email,
        workspaceId,
      },
    },
  );
  // YAN-1623: flagged duplicates the merge removed, same shape as deleteConnection.
  for (const { conn: c, revokedGrants, movedGrants } of removed) {
    // Same shape as revokeGrant.
    for (const g of revokedGrants) {
      await audit(
        { principal: ctx, workspaceId },
        "connectionGrant.revoke",
        { type: "connectionGrant", id: g.id },
        {
          before: { id: g.id, connectionId: g.connectionId },
          after: { id: g.id, connectionId: g.connectionId, revokedAt: g.revokedAt },
        },
      );
    }
    for (const g of movedGrants) {
      await audit(
        { principal: ctx, workspaceId },
        "connectionGrant.update",
        { type: "connectionGrant", id: g.id },
        {
          before: { id: g.id, connectionId: g.from },
          after: { id: g.id, connectionId: g.to },
        },
      );
    }
    await audit(
      { principal: ctx, workspaceId },
      "connection.delete",
      { type: "connection", id: c.id },
      {
        before: {
          id: c.id,
          provider: c.provider,
          name: c.name,
          email: c.email,
          workspaceId: c.workspaceId ?? null,
        },
      },
    );
  }
  return conn;
}

export async function updateConnection(ctx, id, data) {
  assertCtx(ctx);
  const db = await getAdapter();
  const credCtx = await prepareCredentialCtx(db);
  return db.transaction(() => updateInTx(db, db.get(MEMBER_ROW, [id, ctx.userId]), data, credCtx));
}

export async function deleteConnection(ctx, id) {
  assertCtx(ctx);
  const db = await getAdapter();
  const credCtx = await prepareCredentialCtx(db);
  const before = db.get(MEMBER_ROW, [id, ctx.userId]);
  const deleted = await db.transaction(() => deleteInTx(db, db.get(MEMBER_ROW, [id, ctx.userId])));
  if (deleted && before) {
    const c = rowToConn(db, before, credCtx);
    await audit(
      { principal: ctx, workspaceId: c.workspaceId ?? null },
      "connection.delete",
      { type: "connection", id },
      {
        before: {
          id,
          provider: c.provider,
          name: c.name,
          email: c.email,
          workspaceId: c.workspaceId ?? null,
        },
      },
    );
  }
  return deleted;
}
