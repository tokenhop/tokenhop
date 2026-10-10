import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { assertCtx } from "@/lib/users/errors.js";
import { audit } from "@/lib/users/audit.js";
import { defaultWorkspaceIdUnscoped, memberWorkspaceId } from "./ownership.js";
import {
  decodeCredentialRowSync,
  encodeCredentialRowSync,
  prepareCredentialContext,
} from "../helpers/credentialStorage.js";
import { readCredentialEncryptionState } from "../credentialEncryptionState.js";
import { loadMasterKey } from "../../security/masterKey.js";
import { TABLE_NAMES } from "../../security/envelope.js";

const TABLE = TABLE_NAMES.providerConnections;

const OPTIONAL_FIELDS = [
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
  "errorCode",
  "consecutiveUseCount",
  "idToken",
  "lastRefreshAt",
];

const MODEL_LOCK_PREFIX = "modelLock_";

function repoFail(code, message) {
  throw Object.assign(new Error(`[credential-repo] ${message}`), { code });
}

// ─── YAN-365 credential context facade ────────────────────────────────────
// Async outer facade: the root is loaded (env/file via masterKey, kid checked
// against the stored marker) BEFORE the sync transaction; the sync row codec
// then runs entirely inside it. Legacy installs never touch the key store.

/**
 * Resolve the runtime credential context for `db`. Trusted loaders only: the
 * root comes from masterKey, never a caller. Shared with nodesRepo and the
 * gateway raw reads.
 * @returns {Promise<object>} context for decode/encodeCredentialRowSync
 */
export async function prepareCredentialCtx(db) {
  const state = readCredentialEncryptionState(db);
  if (state.storage !== "encrypted") return prepareCredentialContext(db, null);
  const root = await loadMasterKey({ expectedKid: state.kekKid });
  return prepareCredentialContext(db, root);
}

/**
 * Re-verify the live marker inside a sync write: an activation/rotation that
 * committed while this context was being prepared must abort the write with a
 * typed error instead of persisting plaintext or wrong-KEK envelopes.
 */
export function assertCredentialCtxCurrent(db, ctx) {
  const live = readCredentialEncryptionState(db);
  if (live.storage !== ctx.state.storage || live.kekKid !== ctx.state.kekKid) {
    repoFail("KEY_MISMATCH", "credential encryption state changed during the operation; retry");
  }
}

function resetHealthStateOnActivation(existing, patch) {
  if (patch?.testStatus !== "active") return patch;

  const normalized = {
    ...patch,
    testStatus: "active",
    lastError: Object.hasOwn(patch, "lastError") ? patch.lastError : null,
    lastErrorAt: Object.hasOwn(patch, "lastErrorAt") ? patch.lastErrorAt : null,
    errorCode: null,
    rateLimitedUntil: null,
    backoffLevel: 0,
  };

  for (const key of Object.keys(existing || {})) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) normalized[key] = null;
  }

  return normalized;
}

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
function rowToConn(db, row, ctx) {
  if (!row) return null;
  const extra = decodeCredentialRowSync(db, row, ctx, { table: TABLE });
  return { ...extra, ...connColumns(row) };
}

/**
 * Metadata decode (never decrypts, needs no root): covered leaves removed and
 * reported as dotted `configured` paths, so one corrupt envelope cannot break
 * a list.
 */
function rowToConnMetadata(row) {
  if (!row) return null;
  const { data, configured } = decodeCredentialRowSync(null, row, null, {
    mode: "metadata",
    table: TABLE,
  });
  return { ...data, ...connColumns(row), configured };
}

function connToRow(c) {
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

function upsert(db, c, ctx) {
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

function deriveConnectionName(data, fallbackName) {
  if (data.provider === "github") {
    return (
      data.providerSpecificData?.githubLogin ||
      data.providerSpecificData?.githubEmail ||
      data.email ||
      data.providerSpecificData?.githubName ||
      fallbackName
    );
  }
  return fallbackName;
}

function connectionFilter(filter = {}) {
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

// Internal sync reorder — must be called INSIDE a transaction
// Priority is dense 1..N per (workspace, provider).
function reorderInTx(db, providerId, workspaceId = null) {
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

// OAuth re-login: fresh token metadata wins, but omitted fields (proxy etc.) and
// user-set weighted overrides (weight, manual planTier) survive.
function mergeReloginProviderData(previous, fresh, provider) {
  if (!previous && !fresh) return undefined;
  const merged = { ...(previous || {}), ...(fresh || {}) };
  if (previous && Object.hasOwn(previous, "weight")) merged.weight = previous.weight;
  // Cursor machineId is a device fingerprint: keep it stable across re-logins so
  // an IDE id captured at import survives a browser re-login (which mints a random
  // one). A fresh import carries the real IDE id, so it still wins.
  if (
    provider === "cursor" &&
    typeof previous?.machineId === "string" &&
    previous.machineId.trim() &&
    fresh?.authMethod !== "imported"
  ) {
    merged.machineId = previous.machineId;
  }
  if (previous?.planTierManual === true) {
    merged.planTier = previous.planTier;
    merged.planTierManual = true;
  } else if (previous && !Object.hasOwn(fresh || {}, "planTier")) {
    delete merged.planTier;
    delete merged.planTierCheckedAt;
  }
  return merged;
}

// YAN-365: patch.providerSpecificData is a DELTA. Siblings always come from
// the live decrypted row inside the same transaction — never from a caller's
// stale snapshot. An explicit null clears the whole object.
function applyPsdDelta(merged, existing, normalized) {
  if (!Object.hasOwn(normalized || {}, "providerSpecificData")) return;
  const patchPsd = normalized.providerSpecificData;
  if (patchPsd === null || patchPsd === undefined) {
    merged.providerSpecificData = patchPsd;
    return;
  }
  const next = { ...(existing.providerSpecificData || {}), ...patchPsd };
  // A null leaf in the delta clears that live key (explicit-clear semantics).
  for (const [key, value] of Object.entries(patchPsd)) if (value === null) delete next[key];
  merged.providerSpecificData = next;
}

// rejectDuplicateName: throw DUPLICATE_CONNECTION_NAME instead of upserting an
// apikey row with the same name. The check runs in the transaction, so two
// concurrent creates cannot both pass it.
export async function createProviderConnectionUnscoped(data, opts = {}) {
  const db = await getAdapter();
  const ctx = await prepareCredentialCtx(db);
  return db.transaction(() =>
    createInTx(db, data, opts, { workspaceId: defaultWorkspaceIdUnscoped(db) }, ctx),
  );
}

// Dedup and priority partition by workspace: the same account in two
// workspaces is two rows, never a merge (YAN-361).
function createInTx(db, data, { rejectDuplicateName = false } = {}, owner = {}, ctx) {
  const now = new Date().toISOString();
  const workspaceId = owner.workspaceId ?? null;
  // Dedup sees decrypted identity metadata (email, username, account ids).
  const all = db
    .all(`SELECT * FROM providerConnections WHERE provider = ? AND workspaceId IS ?`, [
      data.provider,
      workspaceId,
    ])
    .map((row) => rowToConn(db, row, ctx));

  let existing = null;
  if (data.authType === "oauth" && data.email) {
    const incomingUsername = data.providerSpecificData?.username;
    const incomingWs = data.providerSpecificData?.chatgptAccountId;
    existing = all.find((c) => {
      if (c.authType !== "oauth" || c.email !== data.email) return false;

      // Codex/OpenAI can issue multiple OAuth grants for the same email.
      // Refresh tokens are rotated single-use; collapsing a new login onto an
      // existing bare-email row overwrites the first account's token pair and
      // makes it look "invalid" after adding a second account. Only update an
      // existing Codex row when both rows expose the same ChatGPT account ID.
      if (data.provider === "codex") {
        const existingWs = c.providerSpecificData?.chatgptAccountId;
        return !!incomingWs && !!existingWs && incomingWs === existingWs;
      }

      // Workspace providers use workspace ID when both sides have it
      const existingWs = c.providerSpecificData?.chatgptAccountId;
      if (incomingWs && existingWs) return incomingWs === existingWs;
      if (incomingWs && !existingWs) return false;
      if (!incomingWs && existingWs) return false;
      // Non-workspace providers: match on (email + username) so cross-IdP
      // accounts don't overwrite each other. Require username on both sides
      // — if only one side has it, treat as a distinct identity rather than
      // collapsing onto the bare-email fallback (which would re-introduce the
      // cross-IdP overwrite).
      const existingUsername = c.providerSpecificData?.username;
      if (incomingUsername && existingUsername) {
        return incomingUsername === existingUsername;
      }
      if (incomingUsername || existingUsername) return false;
      return true;
    });
  } else if (data.authType === "apikey" && data.name) {
    existing = all.find((c) => c.authType === "apikey" && c.name === data.name);
    if (existing && rejectDuplicateName) {
      const err = new Error(`A connection named "${data.name}" already exists for this provider`);
      err.code = "DUPLICATE_CONNECTION_NAME";
      throw err;
    }
  }
  // access_token: never dedup — user manages duplicates manually

  if (existing) {
    const normalized = resetHealthStateOnActivation(existing, data);
    const merged = { ...existing, ...normalized, updatedAt: now };
    if (data.authType === "oauth") {
      const providerSpecificData = mergeReloginProviderData(
        existing.providerSpecificData,
        data.providerSpecificData,
        data.provider,
      );
      if (providerSpecificData) merged.providerSpecificData = providerSpecificData;
    } else {
      applyPsdDelta(merged, existing, normalized);
    }
    upsert(db, merged, ctx);
    return merged;
  }

  let connectionName = data.name || null;
  if (!connectionName && (data.authType === "oauth" || data.authType === "access_token")) {
    connectionName = deriveConnectionName(data, data.email || `Account ${all.length + 1}`);
  }
  let connectionPriority = data.priority;
  if (!connectionPriority) {
    connectionPriority = all.reduce((m, c) => Math.max(m, c.priority || 0), 0) + 1;
  }

  const conn = {
    id: uuidv4(),
    provider: data.provider,
    authType: data.authType || "oauth",
    name: connectionName,
    priority: connectionPriority,
    isActive: data.isActive !== undefined ? data.isActive : true,
    createdAt: now,
    updatedAt: now,
    // Owner fields only once set: switch-off responses keep today's shape.
    ...(workspaceId ? { workspaceId } : {}),
    ...(owner.createdByUserId ? { createdByUserId: owner.createdByUserId } : {}),
  };
  for (const f of OPTIONAL_FIELDS) {
    if (data[f] !== undefined && data[f] !== null) conn[f] = data[f];
  }
  if (data.providerSpecificData && Object.keys(data.providerSpecificData).length > 0) {
    conn.providerSpecificData = data.providerSpecificData;
  }
  if (data.email !== undefined) conn.email = data.email;

  upsert(db, conn, ctx);
  reorderInTx(db, data.provider, workspaceId);
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

// Ownership is immutable here: moves between workspaces are YAN-701. The
// current row is decrypted inside the transaction, the plaintext patch merged
// on top (workspaceId always the stored SQL value), then re-encrypted.
function updateInTx(db, row, data, ctx) {
  if (!row) return null;
  const existing = rowToConn(db, row, ctx);
  const { workspaceId: _ws, createdByUserId: _by, ...patch } = data || {};
  const normalized = resetHealthStateOnActivation(existing, patch);
  const merged = { ...existing, ...normalized, updatedAt: new Date().toISOString() };
  applyPsdDelta(merged, existing, normalized);
  upsert(db, merged, ctx);
  if (patch.priority !== undefined) reorderInTx(db, existing.provider, row.workspaceId);
  return merged;
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
  const db = await getAdapter();
  const ctx = await prepareCredentialCtx(db);
  return db.transaction(() => {
    const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
    if (!row) return { applied: false, missing: true, billingLock: null };
    const live = rowToConn(db, row, ctx);
    const patch = decide(live);
    if (!patch) {
      return {
        applied: false,
        missing: false,
        billingLock: live.billingLock ?? null,
        disabled: live.isActive === false,
      };
    }
    const merged = updateInTx(db, row, patch, ctx);
    return { applied: true, missing: false, billingLock: merged.billingLock ?? null };
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

function deleteInTx(db, row) {
  if (!row) return false;
  db.run(`DELETE FROM providerConnections WHERE id = ?`, [row.id]);
  reorderInTx(db, row.provider, row.workspaceId);
  return true;
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
  const conn = await db.transaction(() => {
    memberWorkspaceId(ctx, db, workspaceId);
    return createInTx(db, data, opts, { workspaceId, createdByUserId: ctx.userId }, credCtx);
  });
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
