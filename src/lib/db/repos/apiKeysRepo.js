import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { readApiKeyStorageState } from "../apiKeyState.js";

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt],
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    db.run(`UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ? WHERE id = ?`, [
      merged.key,
      merged.name,
      merged.machineId,
      merged.isActive ? 1 : 0,
      id,
    ]);
    result = merged;
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}

// ─── Hashed gateway-key storage (YAN-363). Sync + adapter-passed: these run
// inside lifecycle transactions here and in usersRepo/membershipsRepo.
// No runtime migration: the hashed shape comes from HASHED_API_KEYS_TABLE in
// ../schema.js and is installed only by the (later) switch-on migration or a
// test fixture. These helpers must not import the DB barrel, session, or the
// feature switch. ───

const HASHED_COLUMNS = [
  "id",
  "workspaceId",
  "userId",
  "createdByUserId",
  "keyHash",
  "hashKid",
  "prefix",
  "name",
  "machineId",
  "legacy",
  "isActive",
  "revokedAt",
  "allowedModels",
  "allowedCombos",
  "expiresAt",
  "lastUsedAt",
  "createdAt",
];
// Hash-only: 64 hex (HMAC-SHA256) and 16 hex (masterKeyId = first16 of SHA256).
const HASH_RE = /^[0-9a-f]{64}$/;
const KID_RE = /^[0-9a-f]{16}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Canonicalize to millisecond ISO so stored/compare strings are equal for equal instants. */
function toIsoMs(value) {
  return new Date(value).toISOString();
}

/** One error type for every strict row-validation failure. */
function invalidRow(why) {
  throw new Error(`Invalid hashed API key row: ${why}`);
}

function optId(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    invalidRow(`${field} must be a non-empty string or null`);
  }
  return value;
}

function iso(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !ISO_RE.test(value) || Number.isNaN(Date.parse(value))) {
    invalidRow(`${field} must be an ISO-8601 UTC string or null`);
  }
  const canonical = toIsoMs(value);
  if (canonical.slice(0, 19) !== value.slice(0, 19)) {
    invalidRow(`${field} contains an impossible calendar date or time`);
  }
  return canonical;
}

function scopeArray(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 128) {
    invalidRow(`${field} must be an array of at most 128 strings`);
  }
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > 256) {
      invalidRow(`${field} entries must be strings of 1-256 chars`);
    }
  }
  return value;
}

/** Strict hash-only row validation; returns the normalized row it inserts. */
function validateHashedRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) invalidRow("row object required");
  for (const field of Object.keys(row)) {
    if (!HASHED_COLUMNS.includes(field)) invalidRow(`unknown field "${field}"`); // key/plain/budgetId/…
  }
  const normalized = {
    id: row.id === undefined || row.id === null ? uuidv4() : row.id,
    workspaceId: row.workspaceId,
    userId: optId(row.userId, "userId"),
    createdByUserId: optId(row.createdByUserId, "createdByUserId"),
    keyHash: row.keyHash,
    hashKid: row.hashKid,
    prefix: row.prefix,
    name: optId(row.name, "name"),
    machineId: optId(row.machineId, "machineId"),
    legacy: row.legacy === undefined || row.legacy === null ? 0 : row.legacy,
    isActive: row.isActive === undefined || row.isActive === null ? 1 : row.isActive,
    revokedAt: iso(row.revokedAt, "revokedAt"),
    allowedModels: scopeArray(row.allowedModels, "allowedModels"),
    allowedCombos: scopeArray(row.allowedCombos, "allowedCombos"),
    expiresAt: iso(row.expiresAt, "expiresAt"),
    lastUsedAt: iso(row.lastUsedAt, "lastUsedAt"),
    createdAt: row.createdAt,
  };
  if (typeof normalized.id !== "string" || normalized.id.length === 0) {
    invalidRow("id must be a non-empty string");
  }
  if (typeof normalized.workspaceId !== "string" || normalized.workspaceId.length === 0) {
    invalidRow("workspaceId is required");
  }
  if (typeof normalized.keyHash !== "string" || !HASH_RE.test(normalized.keyHash)) {
    invalidRow("keyHash must be 64 lowercase hex chars");
  }
  if (typeof normalized.hashKid !== "string" || !KID_RE.test(normalized.hashKid)) {
    invalidRow("hashKid must be 16 lowercase hex chars");
  }
  if (typeof normalized.prefix !== "string" || normalized.prefix.length === 0) {
    invalidRow("prefix is required");
  }
  if (normalized.legacy !== 0 && normalized.legacy !== 1) invalidRow("legacy must be 0/1");
  if (normalized.isActive !== 0 && normalized.isActive !== 1) invalidRow("isActive must be 0/1");
  normalized.createdAt = iso(normalized.createdAt, "createdAt");
  if (normalized.createdAt === null) invalidRow("createdAt is required");
  return normalized;
}

/** Insert a hashed row. Callers wrap in a transaction when composing writes. */
export function insertHashedApiKeySync(db, row) {
  const normalized = validateHashedRow(row);
  db.run(
    `INSERT INTO apiKeys(id, workspaceId, userId, createdByUserId, keyHash, hashKid, prefix, name,
      machineId, legacy, isActive, revokedAt, allowedModels, allowedCombos, expiresAt, lastUsedAt, createdAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      normalized.id,
      normalized.workspaceId,
      normalized.userId,
      normalized.createdByUserId,
      normalized.keyHash,
      normalized.hashKid,
      normalized.prefix,
      normalized.name,
      normalized.machineId,
      normalized.legacy,
      normalized.isActive,
      normalized.revokedAt,
      JSON.stringify(normalized.allowedModels),
      JSON.stringify(normalized.allowedCombos),
      normalized.expiresAt,
      normalized.lastUsedAt,
      normalized.createdAt,
    ],
  );
  return { ...normalized, isActive: normalized.isActive === 1, legacy: normalized.legacy };
}

function scopeValue(value, field) {
  if (value === undefined || value === null) return [];
  const parsed = Array.isArray(value)
    ? value
    : (() => {
        try {
          return JSON.parse(value);
        } catch {
          return invalidRow(`${field} is not valid JSON`);
        }
      })();
  if (!Array.isArray(parsed)) invalidRow(`${field} must be an array`);
  return scopeArray(parsed, field);
}

/** Decoded hash-mode row (arrays parsed, flags booleans); tolerates a legacy table (nulls). */
function normalizeHashedRow(row) {
  if (!row) return null;
  return {
    id: row.id ?? null,
    workspaceId: row.workspaceId ?? null,
    userId: optId(row.userId, "userId"),
    createdByUserId: optId(row.createdByUserId, "createdByUserId"),
    keyHash: row.keyHash ?? null,
    hashKid: row.hashKid ?? null,
    prefix: row.prefix ?? row.key?.slice(0, 4) ?? null, // ponytail: legacy prefix fallback, drop at migration
    name: optId(row.name, "name"),
    machineId: optId(row.machineId, "machineId"),
    legacy: row.legacy === 1 || row.legacy === true ? 1 : 0,
    isActive: row.isActive === 1 || row.isActive === true,
    revokedAt: row.revokedAt == null ? null : toIsoMs(row.revokedAt),
    allowedModels: scopeValue(row.allowedModels, "allowedModels"),
    allowedCombos: scopeValue(row.allowedCombos, "allowedCombos"),
    expiresAt: row.expiresAt == null ? null : toIsoMs(row.expiresAt),
    lastUsedAt: row.lastUsedAt == null ? null : toIsoMs(row.lastUsedAt),
    createdAt: row.createdAt == null ? null : toIsoMs(row.createdAt),
  };
}

export function getHashedApiKeyByHashUnscoped(db, keyHash) {
  return normalizeHashedRow(db.get(`SELECT * FROM apiKeys WHERE keyHash = ?`, [keyHash]));
}

const ELIGIBLE_SQL = `
  SELECT k.* FROM apiKeys k
  JOIN workspaces w ON w.id = k.workspaceId
  JOIN _meta mv ON mv.key = 'apiKeysHashedVersion' AND mv.value = '1'
  JOIN _meta mk ON mk.key = 'apiKeysHashKid' AND mk.value = k.hashKid
  LEFT JOIN users u ON u.id = k.userId
  LEFT JOIN memberships m ON m.workspaceId = k.workspaceId AND m.userId = k.userId
  WHERE k.id = ? AND k.keyHash = ? AND k.isActive = 1 AND k.revokedAt IS NULL
    AND (k.expiresAt IS NULL OR k.expiresAt > ?)
    AND (k.userId IS NULL OR (u.status = 'active' AND u.instanceRole != 'pending' AND m.userId IS NOT NULL))`;

/**
 * Live eligibility (YAN-363): hash match, pause/tombstone/expiry (expire at
 * equality), and — for user keys only — active non-pending user + live
 * membership in the key's workspace. Service keys (userId NULL) are
 * independent of creator and member churn. Returns the decoded row or null;
 * null on a legacy-shaped table (no keyHash column).
 */
export function getEligibleApiKeySync(db, id, { keyHash, now = new Date().toISOString() } = {}) {
  if (readApiKeyStorageState(db).storage === "legacy") return null;
  if (!id || typeof keyHash !== "string" || !HASH_RE.test(keyHash)) return null;
  if (iso(now, "now") === null) invalidRow("now must be an ISO-8601 UTC string");
  return normalizeHashedRow(db.get(ELIGIBLE_SQL, [id, keyHash, toIsoMs(now)]));
}

/** Hashed schema required once the durable marker says hashed (fail closed, never legacy fallback). */
function requireHashedTable(db) {
  const cols = db.all(`PRAGMA table_info(apiKeys)`).map((c) => c.name);
  if (!cols.includes("keyHash") || !cols.includes("revokedAt")) {
    const err = new Error("Invalid hashed apiKeys schema for hashed storage state");
    err.code = "API_KEY_STATE_INVALID";
    throw err;
  }
}

/**
 * Set the permanent revokedAt tombstone on a user's keys. Marker decides:
 * legacy is a no-op (byte-identical pristine behavior; hashed keys only
 * exist after the migration). Hashed storage requires the hashed schema.
 * Never overwrites an existing tombstone, never revokes service keys, never
 * deletes rows (usage attribution stays intact).
 */
export function revokeUserApiKeysSync(
  db,
  userId,
  { workspaceId = null, now = new Date().toISOString() } = {},
) {
  if (!userId) return 0;
  const state = readApiKeyStorageState(db);
  if (state.storage === "legacy") return 0;
  requireHashedTable(db);
  if (iso(now, "now") === null) invalidRow("now must be an ISO-8601 UTC string");
  const canonicalNow = toIsoMs(now);
  const scope = workspaceId ? `AND workspaceId = ?` : "";
  const params = workspaceId ? [canonicalNow, userId, workspaceId] : [canonicalNow, userId];
  const { changes } = db.run(
    `UPDATE apiKeys SET revokedAt = ? WHERE userId = ? AND revokedAt IS NULL ${scope}`,
    params,
  );
  return changes ?? 0;
}

/** Safe explicit metadata projection: no raw key, keyHash, or hashKid ever leaves. */
export function apiKeyMetadata(row) {
  const r = normalizeHashedRow(row);
  const metadata = {};
  for (const field of [
    "id",
    "workspaceId",
    "userId",
    "createdByUserId",
    "name",
    "prefix",
    "machineId",
    "legacy",
    "isActive",
    "revokedAt",
    "allowedModels",
    "allowedCombos",
    "expiresAt",
    "lastUsedAt",
    "createdAt",
  ]) {
    metadata[field] = r?.[field] ?? null;
  }
  metadata.type = r?.userId ? "user" : r ? "service" : null;
  return metadata;
}
