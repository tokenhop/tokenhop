import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { TenancyError, assertCtx } from "@/lib/users/errors.js";
import { defaultWorkspaceIdUnscoped, memberWorkspaceId } from "./ownership.js";

function rowToNode(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    type: row.type,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // YAN-361: owner columns, only once set.
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    ...(row.createdByUserId ? { createdByUserId: row.createdByUserId } : {}),
  };
}

function nodeToRow(n) {
  const { id, type, name, createdAt, updatedAt, workspaceId, createdByUserId, ...rest } = n;
  return {
    id,
    type: type ?? null,
    name: name ?? null,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
    workspaceId: workspaceId ?? null,
    createdByUserId: createdByUserId ?? null,
  };
}

function upsert(db, n) {
  const r = nodeToRow(n);
  db.run(
    `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt, workspaceId, createdByUserId)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type=excluded.type, name=excluded.name, data=excluded.data, updatedAt=excluded.updatedAt,
       workspaceId=COALESCE(workspaceId, excluded.workspaceId),
       createdByUserId=COALESCE(createdByUserId, excluded.createdByUserId)`,
    [r.id, r.type, r.name, r.data, r.createdAt, r.updatedAt, r.workspaceId, r.createdByUserId],
  );
}

export async function getProviderNodesUnscoped(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.type) {
    where.push("type = ?");
    params.push(filter.type);
  }
  const sql = `SELECT * FROM providerNodes${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  return db.all(sql, params).map(rowToNode);
}

export async function getProviderNodeByIdUnscoped(id) {
  const db = await getAdapter();
  return rowToNode(db.get(`SELECT * FROM providerNodes WHERE id = ?`, [id]));
}

function newNode(data, owner) {
  const now = new Date().toISOString();
  return {
    id: data.id || uuidv4(),
    type: data.type,
    name: data.name,
    prefix: data.prefix,
    apiType: data.apiType,
    baseUrl: data.baseUrl,
    createdAt: now,
    updatedAt: now,
    ...(owner.workspaceId ? { workspaceId: owner.workspaceId } : {}),
    ...(owner.createdByUserId ? { createdByUserId: owner.createdByUserId } : {}),
  };
}

export async function createProviderNodeUnscoped(data) {
  const db = await getAdapter();
  const node = newNode(data, { workspaceId: defaultWorkspaceIdUnscoped(db) });
  upsert(db, node);
  return node;
}

// Ownership is immutable here (moves are YAN-701).
function updateInTx(db, row, data) {
  if (!row) return null;
  const { workspaceId: _ws, createdByUserId: _by, ...patch } = data || {};
  const merged = { ...rowToNode(row), ...patch, updatedAt: new Date().toISOString() };
  upsert(db, merged);
  return merged;
}

export async function updateProviderNodeUnscoped(id, data) {
  const db = await getAdapter();
  return db.transaction(() =>
    updateInTx(db, db.get(`SELECT * FROM providerNodes WHERE id = ?`, [id]), data),
  );
}

function deleteInTx(db, row) {
  if (!row) return null;
  db.run(`DELETE FROM providerNodes WHERE id = ?`, [row.id]);
  return rowToNode(row);
}

export async function deleteProviderNodeUnscoped(id) {
  const db = await getAdapter();
  return db.transaction(() =>
    deleteInTx(db, db.get(`SELECT * FROM providerNodes WHERE id = ?`, [id])),
  );
}

// ─── Scoped API (YAN-361) ────────────────────────────────────────────────
// Rows resolve through the principal's memberships (no IDOR). Prefixes are
// unique per workspace; gateway prefix resolution stays global until YAN-368.
const MEMBER_ROW = `SELECT n.* FROM providerNodes n JOIN memberships m ON m.workspaceId = n.workspaceId WHERE n.id = ? AND m.userId = ?`;

function assertPrefixFree(db, workspaceId, prefix, exceptId = null) {
  const taken = db
    .all(`SELECT id, data FROM providerNodes WHERE workspaceId = ?`, [workspaceId])
    .some((r) => r.id !== exceptId && parseJson(r.data, {}).prefix === prefix);
  if (taken) throw new TenancyError("PREFIX_TAKEN", "Prefix is already used in this workspace");
}

export async function listNodes(ctx, workspaceId, filter = {}) {
  const db = await getAdapter();
  memberWorkspaceId(ctx, db, workspaceId);
  const params = [workspaceId];
  let sql = `SELECT * FROM providerNodes WHERE workspaceId = ?`;
  if (filter.type) {
    sql += " AND type = ?";
    params.push(filter.type);
  }
  return db.all(sql, params).map(rowToNode);
}

export async function getNode(ctx, id) {
  assertCtx(ctx);
  const db = await getAdapter();
  return rowToNode(db.get(MEMBER_ROW, [id, ctx.userId]));
}

export async function createNode(ctx, workspaceId, data) {
  const db = await getAdapter();
  return db.transaction(() => {
    memberWorkspaceId(ctx, db, workspaceId);
    assertPrefixFree(db, workspaceId, data.prefix);
    const node = newNode(data, { workspaceId, createdByUserId: ctx.userId });
    upsert(db, node);
    return node;
  });
}

export async function updateNode(ctx, id, data) {
  assertCtx(ctx);
  const db = await getAdapter();
  return db.transaction(() => {
    const row = db.get(MEMBER_ROW, [id, ctx.userId]);
    if (row && data?.prefix !== undefined) assertPrefixFree(db, row.workspaceId, data.prefix, id);
    return updateInTx(db, row, data);
  });
}

/** Delete a node and its connections (same workspace) in one transaction. */
export async function deleteNode(ctx, id) {
  assertCtx(ctx);
  const db = await getAdapter();
  return db.transaction(() => {
    const row = db.get(MEMBER_ROW, [id, ctx.userId]);
    if (!row) return null;
    db.run(`DELETE FROM providerConnections WHERE provider = ? AND workspaceId = ?`, [
      id,
      row.workspaceId,
    ]);
    return deleteInTx(db, row);
  });
}
