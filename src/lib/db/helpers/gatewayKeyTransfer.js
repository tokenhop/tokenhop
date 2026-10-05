// YAN-363 instance transfer: format v2 hashed snapshots + legacy→hashed
// import conversion. Sync + adapter-passed, same contract as the storage and
// migration helpers — no barrel/driver/session imports (cycle-free). The
// master key is supplied separately by the caller (approved Q4 policy) and is
// only ever used to verify root identity or HMAC incoming legacy keys; it is
// never written anywhere. Raw gateway keys never survive an import into a
// hashed instance.
import { deriveApiKeyHashKey, hashApiKey, masterKeyId } from "../../security/masterKey.js";
import { apiKeyPrefix } from "../../../shared/utils/apiKey.js";
import { GATEWAY_VIDEO_JOBS_TABLE_SQL } from "../repos/gatewayVideoJobsRepo.js";
import { readApiKeyStorageState } from "../apiKeyState.js";
import { insertHashedApiKeySync } from "../repos/apiKeysRepo.js";
import { getMetaSync, setMetaSync } from "./metaStore.js";
import { parseJson, stringifyJson } from "./jsonCol.js";

export const TRANSFER_FORMAT_VERSION = 2;
const KID_RE = /^[0-9a-f]{16}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const RAW_MAX_BYTES = 4096; // same bound as the gateway principal resolver
const INSTANCE_ROLES = new Set(["owner", "admin", "user", "pending"]);
const USER_STATUS = new Set(["active", "disabled"]);
const IDENTITY_PROVIDERS = new Set(["password", "oidc", "saml", "header"]);
const WORKSPACE_KINDS = new Set(["personal", "shared"]);
const MEMBERSHIP_ROLES = new Set(["owner", "manager", "member", "viewer"]);
const MEMBERSHIP_SOURCES = new Set(["manual", "invite", "idp"]);
const KV_SCOPES = [
  "modelAliases",
  "customModels",
  "mitmAlias",
  "cliToolSettings",
  "cliToolPresets",
  "pricing",
];
// Column set of HASHED_API_KEYS_TABLE in ../schema.js (kept local so schema
// definition stays the single runtime source; preflight mirrors it strictly).
const HASHED_KEY_COLUMNS = new Set([
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
]);
const SECRET_KEY_FIELDS = ["key", "plain", "secret", "raw"];
// Master material never travels in a snapshot; body-supplied roots are
// refused even before format detection so no path can ever trust them.
const PAYLOAD_MASTER_FIELDS = ["masterKey", "master", "masterSecret", "apiKeyMaster"];

export class TransferError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TransferError";
    this.code = code;
  }
}

// Mirrors MITM_VERIFIER_SETTING in src/lib/auth/mitmCredential.js — duplicated
// here on purpose: this helper must stay import-cycle-free (see header).
const MITM_VERIFIER_SETTING = "mitmInternalVerifier";

/**
 * Machine-local exclusion for full-DB restores: an imported
 * `mitmInternalVerifier` is never trusted (the hash is host-bound to the
 * spawning parent's raw-credential custody), while the live local verifier
 * survives the destructive settings replacement so a running MITM child
 * keeps authenticating. Mutates `settings` in place and returns the object
 * to persist; touches nothing else.
 * @param {object} db Adapter (sync API).
 * @param {object|undefined} settings Payload settings section (mutated).
 * @returns {object|undefined} Settings to persist.
 */
export function preserveLocalVerifierSettings(db, settings) {
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  const live = row ? parseJson(row.data, {}) : {};
  const local = live[MITM_VERIFIER_SETTING];
  const hasLocal = typeof local === "string" && local.length > 0;
  if (settings === undefined || settings === null) {
    return hasLocal ? { [MITM_VERIFIER_SETTING]: local } : settings;
  }
  if (hasLocal) settings[MITM_VERIFIER_SETTING] = local;
  else delete settings[MITM_VERIFIER_SETTING];
  return settings;
}

function fail(code, message) {
  throw new TransferError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optId(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    fail("TRANSFER_STATE_INVALID", `${field} must be a non-empty string or null`);
  }
  return value;
}

function isoOrNull(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !ISO_RE.test(value) || Number.isNaN(Date.parse(value))) {
    fail("TRANSFER_STATE_INVALID", `${field} must be an ISO-8601 UTC string or null`);
  }
  return value;
}

function scopeArray(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 128) {
    fail("TRANSFER_STATE_INVALID", `${field} must be an array of at most 128 strings`);
  }
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > 256) {
      fail("TRANSFER_STATE_INVALID", `${field} entries must be strings of 1-256 chars`);
    }
  }
  return value;
}

/**
 * Durable storage state + live apiKeys table shape, cross-checked. Marker and
 * shape must agree before any transfer decision: hashed marker requires the
 * hashed table, legacy marker requires the legacy raw-key table. Anything
 * else is TRANSFER_STATE_INVALID (a corrupt marker pair propagates
 * API_KEY_STATE_INVALID from ../apiKeyState.js).
 */
export function gatewayKeyStorageSnapshot(db) {
  const state = readApiKeyStorageState(db);
  const columns = new Set(db.all("PRAGMA table_info(apiKeys)").map((c) => c.name));
  let hashedTable;
  if (state.storage === "hashed") {
    for (const c of HASHED_KEY_COLUMNS) {
      if (!columns.has(c)) fail("TRANSFER_STATE_INVALID", "apiKeys table misses hashed columns");
    }
    if (columns.has("key")) fail("TRANSFER_STATE_INVALID", "apiKeys table still has a raw column");
    hashedTable = true;
  } else {
    if (!columns.has("key") || columns.has("keyHash")) {
      fail("TRANSFER_STATE_INVALID", "apiKeys table shape does not match the legacy marker");
    }
    hashedTable = false;
  }
  return { ...state, hashedTable };
}

/** Read live video-job rows ([] when the activation table is not installed). */
function liveGatewayVideoJobs(db) {
  if (!db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gatewayVideoJobs'`))
    return [];
  return db.all("SELECT * FROM gatewayVideoJobs");
}

function hashedRowOut(row) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    keyHash: row.keyHash,
    hashKid: row.hashKid,
    prefix: row.prefix,
    name: row.name ?? null,
    machineId: row.machineId ?? null,
    legacy: row.legacy === 1 ? 1 : 0,
    isActive: row.isActive === 1 ? 1 : 0,
    revokedAt: row.revokedAt ?? null,
    allowedModels: parseJson(row.allowedModels, []),
    allowedCombos: parseJson(row.allowedCombos, []),
    expiresAt: row.expiresAt ?? null,
    lastUsedAt: row.lastUsedAt ?? null,
    createdAt: row.createdAt,
  };
}

/**
 * Enrich the legacy export payload with the format v2 hashed sections: key
 * metadata (keyHash/hashKid/prefix, never a raw key), users/identities/
 * workspaces/memberships, the security marker, and Default-workspace tenancy.
 * Fails closed instead of exporting rows that contradict the durable marker.
 */
export function exportGatewayKeySnapshot(db, out, state) {
  if (state.storage !== "hashed") return out;
  for (const row of db.all("SELECT * FROM apiKeys")) {
    if (row.hashKid !== state.hashKid || !HASH_RE.test(row.keyHash ?? "")) {
      fail("TRANSFER_STATE_INVALID", "apiKeys row contradicts the durable hash marker");
    }
  }
  out.formatVersion = TRANSFER_FORMAT_VERSION;
  out.apiKeyStorage = { storage: "hashed", version: state.version, hashKid: state.hashKid };
  out.apiKeys = db.all("SELECT * FROM apiKeys").map(hashedRowOut);
  out.users = db.all("SELECT * FROM users");
  out.identities = db.all("SELECT * FROM identities");
  out.workspaces = db.all("SELECT * FROM workspaces");
  out.memberships = db.all("SELECT * FROM memberships");
  out.tenancy = { defaultWorkspaceId: getMetaSync(db, "defaultWorkspaceId") };
  // Connections/nodes: re-map with the ownership columns — the legacy export
  // mapping drops them, and a hashed snapshot must preserve workspace binding.
  out.providerConnections = db.all(`SELECT * FROM providerConnections`).map((r) => ({
    ...parseJson(r.data, {}),
    id: r.id,
    provider: r.provider,
    authType: r.authType,
    name: r.name,
    email: r.email,
    priority: r.priority,
    isActive: r.isActive === 1 || r.isActive === true,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    workspaceId: r.workspaceId ?? null,
    createdByUserId: r.createdByUserId ?? null,
  }));
  out.providerNodes = db.all(`SELECT * FROM providerNodes`).map((r) => ({
    ...parseJson(r.data, {}),
    id: r.id,
    type: r.type,
    name: r.name,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    workspaceId: r.workspaceId ?? null,
    createdByUserId: r.createdByUserId ?? null,
  }));
  // Full parity: durable video-job bindings travel with the instance snapshot
  // (triple PK + connection/model provenance, matching the repo's contract).
  out.gatewayVideoJobs = liveGatewayVideoJobs(db);
  validateConfigShape(out);
  validateVideoJobRefs(out, {
    workspaces: new Set(out.workspaces.map((w) => w.id)),
    connectionsById: new Map(out.providerConnections.map((c) => [c.id, c])),
  });
  return out;
}

/** payload format: "hashed" (v2 snapshot) or "legacy" (v1/current shape). */
function payloadFormat(payload) {
  const version = payload.formatVersion ?? 1;
  if (version === 1) {
    if (payload.apiKeyStorage !== undefined) {
      fail("TRANSFER_STATE_INVALID", "apiKeyStorage requires formatVersion 2");
    }
    return "legacy";
  }
  if (version !== 2)
    fail("TRANSFER_STATE_INVALID", `Unsupported snapshot formatVersion ${version}`);
  const storage = payload.apiKeyStorage;
  if (
    !isPlainObject(storage) ||
    storage.storage !== "hashed" ||
    storage.version !== 1 ||
    typeof storage.hashKid !== "string" ||
    !KID_RE.test(storage.hashKid)
  ) {
    fail("TRANSFER_STATE_INVALID", "Malformed apiKeyStorage marker in snapshot");
  }
  return "hashed";
}

function assertMaster(masterKey) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
    fail("TRANSFER_MASTER_KEY_INVALID", "masterKey must be a 32-byte Buffer");
  }
  return masterKey;
}

function requireArray(payload, field) {
  const value = payload[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail("TRANSFER_STATE_INVALID", `${field} must be an array`);
  return value;
}

function assertNoSecretFields(row, context) {
  for (const field of SECRET_KEY_FIELDS) {
    if (row[field] !== undefined && row[field] !== null) {
      fail("TRANSFER_RAW_LEAK", `${context} carries a raw "${field}" value; values withheld`);
    }
  }
}

/**
 * Structural checks for every generic config section, so a malformed body
 * fails as a typed TransferError in preflight instead of a raw binding error
 * mid-apply (which would still roll back, but without a stable contract).
 * Mirrors exactly what the apply loops bind.
 */
function validateConfigShape(payload) {
  for (const field of PAYLOAD_MASTER_FIELDS) {
    if (payload[field] !== undefined) {
      fail(
        "TRANSFER_STATE_INVALID",
        `payload must not carry "${field}"; never send master material`,
      );
    }
  }
  for (const field of [
    "settings",
    "tenancy",
    "apiKeyStorage",
    "modelAliases",
    "mitmAlias",
    "cliToolSettings",
    "cliToolPresets",
    "pricing",
  ]) {
    const value = payload[field];
    if (value !== undefined && value !== null && !isPlainObject(value)) {
      fail("TRANSFER_STATE_INVALID", `${field} must be an object`);
    }
  }
  for (const field of [
    "providerConnections",
    "providerNodes",
    "proxyPools",
    "combos",
    "customModels",
    "gatewayVideoJobs",
  ]) {
    const value = payload[field];
    if (field === "gatewayVideoJobs") {
      // Own-present section must be a real array: null/object/string/number
      // would otherwise flow into requireArray null->[] and silently wipe live
      // job bindings. Absent (no own property) stays the older-v2 retained-live
      // path; explicit [] is the intentional clear.
      if (Object.hasOwn(payload, field) && !Array.isArray(value)) {
        fail("TRANSFER_STATE_INVALID", `${field} must be an array`);
      }
      continue;
    }
    if (value !== undefined && value !== null && !Array.isArray(value)) {
      fail("TRANSFER_STATE_INVALID", `${field} must be an array`);
    }
  }
  for (const [kind, items] of Object.entries(payload.cliToolPresets ?? {})) {
    if (!["endpoints", "apiKeys"].includes(kind) || !Array.isArray(items)) continue;
    for (const [index, item] of items.entries()) {
      if (!isPlainObject(item)) {
        fail("TRANSFER_STATE_INVALID", `cliToolPresets.${kind}[${index}] must be an object`);
      }
    }
  }
  for (const c of payload.combos ?? []) {
    if (!isPlainObject(c) || typeof c.id !== "string" || typeof c.name !== "string") {
      fail("TRANSFER_STATE_INVALID", "combos entries need string id and name");
    }
  }
  for (const c of payload.providerConnections ?? []) {
    if (!isPlainObject(c) || typeof c.id !== "string" || typeof c.provider !== "string") {
      fail("TRANSFER_STATE_INVALID", "providerConnections entries need string id and provider");
    }
  }
  for (const n of payload.providerNodes ?? []) {
    if (!isPlainObject(n) || typeof n.id !== "string") {
      fail("TRANSFER_STATE_INVALID", "providerNodes entries need string id");
    }
  }
  for (const p of payload.proxyPools ?? []) {
    if (!isPlainObject(p) || typeof p.id !== "string") {
      fail("TRANSFER_STATE_INVALID", "proxyPools entries need string id");
    }
  }
  for (const m of payload.customModels ?? []) {
    if (!isPlainObject(m) || typeof m.providerAlias !== "string" || typeof m.id !== "string") {
      fail("TRANSFER_STATE_INVALID", "customModels entries need providerAlias and id");
    }
  }

  // Job bindings reuse the activation lane's immutable contract (repo SQL
  // types read-only here). Shape first; workspace/connection refs below.
  for (const job of payload.gatewayVideoJobs ?? []) {
    if (!isPlainObject(job))
      fail("TRANSFER_STATE_INVALID", "gatewayVideoJobs entries must be objects");
    for (const field of ["workspaceId", "jobId", "provider", "connectionId", "modelId"]) {
      if (typeof job[field] !== "string" || !job[field] || job[field].length > 2048) {
        fail("TRANSFER_STATE_INVALID", `gatewayVideoJobs entry has invalid ${field}`);
      }
    }
    if (isoOrNull(job.createdAt, "video job createdAt") === null) {
      fail("TRANSFER_STATE_INVALID", "video job createdAt required");
    }
    if (!job.modelId.startsWith(`${job.provider}/`) || job.modelId === `${job.provider}/`) {
      fail("TRANSFER_STATE_INVALID", "gatewayVideoJobs entry has a non-canonical modelId");
    }
  }
}

function validateHashedKeyRow(row, kid, keyHashes) {
  if (!isPlainObject(row)) fail("TRANSFER_STATE_INVALID", "apiKeys entries must be objects");
  assertNoSecretFields(row, "apiKeys entry");
  for (const field of Object.keys(row)) {
    if (!HASHED_KEY_COLUMNS.has(field)) {
      fail("TRANSFER_STATE_INVALID", `apiKeys entry has unknown field "${field}"`);
    }
  }
  if (typeof row.id !== "string" || !row.id) fail("TRANSFER_STATE_INVALID", "apiKey id required");
  if (typeof row.workspaceId !== "string" || !row.workspaceId) {
    fail("TRANSFER_STATE_INVALID", "apiKey workspaceId required");
  }
  if (typeof row.keyHash !== "string" || !HASH_RE.test(row.keyHash)) {
    fail("TRANSFER_STATE_INVALID", "keyHash must be 64 lowercase hex chars");
  }
  if (row.hashKid !== kid) fail("TRANSFER_STATE_INVALID", "apiKey hashKid contradicts snapshot");
  if (typeof row.prefix !== "string" || !row.prefix) {
    fail("TRANSFER_STATE_INVALID", "apiKey prefix required");
  }
  for (const field of ["legacy", "isActive"]) {
    if (row[field] !== undefined && row[field] !== 0 && row[field] !== 1) {
      fail("TRANSFER_STATE_INVALID", `apiKey ${field} must be 0/1`);
    }
  }
  optId(row.userId, "apiKey userId");
  optId(row.createdByUserId, "apiKey createdByUserId");
  optId(row.name, "apiKey name");
  optId(row.machineId, "apiKey machineId");
  isoOrNull(row.revokedAt, "apiKey revokedAt");
  isoOrNull(row.expiresAt, "apiKey expiresAt");
  isoOrNull(row.lastUsedAt, "apiKey lastUsedAt");
  if (isoOrNull(row.createdAt, "apiKey createdAt") === null) {
    fail("TRANSFER_STATE_INVALID", "apiKey createdAt required");
  }
  scopeArray(row.allowedModels, "allowedModels");
  scopeArray(row.allowedCombos, "allowedCombos");
  if (keyHashes.has(row.keyHash)) {
    fail("TRANSFER_STATE_INVALID", "duplicate keyHash in snapshot");
  }
  keyHashes.add(row.keyHash);
}

function validateIdentityGraph(payload, refs) {
  const users = requireArray(payload, "users");
  const emails = new Set();
  const usernames = new Set();
  let owners = 0;
  for (const user of users) {
    if (!isPlainObject(user)) fail("TRANSFER_STATE_INVALID", "users entries must be objects");
    for (const field of ["id", "createdAt", "updatedAt"]) {
      if (typeof user[field] !== "string" || !user[field]) {
        fail("TRANSFER_STATE_INVALID", `users entry misses ${field}`);
      }
    }
    if (!INSTANCE_ROLES.has(user.instanceRole)) {
      fail("TRANSFER_STATE_INVALID", "users entry has an invalid instanceRole");
    }
    if (user.status !== undefined && !USER_STATUS.has(user.status)) {
      fail("TRANSFER_STATE_INVALID", "users entry has an invalid status");
    }
    if (
      user.mustChangePassword !== undefined &&
      user.mustChangePassword !== 0 &&
      user.mustChangePassword !== 1
    ) {
      fail("TRANSFER_STATE_INVALID", "users entry mustChangePassword must be 0/1");
    }
    if (user.instanceRole === "owner" && ++owners > 1) {
      fail("TRANSFER_STATE_INVALID", "snapshot has more than one owner");
    }
    if (user.email != null) {
      const key = String(user.email).toLowerCase();
      if (emails.has(key)) fail("TRANSFER_STATE_INVALID", "duplicate user email in snapshot");
      emails.add(key);
    }
    if (user.username != null) {
      const key = String(user.username).toLowerCase();
      if (usernames.has(key)) fail("TRANSFER_STATE_INVALID", "duplicate username in snapshot");
      usernames.add(key);
    }
    refs.users.add(user.id);
  }
  const workspaces = requireArray(payload, "workspaces");
  const personal = new Set();
  for (const ws of workspaces) {
    if (!isPlainObject(ws)) fail("TRANSFER_STATE_INVALID", "workspaces entries must be objects");
    for (const field of ["id", "name", "createdAt", "updatedAt"]) {
      if (typeof ws[field] !== "string" || !ws[field]) {
        fail("TRANSFER_STATE_INVALID", `workspaces entry misses ${field}`);
      }
    }
    if (!WORKSPACE_KINDS.has(ws.kind)) {
      fail("TRANSFER_STATE_INVALID", "workspaces entry has an invalid kind");
    }
    if (ws.createdBy != null && !refs.users.has(ws.createdBy)) {
      fail("TRANSFER_REF_INVALID", "workspace references an unknown creator");
    }
    if (ws.kind === "personal") {
      const key = ws.createdBy ?? "";
      if (personal.has(key)) {
        fail("TRANSFER_STATE_INVALID", "more than one personal workspace per creator");
      }
      personal.add(key);
    }
    refs.workspaces.add(ws.id);
  }
  for (const identity of requireArray(payload, "identities")) {
    if (!isPlainObject(identity))
      fail("TRANSFER_STATE_INVALID", "identities entries must be objects");
    if (typeof identity.id !== "string" || !identity.id) {
      fail("TRANSFER_STATE_INVALID", "identities entry misses id");
    }
    if (!IDENTITY_PROVIDERS.has(identity.provider)) {
      fail("TRANSFER_STATE_INVALID", "identities entry has an invalid provider");
    }
    if (typeof identity.subject !== "string" || !identity.subject) {
      fail("TRANSFER_STATE_INVALID", "identities entry misses subject");
    }
    if (!refs.users.has(identity.userId)) {
      fail("TRANSFER_REF_INVALID", "identity references an unknown user");
    }
    const key = `${identity.provider}|${identity.issuer ?? ""}|${identity.subject}`;
    if (refs.identities.has(key)) {
      fail("TRANSFER_STATE_INVALID", "duplicate identity in snapshot");
    }
    refs.identities.add(key);
  }
  const seen = new Set();
  for (const membership of requireArray(payload, "memberships")) {
    if (!isPlainObject(membership))
      fail("TRANSFER_STATE_INVALID", "memberships entries must be objects");
    if (!refs.workspaces.has(membership.workspaceId) || !refs.users.has(membership.userId)) {
      fail("TRANSFER_REF_INVALID", "membership references an unknown workspace or user");
    }
    if (
      !MEMBERSHIP_ROLES.has(membership.role) ||
      !MEMBERSHIP_SOURCES.has(membership.source ?? "manual")
    ) {
      fail("TRANSFER_STATE_INVALID", "membership has an invalid role or source");
    }
    const key = `${membership.workspaceId}|${membership.userId}`;
    if (seen.has(key)) fail("TRANSFER_STATE_INVALID", "duplicate membership in snapshot");
    seen.add(key);
  }
  for (const row of requireArray(payload, "providerConnections")) {
    if (!isPlainObject(row)) fail("TRANSFER_STATE_INVALID", "providerConnections must be objects");
    if (row.workspaceId != null && !refs.workspaces.has(row.workspaceId)) {
      fail("TRANSFER_REF_INVALID", "connection references an unknown workspace");
    }
    if (row.createdByUserId != null && !refs.users.has(row.createdByUserId)) {
      fail("TRANSFER_REF_INVALID", "connection references an unknown creator");
    }
  }
  for (const row of requireArray(payload, "providerNodes")) {
    if (!isPlainObject(row)) fail("TRANSFER_STATE_INVALID", "providerNodes must be objects");
    if (row.workspaceId != null && !refs.workspaces.has(row.workspaceId)) {
      fail("TRANSFER_REF_INVALID", "node references an unknown workspace");
    }
    if (row.createdByUserId != null && !refs.users.has(row.createdByUserId)) {
      fail("TRANSFER_REF_INVALID", "node references an unknown creator");
    }
  }
  // Deterministic connection lookup for job provenance: snapshot id →
  // provider + workspace (NULL stays NULL — unscoped legacy rows are caught
  // individually in the job loop below, not blanket rejected).
  const connectionsById = new Map();
  for (const row of requireArray(payload, "providerConnections")) {
    if (connectionsById.has(row.id)) {
      fail("TRANSFER_STATE_INVALID", "duplicate providerConnection id in snapshot");
    }
    connectionsById.set(row.id, row);
  }
  refs.connectionsById = connectionsById;
  validateVideoJobRefs(payload, refs);
}

/**
 * Job provenance: every binding needs a live workspace, the referenced
 * connection must exist with the SAME provider and workspace (ownership),
 * and the (workspace, provider, jobId) triple must be unique (immutable repo
 * contract — a reused upstream id can never silently change authority).
 */
function validateVideoJobRefs(payload, refs) {
  const triples = new Set();
  for (const job of requireArray(payload, "gatewayVideoJobs")) {
    if (!refs.workspaces.has(job.workspaceId)) {
      fail("TRANSFER_REF_INVALID", "video job references an unknown workspace");
    }
    const connection = refs.connectionsById.get(job.connectionId);
    if (!connection) {
      fail("TRANSFER_REF_INVALID", "video job references an unknown connection");
    }
    if (connection.provider !== job.provider) {
      fail("TRANSFER_REF_INVALID", "video job connection has a different provider");
    }
    if (connection.workspaceId !== job.workspaceId) {
      // NULL/foreign workspace never authorizes: unscoped legacy connections
      // and another workspace's rows refuse here, never get adopted silently.
      fail("TRANSFER_REF_INVALID", "video job connection belongs to another workspace");
    }
    const triple = JSON.stringify([job.workspaceId, job.provider, job.jobId]);
    if (triples.has(triple)) {
      fail("TRANSFER_STATE_INVALID", "duplicate video job binding in snapshot");
    }
    triples.add(triple);
  }
}

function validateSnapshotPresets(payload) {
  const presets = payload.cliToolPresets?.apiKeys;
  if (presets === undefined) return;
  if (!Array.isArray(presets)) {
    fail("TRANSFER_STATE_INVALID", "cliToolPresets.apiKeys must be an array");
  }
  for (const [index, item] of presets.entries()) {
    if (!isPlainObject(item)) {
      fail("TRANSFER_STATE_INVALID", `cliToolPresets.apiKeys[${index}] must be an object`);
    }
    assertNoSecretFields(item, `cliToolPresets.apiKeys[${index}]`);
  }
}

function validateLegacyKeys(payload) {
  const keys = requireArray(payload, "apiKeys");
  const ids = new Set();
  for (const key of keys) {
    if (!isPlainObject(key)) fail("TRANSFER_STATE_INVALID", "apiKeys entries must be objects");
    if (typeof key.id !== "string" || !key.id) fail("TRANSFER_STATE_INVALID", "apiKey id required");
    if (ids.has(key.id)) fail("TRANSFER_STATE_INVALID", "duplicate apiKey id in snapshot");
    ids.add(key.id);
    if (
      typeof key.key !== "string" ||
      !key.key ||
      Buffer.byteLength(key.key, "utf8") > RAW_MAX_BYTES
    ) {
      fail("TRANSFER_STATE_INVALID", "legacy apiKey raw key required (≤4096 bytes)");
    }
  }
  return keys;
}

function legacyPresetPlan(payload, keyIdByHash, hashKey) {
  const row = payload.cliToolPresets?.apiKeys;
  if (row === undefined) return null;
  if (!Array.isArray(row))
    fail("TRANSFER_STATE_INVALID", "cliToolPresets.apiKeys must be an array");
  let converted = 0;
  const next = row.map((item, index) => {
    if (!isPlainObject(item) || typeof item.key !== "string" || !item.key) {
      fail(
        "TRANSFER_STATE_INVALID",
        `cliToolPresets.apiKeys[${index}] is malformed; values withheld`,
      );
    }
    const id = keyIdByHash.get(hashApiKey(item.key, hashKey));
    if (id) {
      const { key: _unusedRaw, ...metadata } = item;
      converted++;
      return { ...metadata, apiKeyId: id };
    }
    // D2: no provenance is available at import time, so an unmatched preset
    // stops the transfer before any mutation. Report identity, never the raw.
    return fail(
      "TRANSFER_AMBIGUOUS_PRESET",
      `cliToolPresets.apiKeys[${index}] ("${item.name ?? "unnamed"}") has no matching key; values withheld`,
    );
  });
  return { next, converted };
}

/**
 * Pure preflight — no DB writes. Validates payload shape, root/master/kid
 * consistency, and full ownership/reference integrity across every row BEFORE
 * the destructive import transaction. Returns the plan the apply step uses.
 * instance: gatewayKeyStorageSnapshot(db); masterKey: separately supplied root
 * (approved Q4); defaultWorkspaceId: the live instance's Default workspace id.
 */
export function preflightGatewayKeyImport(
  payload,
  { instance, db, masterKey = null, defaultWorkspaceId = null },
) {
  if (!isPlainObject(payload)) fail("TRANSFER_STATE_INVALID", "Invalid database payload");
  validateConfigShape(payload);
  const format = payloadFormat(payload);
  if (format === "hashed") {
    const kid = payload.apiKeyStorage.hashKid;
    if (instance.storage !== "hashed") {
      // Precise precondition, not a blanket refusal: the destination must
      // already be a hashed-storage instance (switch-on migration done).
      fail(
        "TRANSFER_INSTANCE_MODE_UNSUPPORTED",
        "Hashed snapshots import only into a hashed-storage instance; run the API-key switch-on migration first",
      );
    }
    if (masterKey === null || masterKey === undefined) {
      fail(
        "TRANSFER_MASTER_REQUIRED",
        "Importing into hashed storage requires the instance master key",
      );
    }
    assertMaster(masterKey);
    const suppliedKid = masterKeyId(masterKey);
    if (suppliedKid !== kid) {
      fail("TRANSFER_ROOT_MISMATCH", "Supplied master key does not match the snapshot's root");
    }
    if (kid !== instance.hashKid) {
      fail("TRANSFER_ROOT_MISMATCH", "Snapshot root differs from this instance's root");
    }
    const refs = { users: new Set(), workspaces: new Set(), identities: new Set() };
    validateIdentityGraph(payload, refs);
    const keyHashes = new Set();
    const keyIds = new Set();
    const snapshotKeys = requireArray(payload, "apiKeys");
    for (const row of snapshotKeys) {
      validateHashedKeyRow(row, kid, keyHashes);
      if (keyIds.has(row.id)) {
        fail("TRANSFER_STATE_INVALID", "duplicate apiKey id in snapshot");
      }
      keyIds.add(row.id);
      if (!refs.workspaces.has(row.workspaceId)) {
        fail("TRANSFER_REF_INVALID", "apiKey references an unknown workspace");
      }
      if (row.userId != null && !refs.users.has(row.userId)) {
        fail("TRANSFER_REF_INVALID", "apiKey references an unknown user");
      }
      if (row.createdByUserId != null && !refs.users.has(row.createdByUserId)) {
        fail("TRANSFER_REF_INVALID", "apiKey references an unknown creator");
      }
    }
    validateSnapshotPresets(payload);
    if (payload.tenancy !== undefined && !isPlainObject(payload.tenancy)) {
      fail("TRANSFER_STATE_INVALID", "tenancy must be an object");
    }
    const defaultWs = payload.tenancy?.defaultWorkspaceId;
    if (defaultWs != null && !refs.workspaces.has(defaultWs)) {
      fail("TRANSFER_REF_INVALID", "tenancy.defaultWorkspaceId references an unknown workspace");
    }
    // Older v2 snapshots predate gatewayVideoJobs: an absent own property
    // retains current live bindings (validated against the incoming
    // workspace/connection refs first — incompatible rows reject before any
    // mutation). An explicit [] is the authoritative clear. Build the
    // immutable retained set here in preflight; apply writes only these rows
    // (validated references, never an unchecked payload reread).
    let videoJobs = payload.gatewayVideoJobs;
    if (!Object.hasOwn(payload, "gatewayVideoJobs")) {
      const incoming = { gatewayVideoJobs: liveGatewayVideoJobs(db) };
      validateConfigShape(incoming);
      validateVideoJobRefs(incoming, refs);
      videoJobs = incoming.gatewayVideoJobs;
    }
    videoJobs = Object.freeze((videoJobs ?? []).map((job) => Object.freeze({ ...job })));
    return {
      format,
      kid,
      keyIdByHash: new Map(snapshotKeys.map((r) => [r.keyHash, r.id])),
      videoJobs,
    };
  }
  // Legacy payload.
  const keys = validateLegacyKeys(payload);
  if (instance.storage !== "hashed") return { format };
  if (masterKey === null || masterKey === undefined) {
    fail(
      "TRANSFER_MASTER_REQUIRED",
      "Importing into hashed storage requires the instance master key",
    );
  }
  assertMaster(masterKey);
  const kid = masterKeyId(masterKey);
  if (kid !== instance.hashKid) {
    fail("TRANSFER_ROOT_MISMATCH", "Supplied master key does not match this instance's root");
  }
  if (typeof defaultWorkspaceId !== "string" || !defaultWorkspaceId) {
    fail("TRANSFER_STATE_INVALID", "Hashed instance has no Default workspace for legacy keys");
  }
  // Legacy configuration replacement retains jobs, never silently deletes them.
  // Legacy apply adopts all connections into Default, ignoring input ownership.
  const jobs = liveGatewayVideoJobs(db);
  const retained = { gatewayVideoJobs: jobs };
  validateConfigShape(retained);
  validateVideoJobRefs(retained, {
    workspaces: new Set(db.all("SELECT id FROM workspaces").map((w) => w.id)),
    connectionsById: new Map(
      (payload.providerConnections ?? []).map((c) => [
        c.id,
        { ...c, workspaceId: defaultWorkspaceId },
      ]),
    ),
  });
  const hashKey = deriveApiKeyHashKey(masterKey);
  const keyIdByHash = new Map(keys.map((k) => [hashApiKey(k.key, hashKey), k.id]));
  if (keyIdByHash.size !== keys.length) {
    fail("TRANSFER_STATE_INVALID", "duplicate raw key in legacy snapshot");
  }
  return {
    format,
    kid,
    hashKey,
    defaultWorkspaceId,
    keyIdByHash,
    presets: legacyPresetPlan(payload, keyIdByHash, hashKey),
  };
}

/** Rewrite cliToolPresets with the converted (raw-free) preset list. */
export function applyLegacyPresetConversion(db, presets) {
  if (!presets) return 0;
  db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES ('cliToolPresets', 'apiKeys', ?)`, [
    stringifyJson(presets.next),
  ]);
  return presets.converted;
}

/**
 * Insert legacy snapshot keys as hashed rows: HMAC under the instance root,
 * Default-workspace ownership, legacy=1. Runs inside the caller's import
 * transaction; raw rows/presets are never written into the hashed instance.
 */
export function insertLegacyKeysHashedSync(db, payload, plan) {
  let inserted = 0;
  for (const key of payload.apiKeys || []) {
    insertHashedApiKeySync(db, {
      id: key.id,
      workspaceId: plan.defaultWorkspaceId,
      userId: null,
      createdByUserId: null,
      keyHash: hashApiKey(key.key, plan.hashKey),
      hashKid: plan.kid,
      prefix: apiKeyPrefix(key.key),
      name: key.name ?? null,
      machineId: key.machineId ?? null,
      legacy: 1,
      isActive: key.isActive === false ? 0 : 1,
      createdAt: key.createdAt || new Date().toISOString(),
    });
    inserted++;
  }
  applyLegacyPresetConversion(db, plan.presets);
  return inserted;
}

/**
 * Apply a format v2 hashed snapshot inside the caller's transaction. Full
 * destructive instance restore: users/identities/workspaces/memberships and
 * hashed keys replace the live rows; the durable marker is kept (root
 * equality was proven in preflight). Throws on any FK violation so the whole
 * transaction rolls back.
 */
export function applyGatewayKeySnapshot(db, payload, plan) {
  // Host-local MITM verifier: read the live settings row BEFORE the
  // destructive replace below so a running child's verifier survives and an
  // imported one can never take its place.
  const restoredSettings = preserveLocalVerifierSettings(
    db,
    payload.settings ? { ...payload.settings } : undefined,
  );
  // Preserve the existing importDb usage exclusion policy: telemetry is not
  // in config snapshots and is never wiped/restored. Historical ID-only
  // usage retains attribution (including unknown/deleted-key pseudonyms).
  // Reuse activation repo SQL, never invent a parallel schema. DDL and row
  // replacement share this transaction, so an apply error rolls both back.
  // gatewayVideoJobs come from the preflight plan (validated refs; retained
  // live rows for older-v2 snapshots), never an unchecked payload reread.
  db.exec(GATEWAY_VIDEO_JOBS_TABLE_SQL);
  db.run("DELETE FROM gatewayVideoJobs");
  db.run(`DELETE FROM settings`);
  db.run(`DELETE FROM apiKeys`);
  db.run(`DELETE FROM memberships`);
  db.run(`DELETE FROM identities`);
  db.run(`DELETE FROM providerConnections`);
  db.run(`DELETE FROM providerNodes`);
  db.run(`DELETE FROM proxyPools`);
  db.run(`DELETE FROM combos`);
  db.run(`DELETE FROM kv WHERE scope IN (${KV_SCOPES.map((s) => `'${s}'`).join(", ")})`);
  db.run(`DELETE FROM workspaces`);
  db.run(`DELETE FROM users`);

  if (restoredSettings !== undefined) {
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(restoredSettings)],
    );
  }
  for (const user of payload.users || []) {
    db.run(
      `INSERT INTO users(id, email, username, displayName, instanceRole, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt, lastLoginAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user.id,
        user.email ?? null,
        user.username ?? null,
        user.displayName ?? null,
        user.instanceRole,
        user.status ?? "active",
        user.passwordHash ?? null,
        // Legacy snapshots lack the flag: only a null-hash owner (recovery
        // fallback) is forced to rotate; custom hashes stay usable.
        user.mustChangePassword ??
          (user.instanceRole === "owner" && user.passwordHash == null ? 1 : 0),
        Number.isInteger(user.sessionVersion) ? user.sessionVersion : 1,
        user.createdAt,
        user.updatedAt,
        user.lastLoginAt ?? null,
      ],
    );
  }
  for (const identity of payload.identities || []) {
    db.run(
      `INSERT INTO identities(id, userId, provider, issuer, subject, emailAtLink, createdAt, lastLoginAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        identity.id,
        identity.userId,
        identity.provider,
        identity.issuer ?? "",
        identity.subject,
        identity.emailAtLink ?? null,
        identity.createdAt ?? new Date().toISOString(),
        identity.lastLoginAt ?? null,
      ],
    );
  }
  for (const ws of payload.workspaces || []) {
    db.run(
      `INSERT INTO workspaces(id, name, kind, createdBy, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
      [ws.id, ws.name, ws.kind, ws.createdBy ?? null, ws.createdAt, ws.updatedAt],
    );
  }
  for (const membership of payload.memberships || []) {
    db.run(
      `INSERT INTO memberships(workspaceId, userId, role, source, createdAt) VALUES(?, ?, ?, ?, ?)`,
      [
        membership.workspaceId,
        membership.userId,
        membership.role,
        membership.source ?? "manual",
        membership.createdAt ?? new Date().toISOString(),
      ],
    );
  }
  const defaultWorkspaceId = payload.tenancy?.defaultWorkspaceId;
  if (defaultWorkspaceId) setMetaSync(db, "defaultWorkspaceId", defaultWorkspaceId);

  for (const c of payload.providerConnections || []) {
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
    db.run(
      `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, workspaceId, createdByUserId)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        provider,
        authType || "oauth",
        name || null,
        email || null,
        priority || null,
        isActive === false ? 0 : 1,
        stringifyJson(rest),
        createdAt || new Date().toISOString(),
        updatedAt || new Date().toISOString(),
        workspaceId ?? null,
        createdByUserId ?? null,
      ],
    );
  }
  for (const n of payload.providerNodes || []) {
    const { id, type, name, createdAt, updatedAt, workspaceId, createdByUserId, ...rest } = n;
    db.run(
      `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt, workspaceId, createdByUserId)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        type || null,
        name || null,
        stringifyJson(rest),
        createdAt || new Date().toISOString(),
        updatedAt || new Date().toISOString(),
        workspaceId ?? null,
        createdByUserId ?? null,
      ],
    );
  }
  for (const p of payload.proxyPools || []) {
    const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
    db.run(
      `INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
      [
        id,
        isActive === false ? 0 : 1,
        testStatus || "unknown",
        stringifyJson(rest),
        createdAt || new Date().toISOString(),
        updatedAt || new Date().toISOString(),
      ],
    );
  }
  for (const c of payload.combos || []) {
    db.run(
      `INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
      [
        c.id,
        c.name,
        c.kind || null,
        stringifyJson(c.models || []),
        c.createdAt || new Date().toISOString(),
        c.updatedAt || new Date().toISOString(),
      ],
    );
  }
  for (const [a, m] of Object.entries(payload.modelAliases || {})) {
    db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [
      a,
      stringifyJson(m),
    ]);
  }
  for (const m of payload.customModels || []) {
    const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
    db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [
      k,
      stringifyJson(m),
    ]);
  }
  for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) {
    db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [
      tool,
      stringifyJson(mappings || {}),
    ]);
  }
  for (const [tool, settings] of Object.entries(payload.cliToolSettings || {})) {
    if (!isPlainObject(settings)) continue;
    db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('cliToolSettings', ?, ?)`, [
      tool,
      stringifyJson(settings),
    ]);
  }
  for (const [kind, items] of Object.entries(payload.cliToolPresets || {})) {
    if (!["endpoints", "apiKeys"].includes(kind) || !Array.isArray(items)) continue;
    db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('cliToolPresets', ?, ?)`, [
      kind,
      stringifyJson(items),
    ]);
  }
  for (const [provider, models] of Object.entries(payload.pricing || {})) {
    db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [
      provider,
      stringifyJson(models || {}),
    ]);
  }
  for (const row of payload.apiKeys || []) {
    insertHashedApiKeySync(db, {
      ...row,
      legacy: row.legacy ?? 0,
      isActive: row.isActive ?? 1,
      allowedModels: row.allowedModels ?? [],
      allowedCombos: row.allowedCombos ?? [],
    });
  }
  for (const job of plan.videoJobs ?? []) {
    db.run(
      `INSERT INTO gatewayVideoJobs(workspaceId, jobId, provider, connectionId, modelId, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [job.workspaceId, job.jobId, job.provider, job.connectionId, job.modelId, job.createdAt],
    );
  }
  if (db.all(`PRAGMA foreign_key_check`).length) {
    fail("TRANSFER_APPLY_INVALID", "Foreign key violations after snapshot apply");
  }
}
