import { getAdapter } from "../driver.js";
import { defaultWorkspaceIdUnscoped } from "./ownership.js";
import { clearCredentialCache } from "../helpers/credentialStorage.js";
import { recordAbsorbed } from "../helpers/codexDuplicateMerge.js";
import { prepareCredentialCtx } from "../helpers/connectionCredentialCtx.js";
import {
  connectionFilter,
  reorderInTx,
  rowToConn,
  rowToConnMetadata,
  upsert,
} from "../helpers/connectionRows.js";
import { createInTx, deleteInTx, updateInTx } from "../helpers/connectionWrites.js";

// Public connections API. The pieces live in ../helpers/connection*.js and the
// scoped (principal-checked) API in ./connectionsScopedRepo.js; both are
// re-exported here so every existing import path keeps working.
export {
  assertCredentialCtxCurrent,
  prepareCredentialCtx,
} from "../helpers/connectionCredentialCtx.js";
export {
  createConnection,
  deleteConnection,
  getConnection,
  listConnections,
  listConnectionsMetadata,
  updateConnection,
} from "./connectionsScopedRepo.js";

export async function getProviderConnectionsUnscoped(filter = {}) {
  const db = await getAdapter();
  const ctx = await prepareCredentialCtx(db);
  const { where, params } = connectionFilter(filter);
  const rows = db.all(
    `SELECT * FROM providerConnections${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`,
    params,
  );
  return rows
    .map((row) => rowToConn(db, row, ctx))
    .sort((a, b) => (a.priority || 999) - (b.priority || 999));
}

export async function getProviderConnectionsMetadataUnscoped(filter = {}) {
  const db = await getAdapter();
  const { where, params } = connectionFilter(filter);
  const rows = db.all(
    `SELECT * FROM providerConnections${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`,
    params,
  );
  return rows.map(rowToConnMetadata).sort((a, b) => (a.priority || 999) - (b.priority || 999));
}

export async function getProviderConnectionByIdUnscoped(id) {
  const db = await getAdapter();
  const ctx = await prepareCredentialCtx(db);
  return rowToConn(db, db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]), ctx);
}

export async function getProviderConnectionMetadataByIdUnscoped(id) {
  const db = await getAdapter();
  return rowToConnMetadata(db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]));
}

// rejectDuplicateName: throw DUPLICATE_CONNECTION_NAME instead of upserting an
// apikey row with the same name. The check runs in the transaction, so two
// concurrent creates cannot both pass it.
export async function createProviderConnectionUnscoped(data, opts = {}) {
  const db = await getAdapter();
  const ctx = await prepareCredentialCtx(db);
  const removed = [];
  let workspaceId = null;
  let conn;
  try {
    conn = await db.transaction(() => {
      workspaceId = defaultWorkspaceIdUnscoped(db);
      return createInTx(db, data, opts, { workspaceId }, ctx, removed);
    });
  } catch (err) {
    if (ctx.encrypted && workspaceId) clearCredentialCache(db, workspaceId);
    throw err;
  }
  recordAbsorbed(removed, conn);
  return conn;
}

// Critical: OAuth refresh token race — atomic merge inside transaction
export async function updateProviderConnectionUnscoped(id, data) {
  const db = await getAdapter();
  const ctx = await prepareCredentialCtx(db);
  return db.transaction(() =>
    updateInTx(db, db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]), data, ctx),
  );
}

/**
 * YAN-1041: transactional read-decide-write on one connection's billingLock.
 * `decide(live)` runs INSIDE the transaction against the live decrypted row and
 * returns a partial patch (applied through the normal update path, which only
 * resets health state when the patch sets testStatus:"active" — billing patches
 * never do, so model locks and auth failures stay untouched) or null to skip.
 * Returns only the lock, never the row: callers must not see credentials.
 * @param {string} id
 * @param {(live: object) => (object|null)} decide
 * @returns {Promise<{ applied: boolean, missing: boolean, billingLock: object|null, disabled?: boolean }>}
 */
export async function mutateBillingLockUnscoped(id, decide) {
  let live = null;
  let merged = null;
  const r = await mutateProviderConnectionUnscoped(
    id,
    (row) => {
      live = row;
      return decide(row);
    },
    (m) => {
      merged = m;
    },
  );
  if (r.missing) return { applied: false, missing: true, billingLock: null };
  if (!r.applied) {
    return {
      applied: false,
      missing: false,
      billingLock: live?.billingLock ?? null,
      disabled: live?.isActive === false,
    };
  }
  return { applied: true, missing: false, billingLock: merged?.billingLock ?? null };
}

/**
 * YAN-1037/1038: generic transactional read-decide-write on one connection.
 * `decide(live)` runs INSIDE the SQLite transaction against the live decrypted
 * row and returns a patch (applied through the normal update path) or null to
 * skip. Returns only `{ applied, missing }`: callers never see the row.
 * `onMerged` is an internal hook (used by mutateBillingLockUnscoped).
 * @param {string} id
 * @param {(live: object) => (object|null)} decide
 * @returns {Promise<{ applied: boolean, missing: boolean }>}
 */
export async function mutateProviderConnectionUnscoped(id, decide, onMerged) {
  const db = await getAdapter();
  const ctx = await prepareCredentialCtx(db);
  return db.transaction(() => {
    const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
    if (!row) return { applied: false, missing: true };
    const patch = decide(rowToConn(db, row, ctx));
    if (!patch) return { applied: false, missing: false };
    const merged = updateInTx(db, row, patch, ctx);
    if (typeof onMerged === "function") onMerged(merged);
    return { applied: true, missing: false };
  });
}

export async function deleteProviderConnectionUnscoped(id) {
  const db = await getAdapter();
  return db.transaction(() =>
    deleteInTx(
      db,
      db.get(`SELECT id, provider, workspaceId FROM providerConnections WHERE id = ?`, [id]),
    ),
  );
}

export async function deleteProviderConnectionsByProviderUnscoped(providerId) {
  const db = await getAdapter();
  const before = db.get(`SELECT COUNT(*) AS n FROM providerConnections WHERE provider = ?`, [
    providerId,
  ]);
  db.run(`DELETE FROM providerConnections WHERE provider = ?`, [providerId]);
  return before?.n || 0;
}

export async function reorderProviderConnectionsUnscoped(providerId) {
  const db = await getAdapter();
  db.transaction(() => {
    const parts = db.all(
      `SELECT DISTINCT workspaceId FROM providerConnections WHERE provider = ?`,
      [providerId],
    );
    for (const { workspaceId } of parts) reorderInTx(db, providerId, workspaceId);
  });
}

export async function cleanupProviderConnectionsUnscoped() {
  const db = await getAdapter();
  const ctx = await prepareCredentialCtx(db);
  const fieldsToCheck = [
    "displayName",
    "email",
    "globalPriority",
    "defaultModel",
    "accessToken",
    "refreshToken",
    "expiresAt",
    "tokenType",
    "scope",
    "projectId",
    "apiKey",
    "testStatus",
    "lastTested",
    "lastError",
    "lastErrorAt",
    "rateLimitedUntil",
    "expiresIn",
    "consecutiveUseCount",
  ];
  let cleaned = 0;
  db.transaction(() => {
    const rows = db.all(`SELECT * FROM providerConnections`);
    for (const row of rows) {
      const conn = rowToConn(db, row, ctx);
      let dirty = false;
      for (const f of fieldsToCheck) {
        if (conn[f] === null || conn[f] === undefined) {
          if (f in conn) {
            delete conn[f];
            cleaned++;
            dirty = true;
          }
        }
      }
      if (conn.providerSpecificData && Object.keys(conn.providerSpecificData).length === 0) {
        delete conn.providerSpecificData;
        cleaned++;
        dirty = true;
      }
      if (dirty) upsert(db, conn, ctx);
    }
  });
  return cleaned;
}
