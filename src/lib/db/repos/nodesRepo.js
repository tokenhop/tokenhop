import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { TenancyError, assertCtx } from "@/lib/users/errors.js";
import { defaultWorkspaceIdUnscoped, memberWorkspaceId } from "./ownership.js";
import { parseJson } from "../helpers/jsonCol.js";
import {
  decodeCredentialRowSync,
  encodeCredentialRowSync,
  parseCredentialBlob,
} from "../helpers/credentialStorage.js";
import { CREDENTIAL_FIELD_ALLOWLIST, TABLE_NAMES } from "../../security/envelope.js";
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

// ─── Gateway routing read (YAN-378) ──────────────────────────────────────
// Prefix/type resolution needs no secrets. Output is an explicit allowlist of
// non-secret node fields (not a redaction of the whole blob), so nested or
// unlisted credential-like leaves (providerSpecificData, headers, custom
// keys) can never survive. Never decrypts and never loads the root key.
// This is a leak-minimizing projection, not a claim that the secret codec's
// allowlist covers every credential-like field.
const ROUTING_STRING_FIELDS = ["prefix", "apiType", "baseUrl", "fimTemplate"];
const ROUTING_FILTER_KEYS = new Set(["types", "workspaceId"]);

function invalidFilter(message) {
  throw Object.assign(new TypeError(`[nodes-routing] ${message}`), { code: "INVALID_FILTER" });
}

// types: absent = any type; [] = matches nothing; else non-empty strings.
// workspaceId: absent or null = no workspace filter (legacy/host); present
// must be a non-empty string (an empty/undefined value never drops the filter).
function checkRoutingFilter(filter) {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
    invalidFilter("filter must be an object");
  }
  for (const key of Object.keys(filter)) {
    if (!ROUTING_FILTER_KEYS.has(key)) invalidFilter(`unknown filter key: ${key}`);
  }
  const { types } = filter;
  if (types !== undefined) {
    if (!Array.isArray(types) || types.some((t) => typeof t !== "string" || t.length === 0)) {
      invalidFilter("types must be an array of non-empty strings");
    }
  }
  if (Object.hasOwn(filter, "workspaceId")) {
    const ws = filter.workspaceId;
    if (ws !== null && (typeof ws !== "string" || ws.length === 0)) {
      invalidFilter("workspaceId must be a non-empty string or null");
    }
  }
}

function rowToRoutingNode(row) {
  const blob = parseCredentialBlob(row.data);
  const node = {
    id: row.id,
    type: row.type,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
  };
  for (const field of ROUTING_STRING_FIELDS) {
    if (typeof blob[field] === "string") node[field] = blob[field];
  }
  node.configured = CREDENTIAL_FIELD_ALLOWLIST[TABLE].filter(
    (f) => blob[f] !== undefined && blob[f] !== null && blob[f] !== "",
  );
  return node;
}

export async function getProviderNodesRoutingUnscoped(filter = {}) {
  checkRoutingFilter(filter);
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.types !== undefined) {
    where.push(`type IN (${filter.types.map(() => "?").join(",") || "NULL"})`);
    params.push(...filter.types);
  }
  if (typeof filter.workspaceId === "string") {
    where.push("workspaceId = ?");
    params.push(filter.workspaceId);
  }
  const sql = `SELECT id, type, name, data, createdAt, updatedAt, workspaceId FROM providerNodes${
    where.length ? ` WHERE ${where.join(" AND ")}` : ""
  }`;
  return db.all(sql, params).map(rowToRoutingNode);
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
    // Only meaningful for completions nodes (YAN-734); omitted otherwise.
    ...(data.apiType === "completions" && data.fimTemplate
      ? { fimTemplate: data.fimTemplate }
      : {}),
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
