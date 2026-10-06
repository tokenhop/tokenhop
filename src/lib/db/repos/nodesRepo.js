import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { TenancyError, assertCtx } from "@/lib/users/errors.js";
import { defaultWorkspaceIdUnscoped, memberWorkspaceId } from "./ownership.js";
import { parseJson } from "../helpers/jsonCol.js";
import { decodeCredentialRowSync, encodeCredentialRowSync } from "../helpers/credentialStorage.js";
import { TABLE_NAMES } from "../../security/envelope.js";
import { prepareCredentialCtx, assertCredentialCtxCurrent } from "./connectionsRepo.js";

const TABLE = TABLE_NAMES.providerNodes;

function nodeColumns(row) {
  return {
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

function rowToNode(db, row, ctx) {
  if (!row) return null;
  const extra = decodeCredentialRowSync(db, row, ctx, { table: TABLE });
  return { ...extra, ...nodeColumns(row) };
}

function rowToNodeMetadata(row) {
  if (!row) return null;
  const { data, configured } = decodeCredentialRowSync(null, row, null, {
    mode: "metadata",
    table: TABLE,
  });
  return { ...data, ...nodeColumns(row), configured };
}

function nodeToRow(n) {
  const { id, type, name, createdAt, updatedAt, workspaceId, createdByUserId, ...rest } = n;
  return {
    id,
    type: type ?? null,
    name: name ?? null,
    data: rest,
    createdAt,
    updatedAt,
    workspaceId: workspaceId ?? null,
    createdByUserId: createdByUserId ?? null,
  };
}

function upsert(db, n, ctx) {
  const r = nodeToRow(n);
  assertCredentialCtxCurrent(db, ctx);
  const data = encodeCredentialRowSync(db, r, ctx, { table: TABLE });
  db.run(
    `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt, workspaceId, createdByUserId)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type=excluded.type, name=excluded.name, data=excluded.data, updatedAt=excluded.updatedAt,
       workspaceId=COALESCE(workspaceId, excluded.workspaceId),
       createdByUserId=COALESCE(createdByUserId, excluded.createdByUserId)`,
    [r.id, r.type, r.name, data, r.createdAt, r.updatedAt, r.workspaceId, r.createdByUserId],
  );
}

export async function getProviderNodesUnscoped(filter = {}) {
  const db = await getAdapter();
  const ctx = await prepareCredentialCtx(db);
  const where = [];
  const params = [];
  if (filter.type) {
    where.push("type = ?");
    params.push(filter.type);
  }
  const sql = `SELECT * FROM providerNodes${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  return db.all(sql, params).map((row) => rowToNode(db, row, ctx));
}

export async function getProviderNodesMetadataUnscoped(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.type) {
    where.push("type = ?");
    params.push(filter.type);
  }
  const sql = `SELECT * FROM providerNodes${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  return db.all(sql, params).map(rowToNodeMetadata);
}

export async function getProviderNodeByIdUnscoped(id) {
  const db = await getAdapter();
  const ctx = await prepareCredentialCtx(db);
  return rowToNode(db, db.get(`SELECT * FROM providerNodes WHERE id = ?`, [id]), ctx);
}

export async function getProviderNodeMetadataByIdUnscoped(id) {
  const db = await getAdapter();
  return rowToNodeMetadata(db.get(`SELECT * FROM providerNodes WHERE id = ?`, [id]));
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
  const ctx = await prepareCredentialCtx(db);
  const node = newNode(data, { workspaceId: defaultWorkspaceIdUnscoped(db) });
  upsert(db, node, ctx);
  return node;
}

// Ownership is immutable here (moves are YAN-701). The stored row always wins
// for coordinates; its secret leaves are decrypted first and only the
// explicit patch (plus explicit null clears) is re-encrypted.
function updateInTx(db, row, data, ctx) {
  if (!row) return null;
  const { workspaceId: _ws, createdByUserId: _by, ...patch } = data || {};
  const merged = { ...rowToNode(db, row, ctx), ...patch, updatedAt: new Date().toISOString() };
  upsert(db, merged, ctx);
  return merged;
}

export async function updateProviderNodeUnscoped(id, data) {
  const db = await getAdapter();
  const ctx = await prepareCredentialCtx(db);
  return db.transaction(() =>
    updateInTx(db, db.get(`SELECT * FROM providerNodes WHERE id = ?`, [id]), data, ctx),
  );
}

function deleteInTx(db, row) {
  if (!row) return null;
  db.run(`DELETE FROM providerNodes WHERE id = ?`, [row.id]);
  return rowToNodeMetadata(row);
}

export async function deleteProviderNodeUnscoped(id) {
  const db = await getAdapter();
  return db.transaction(() =>
    deleteInTx(db, db.get(`SELECT * FROM providerNodes WHERE id = ?`, [id])),
  );
}

// ─── Scoped API (YAN-361) ────────────────────────────────────────────────
// Rows resolve through the principal's memberships (no IDOR). Prefixes are
// unique per workspace; gateway prefix resolution is workspace-scoped (getGatewayNodes).
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
  const credCtx = await prepareCredentialCtx(db);
  const params = [workspaceId];
  let sql = `SELECT * FROM providerNodes WHERE workspaceId = ?`;
  if (filter.type) {
    sql += " AND type = ?";
    params.push(filter.type);
  }
  return db.all(sql, params).map((row) => rowToNode(db, row, credCtx));
}

/** Metadata list for responses (YAN-365): never decrypts; rows carry `configured` paths. */
export async function listNodesMetadata(ctx, workspaceId, filter = {}) {
  const db = await getAdapter();
  memberWorkspaceId(ctx, db, workspaceId);
  const params = [workspaceId];
  let sql = `SELECT * FROM providerNodes WHERE workspaceId = ?`;
  if (filter.type) {
    sql += " AND type = ?";
    params.push(filter.type);
  }
  return db.all(sql, params).map(rowToNodeMetadata);
}

export async function getNode(ctx, id) {
  assertCtx(ctx);
  const db = await getAdapter();
  const credCtx = await prepareCredentialCtx(db);
  return rowToNode(db, db.get(MEMBER_ROW, [id, ctx.userId]), credCtx);
}

export async function createNode(ctx, workspaceId, data) {
  const db = await getAdapter();
  const credCtx = await prepareCredentialCtx(db);
  return db.transaction(() => {
    memberWorkspaceId(ctx, db, workspaceId);
    assertPrefixFree(db, workspaceId, data.prefix);
    const node = newNode(data, { workspaceId, createdByUserId: ctx.userId });
    upsert(db, node, credCtx);
    return node;
  });
}

export async function updateNode(ctx, id, data) {
  assertCtx(ctx);
  const db = await getAdapter();
  const credCtx = await prepareCredentialCtx(db);
  return db.transaction(() => {
    const row = db.get(MEMBER_ROW, [id, ctx.userId]);
    if (row && data?.prefix !== undefined) assertPrefixFree(db, row.workspaceId, data.prefix, id);
    return updateInTx(db, row, data, credCtx);
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
