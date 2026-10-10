// YAN-365 sync credential row codec + DEK wrap/cache. Adapter-passed and
// non-yielding (no await anywhere) so it is safe inside db.transaction
// callbacks. Imports only the pure codec, the state reader and json helpers:
// never the driver, barrel, feature switch, session, owner bootstrap or
// readiness. Callers resolve the root asynchronously first
// (prepareCredentialContext) and pass the context in.
//
// Modes:
//  - runtime:   decrypt covered leaves; plaintext/caller envelopes on encode rejected
//  - metadata:  never decrypts; covered leaves are replaced by presence-only
//               sentinels so one corrupt envelope never breaks a list
//  - migration: TRUSTED INTERNAL ONLY (activation/rotation). Requires the
//               unforgeable internal context minted by createMigrationContext.
import { readCredentialEncryptionState } from "../credentialEncryptionState.js";
import {
  CREDENTIAL_FIELD_ALLOWLIST,
  buildAad,
  buildDekWrapAad,
  decryptBytes,
  encryptBytes,
  isEnvelopeShape,
  randomDekKid,
  randomKey,
  zeroBuffer,
} from "../../security/envelope.js";

export const DEK_CACHE_MAX = 128;
export const DEK_CACHE_TTL_MS = 5 * 60 * 1000;
const PSD_PREFIX = "providerSpecificData.";
const ENVELOPE_KEYS = ["ct", "iv", "kid", "tag", "v"];
const TRUSTED = new WeakSet();
// Runtime contexts minted by prepareCredentialContext (YAN-701): the move-only
// DEK provisioner admits exactly these, never a caller-forged object.
const RUNTIME_CTX = new WeakSet();

function fail(code, message) {
  throw Object.assign(new Error(`[credential-storage] ${message}`), { code });
}

function integrity(code = "DECRYPT_FAILED") {
  return Object.assign(new Error("[credential-storage] credential could not be decrypted"), {
    code,
  });
}

// ─── context ─────────────────────────────────────────────────────────────

/**
 * Memory-only context. `root` is `{kid,key}` from loadMasterKey (or null when
 * never encrypted / metadata-only). Validates the root against the marker kid.
 */
export function prepareCredentialContext(db, root = null) {
  const state = readCredentialEncryptionState(db);
  if (state.storage === "encrypted" && root) {
    if (!root.key || root.kid !== state.kekKid) {
      fail("KEY_MISMATCH", "root key does not match the stored key id");
    }
  }
  const ctx = {
    state,
    kek: root?.key ?? null,
    kekKid: root?.kid ?? null,
    encrypted: state.storage === "encrypted",
    allowCreate: false,
  };
  RUNTIME_CTX.add(ctx);
  return ctx;
}

/** Trusted-internal context for activation/rotation (mode:'migration'). Not exported on any barrel. */
export function createMigrationContext(db, root) {
  if (!root?.key || typeof root.kid !== "string") fail("KEY_MISSING", "root key required");
  const ctx = {
    state: readCredentialEncryptionState(db),
    kek: root.key,
    kekKid: root.kid,
    encrypted: true,
    allowCreate: true,
  };
  TRUSTED.add(ctx);
  return ctx;
}

// ─── DEK cache (DEKs only; every hit verifies the live wrapped row) ──────

const caches = new WeakMap(); // adapter -> Map(workspaceId -> entry)

function cacheOf(db) {
  let c = caches.get(db);
  if (!c) {
    c = new Map();
    caches.set(db, c);
  }
  return c;
}

function evict(map, workspaceId) {
  const hit = map.get(workspaceId);
  if (hit) zeroBuffer(hit.dek);
  map.delete(workspaceId);
}

/** Drop cached DEKs for one workspace or the whole adapter (post-commit purge). */
export function clearCredentialCache(db, workspaceId = undefined) {
  const map = caches.get(db);
  if (!map) return;
  if (workspaceId === undefined) {
    for (const id of [...map.keys()]) evict(map, id);
  } else {
    evict(map, workspaceId);
  }
}

function readKeyRow(db, workspaceId) {
  return db.get(`SELECT kid, wrappedDek FROM workspaceKeys WHERE workspaceId = ?`, [workspaceId]);
}

function parseWrapped(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw integrity();
  }
  if (!isEnvelopeShape(parsed)) throw integrity("ENVELOPE_INVALID");
  return parsed;
}

function unwrapDek(row, workspaceId, ctx) {
  const env = parseWrapped(row.wrappedDek);
  const dek = decryptBytes(ctx.kek, env, buildDekWrapAad(workspaceId, row.kid));
  if (dek.length !== 32) throw integrity();
  return dek;
}

/**
 * Wrapped-generation keyed cache hit: the live row's `kid + wrappedDek` must
 * equal what the entry was built from, otherwise it is a stale/rotated/
 * deleted/imported row and the entry is dropped (no resurrection).
 */
function liveDek(db, workspaceId, ctx) {
  const row = readKeyRow(db, workspaceId);
  const map = cacheOf(db);
  if (!row) {
    evict(map, workspaceId);
    return null;
  }
  const generation = `${ctx.kekKid}|${row.kid}|${row.wrappedDek}`;
  const hit = map.get(workspaceId);
  if (hit && hit.generation === generation && Date.now() - hit.at < DEK_CACHE_TTL_MS) {
    map.delete(workspaceId); // refresh LRU position
    map.set(workspaceId, hit);
    return { kid: row.kid, dek: hit.dek };
  }
  if (hit) evict(map, workspaceId);
  const dek = unwrapDek(row, workspaceId, ctx);
  while (map.size >= DEK_CACHE_MAX) evict(map, map.keys().next().value);
  map.set(workspaceId, { generation, at: Date.now(), dek });
  return { kid: row.kid, dek };
}

/**
 * Existing DEK for `workspaceId`, or (migration contexts only) a new one
 * wrapped under the KEK. Runtime contexts never create keys: a missing row
 * on an encrypted workspace is a typed KEY_MISSING.
 * @returns {{kid:string,dek:Buffer}}
 */
export function ensureWorkspaceDekSync(db, workspaceId, ctx) {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    fail("KEY_MISSING", "workspace id required");
  }
  if (!ctx?.kek) fail("KEY_MISSING", "root key not available");
  const existing = liveDek(db, workspaceId, ctx);
  if (existing) return existing;
  if (!ctx.allowCreate || !TRUSTED.has(ctx)) fail("KEY_MISSING", "workspace key not found");
  insertWrappedDek(db, workspaceId, ctx);
  // Next read goes through liveDek so the cache is keyed to the persisted row.
  return liveDek(db, workspaceId, ctx);
}

/** Fresh random DEK wrapped under the KEK and persisted; the plaintext bytes are always zeroed. */
function insertWrappedDek(db, workspaceId, ctx) {
  const dek = randomKey();
  try {
    const kid = randomDekKid();
    const env = encryptBytes(ctx.kek, ctx.kekKid, dek, buildDekWrapAad(workspaceId, kid));
    db.run(
      `INSERT INTO workspaceKeys(workspaceId, kid, wrappedDek, createdAt) VALUES(?, ?, ?, ?)`,
      [workspaceId, kid, JSON.stringify(env), new Date().toISOString()],
    );
  } finally {
    // Always zero the fresh key bytes, including when encrypt/INSERT throws.
    zeroBuffer(dek);
  }
}

/**
 * YAN-701 MOVE-ONLY target DEK provisioner (deliberately NOT a general runtime
 * create path; runtime ensureWorkspaceDekSync stays fail-closed). Admits only a
 * genuine runtime context from prepareCredentialContext holding a root for an
 * encrypted instance; rereads the live marker (kid must still match) and the
 * workspace row inside the caller's transaction. An existing DEK is validated
 * through liveDek (unwrap + generation check); a missing one gets a FRESH
 * random DEK — a source DEK is never copied. Not re-exported from any barrel.
 * @returns {{kid:string,dek:Buffer}}
 */
export function provisionMoveTargetDekSync(db, workspaceId, ctx) {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    fail("KEY_MISSING", "workspace id required");
  }
  if (!ctx || !RUNTIME_CTX.has(ctx) || ctx.allowCreate || TRUSTED.has(ctx)) {
    fail("KEY_MISSING", "not a runtime credential context");
  }
  if (!ctx.encrypted || !ctx.kek || !ctx.kekKid) fail("KEY_MISSING", "root key not available");
  const live = readCredentialEncryptionState(db);
  if (live.storage !== "encrypted" || live.kekKid !== ctx.kekKid) {
    fail("KEY_MISMATCH", "credential encryption state changed during the operation");
  }
  if (!db.get(`SELECT 1 AS x FROM workspaces WHERE id = ?`, [workspaceId])) {
    fail("KEY_MISSING", "workspace not found");
  }
  const existing = liveDek(db, workspaceId, ctx);
  if (existing) return existing;
  insertWrappedDek(db, workspaceId, ctx);
  return liveDek(db, workspaceId, ctx);
}

// ─── strict credential blob parse ────────────────────────────────────────

/** Strict JSON object parse for credential blobs. Never forgiving (not jsonCol.parseJson). */
export function parseCredentialBlob(raw) {
  if (typeof raw !== "string") fail("DATA_CORRUPT", "credential data must be a JSON string");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("DATA_CORRUPT", "credential data is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("DATA_CORRUPT", "credential data must be a JSON object");
  }
  return parsed;
}

// ─── leaf accessors over the D10 allow-list ──────────────────────────────

function getLeaf(obj, field) {
  if (field.startsWith(PSD_PREFIX)) {
    const psd = obj.providerSpecificData;
    if (!psd || typeof psd !== "object" || Array.isArray(psd)) return undefined;
    return psd[field.slice(PSD_PREFIX.length)];
  }
  return obj[field];
}

function setLeaf(obj, field, value) {
  if (field.startsWith(PSD_PREFIX)) {
    obj.providerSpecificData = { ...(obj.providerSpecificData || {}) };
    obj.providerSpecificData[field.slice(PSD_PREFIX.length)] = value;
  } else {
    obj[field] = value;
  }
}

function deleteLeaf(obj, field) {
  if (field.startsWith(PSD_PREFIX)) {
    if (obj.providerSpecificData) delete obj.providerSpecificData[field.slice(PSD_PREFIX.length)];
  } else {
    delete obj[field];
  }
}

function isLookalike(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === ENVELOPE_KEYS.length && keys.every((k, i) => k === ENVELOPE_KEYS[i]);
}

// Empty/null/absent secret semantics are preserved: only non-empty strings encrypt.
function isSecretString(value) {
  return typeof value === "string" && value.length > 0;
}

// ─── row codec ───────────────────────────────────────────────────────────

function checkTable(table) {
  if (!Object.hasOwn(CREDENTIAL_FIELD_ALLOWLIST, table))
    fail("TABLE_INVALID", "not a credential table");
}

function rowCoordinates(table, row) {
  if (table === "settings") return { rowId: String(row.id ?? "1") };
  if (typeof row?.id !== "string" || row.id.length === 0) fail("DATA_CORRUPT", "row id missing");
  return { rowId: row.id };
}

/**
 * Metadata mode never decrypts: covered leaves are removed and replaced by a
 * `configured` name list (redaction shares the encryption allow-list) so
 * callers show presence without exposing or parsing any envelope.
 */
function redactForMetadata(obj, fields) {
  const configured = [];
  for (const field of fields) {
    const leaf = getLeaf(obj, field);
    if (leaf === undefined || leaf === null || leaf === "") continue;
    configured.push(field);
    deleteLeaf(obj, field);
  }
  return { data: obj, configured };
}

/**
 * Decode a stored `{data, id, workspaceId, ...}` row into its parsed data
 * object with covered leaves resolved per mode. SQL row coordinates (never
 * envelope contents) feed the AAD.
 * @param {{mode?:'runtime'|'metadata'|'migration', table:'providerConnections'|'providerNodes'|'settings', workspaceId?:string}} opts
 * @returns {object|{data:object,configured:string[]}} runtime/migration: the plain
 *   blob with covered leaves decrypted. metadata: `{data, configured}` where `data`
 *   is the blob with covered leaves removed (never decrypted) and `configured` is the
 *   array of dotted allow-list paths (e.g. `providerSpecificData.clientSecret`) that
 *   were present.
 */
export function decodeCredentialRowSync(
  db,
  row,
  ctx,
  { mode = "runtime", table, workspaceId } = {},
) {
  checkTable(table);
  if (!["runtime", "metadata", "migration"].includes(mode)) fail("MODE_INVALID", "unknown mode");
  if (mode === "migration" && !TRUSTED.has(ctx)) fail("MODE_INVALID", "migration mode is internal");
  const blob = parseCredentialBlob(row?.data);
  const fields = CREDENTIAL_FIELD_ALLOWLIST[table];
  if (mode === "metadata") return redactForMetadata(blob, fields);

  const ws = workspaceId ?? row.workspaceId ?? null;
  const { rowId } = rowCoordinates(table, row);
  let dek = null;
  for (const field of fields) {
    const leaf = getLeaf(blob, field);
    if (leaf === undefined || leaf === null) continue;
    if (isEnvelopeShape(leaf)) {
      // An envelope without an established marker/root is never legacy plaintext.
      if (!ctx?.kek) fail("KEY_MISSING", "root key not available");
      if (ws === null) fail("DATA_CORRUPT", "encrypted row has no workspace");
      dek ??= ensureWorkspaceDekSync(db, ws, ctx);
      const plain = decryptBytes(dek.dek, leaf, buildAad({ table, rowId, workspaceId: ws, field }));
      setLeaf(blob, field, plain.toString("utf8"));
      zeroBuffer(plain);
    } else if (isLookalike(leaf)) {
      throw integrity("ENVELOPE_INVALID");
    } else if (ctx?.encrypted && isSecretString(leaf) && mode === "runtime") {
      // Established encryption: a plaintext covered secret is never trusted.
      fail("PLAINTEXT_REJECTED", "plaintext credential in encrypted storage");
    }
  }
  return blob;
}

/**
 * Encode a plaintext `data` object for storage. In runtime mode caller
 * envelope objects and envelope-lookalikes are rejected; covered secrets are
 * encrypted under the row's workspace DEK when encryption is established.
 * Returns the JSON string to write to `data`.
 */
export function encodeCredentialRowSync(
  db,
  row,
  ctx,
  { table, workspaceId, mode = "runtime" } = {},
) {
  checkTable(table);
  if (mode === "migration" && !TRUSTED.has(ctx)) fail("MODE_INVALID", "migration mode is internal");
  if (mode !== "runtime" && mode !== "migration") fail("MODE_INVALID", "unknown mode");
  const data = structuredClone(row.data);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    fail("DATA_CORRUPT", "credential data must be an object");
  }
  const fields = CREDENTIAL_FIELD_ALLOWLIST[table];
  const ws = workspaceId ?? row.workspaceId ?? null;
  const { rowId } = rowCoordinates(table, row);
  let dek = null;
  for (const field of fields) {
    const leaf = getLeaf(data, field);
    if (leaf === undefined || leaf === null) continue;
    if (mode === "runtime" && (isEnvelopeShape(leaf) || isLookalike(leaf))) {
      fail("ENVELOPE_REJECTED", "caller-supplied envelope rejected");
    }
    if (!ctx?.encrypted) continue; // never-enabled install: bytes unchanged
    if (!isSecretString(leaf)) continue;
    if (ws === null) fail("DATA_CORRUPT", "cannot encrypt a row without a workspace");
    dek ??= ensureWorkspaceDekSync(db, ws, ctx);
    const env = encryptBytes(
      dek.dek,
      dek.kid,
      Buffer.from(leaf, "utf8"),
      buildAad({ table, rowId, workspaceId: ws, field }),
    );
    setLeaf(data, field, env);
  }
  return JSON.stringify(data);
}

/** Re-exports so B2 callers read one module for the shared allow-list. */
export { CREDENTIAL_FIELD_ALLOWLIST };
