import { decodeCredentialRowSync, encodeCredentialRowSync } from "./credentialStorage.js";
import { TABLE_NAMES } from "../../security/envelope.js";
import { assertCredentialCtxCurrent } from "./connectionCredentialCtx.js";

// Row codec, filters and priority reorder shared by the connection repo modules.
export const TABLE = TABLE_NAMES.providerConnections;

function connColumns(row) {
  return {
    id: row.id,
    provider: row.provider,
    authType: row.authType,
    name: row.name,
    email: row.email,
    priority: row.priority,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // YAN-361: owner columns, only once set (pre-bootstrap rows look as before).
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    ...(row.createdByUserId ? { createdByUserId: row.createdByUserId } : {}),
  };
}

/** Runtime decode: covered leaves decrypted with the row's stored SQL coordinates. */
export function rowToConn(db, row, ctx) {
  if (!row) return null;
  const extra = decodeCredentialRowSync(db, row, ctx, { table: TABLE });
  return { ...extra, ...connColumns(row) };
}

/**
 * Metadata decode (never decrypts, needs no root): covered leaves removed and
 * reported as dotted `configured` paths, so one corrupt envelope cannot break
 * a list.
 */
export function rowToConnMetadata(row) {
  if (!row) return null;
  const { data, configured } = decodeCredentialRowSync(null, row, null, {
    mode: "metadata",
    table: TABLE,
  });
  return { ...data, ...connColumns(row), configured };
}

export function connToRow(c) {
  const {
    id,
    provider,
    authType,
    name,
    email,
    priority,
    isActive,
    createdAt,
    updatedAt,
    workspaceId,
    createdByUserId,
    ...rest
  } = c;
  return {
    workspaceId: workspaceId ?? null,
    createdByUserId: createdByUserId ?? null,
    id,
    provider,
    authType,
    name: name ?? null,
    email: email ?? null,
    priority: priority ?? null,
    isActive: isActive === false ? 0 : 1,
    data: rest,
    createdAt,
    updatedAt,
  };
}

export function upsert(db, c, ctx) {
  const r = connToRow(c);
  assertCredentialCtxCurrent(db, ctx);
  const data = encodeCredentialRowSync(db, r, ctx, { table: TABLE });
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, workspaceId, createdByUserId)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider=excluded.provider, authType=excluded.authType, name=excluded.name,
       email=excluded.email, priority=excluded.priority, isActive=excluded.isActive,
       data=excluded.data, updatedAt=excluded.updatedAt,
       workspaceId=COALESCE(workspaceId, excluded.workspaceId),
       createdByUserId=COALESCE(createdByUserId, excluded.createdByUserId)`,
    [
      r.id,
      r.provider,
      r.authType,
      r.name,
      r.email,
      r.priority,
      r.isActive,
      data,
      r.createdAt,
      r.updatedAt,
      r.workspaceId,
      r.createdByUserId,
    ],
  );
}

export function connectionFilter(filter = {}) {
  const where = [];
  const params = [];
  if (filter.provider) {
    where.push("provider = ?");
    params.push(filter.provider);
  }
  if (filter.isActive !== undefined) {
    where.push("isActive = ?");
    params.push(filter.isActive ? 1 : 0);
  }
  return { where, params };
}

// Internal sync reorder — must be called INSIDE a transaction
// Priority is dense 1..N per (workspace, provider).
export function reorderInTx(db, providerId, workspaceId = null) {
  const list = db
    .all(
      `SELECT id, priority, updatedAt FROM providerConnections WHERE provider = ? AND workspaceId IS ?`,
      [providerId, workspaceId],
    )
    .map((r) => ({ id: r.id, priority: r.priority, updatedAt: r.updatedAt }));
  list.sort((a, b) => {
    const pDiff = (a.priority || 0) - (b.priority || 0);
    if (pDiff !== 0) return pDiff;
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
  list.forEach((c, i) => {
    db.run(`UPDATE providerConnections SET priority = ? WHERE id = ?`, [i + 1, c.id]);
  });
}
