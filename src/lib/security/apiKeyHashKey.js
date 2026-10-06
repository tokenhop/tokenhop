// YAN-365 (D6) the single API-key hash-key getter. The hash key identity
// (`_meta.apiKeysHashKid`, `apiKeys.hashKid`) is frozen at activation; the
// current KEK identity is `_meta.credentialsKekKid`. Before credential
// encryption the key is HKDF(master) exactly as before. After encryption the
// derived key is unwrapped from `_meta.apiKeyHashKeyWrapped` under the
// current KEK (kid check + authenticated unwrap) — NEVER rederived from the
// (possibly rotated) master.
//
// Imports: masterKey loader/HKDF, B1 codec/state and the maintenance
// admission. No driver/barrel/switch/session imports; callers that already
// hold a root pass `{ root: { kid, key } }` to avoid re-loading.
import { deriveApiKeyHashKey, loadMasterKey } from "./masterKey.js";
import { buildHashKeyWrapAad, decryptBytes, isEnvelopeShape } from "./envelope.js";
import { readApiKeyStorageState } from "../db/apiKeyState.js";
import { readCredentialEncryptionState } from "../db/credentialEncryptionState.js";
import { assertCredentialOperationAllowed } from "../db/credentialMaintenance.js";

function fail(code, message) {
  throw Object.assign(new Error(`[api-key-hash-key] ${message}`), { code });
}

function metaValue(db, key) {
  return db.get(`SELECT value FROM _meta WHERE key = ?`, [key])?.value ?? null;
}

// Marker-tuple memo per adapter: the credential state is a pure function of
// six `_meta` values plus the workspaceKeys count. The legacy verdict's
// envelope sniff is the expensive part; the tuple check is point selects, so
// hot per-request callers never rescan tables. A marker change flips the
// tuple and forces a fresh read. If rows mutate without a marker change
// (corruption mid-process), the next restart re-verifies from scratch.
const stateCache = new WeakMap(); // db -> { sig, state }

function credentialState(db) {
  const sig = [
    metaValue(db, "credentialsEncryptedVersion"),
    metaValue(db, "credentialsKekKid"),
    metaValue(db, "credentialsCleanupPending"),
    metaValue(db, "credentialsPendingRotation"),
    metaValue(db, "apiKeyHashKeyWrapped"),
    db.get(`SELECT COUNT(*) AS c FROM workspaceKeys`)?.c ?? 0,
  ].join("|");
  const hit = stateCache.get(db);
  if (hit && hit.sig === sig) return hit.state;
  const state = readCredentialEncryptionState(db);
  stateCache.set(db, { sig, state });
  return state;
}

/** Test/back-compat hook: drop the memoized state (marker writes in-process). */
export function clearApiKeyHashKeyStateCache(db) {
  stateCache.delete(db);
}

function requireRoot(root) {
  if (
    !root ||
    !Buffer.isBuffer(root.key) ||
    root.key.length !== 32 ||
    typeof root.kid !== "string"
  ) {
    fail("ROOT_INVALID", "root {kid,key} required");
  }
  return root;
}

// Encrypted path: prove the CURRENT KEK (root.kid === credentialsKekKid,
// envelope kid matches) and unwrap the frozen derived key with the frozen
// hash-kid AAD. Returns the frozen identity plus the original derived bytes.
function unwrapFrozenHashKey(db, root, cred, hashKid) {
  if (root.kid !== cred.kekKid) {
    fail("KEY_MISMATCH", "root does not match the current credential KEK kid");
  }
  const defaultWorkspaceId = metaValue(db, "defaultWorkspaceId");
  if (typeof defaultWorkspaceId !== "string" || defaultWorkspaceId.length === 0) {
    fail("CREDENTIAL_STATE_INVALID", "defaultWorkspaceId required in encrypted state");
  }
  let envelope;
  try {
    envelope = JSON.parse(metaValue(db, "apiKeyHashKeyWrapped") ?? "");
  } catch {
    envelope = null;
  }
  if (!isEnvelopeShape(envelope)) {
    fail("CREDENTIAL_STATE_INVALID", "wrapped API-key hash key is not an envelope");
  }
  if (envelope.kid !== cred.kekKid) {
    fail("KEY_MISMATCH", "wrapped hash key belongs to a different KEK");
  }
  let hashKey;
  try {
    hashKey = decryptBytes(root.key, envelope, buildHashKeyWrapAad(defaultWorkspaceId, hashKid));
  } catch (e) {
    fail(e?.code ?? "KEY_MISMATCH", "wrapped API-key hash key authentication failed");
  }
  if (hashKey.length !== 32) fail("KEY_MISMATCH", "wrapped hash key must be 32 bytes");
  return { hashKid, hashKey };
}

function resolve(db, root, cred) {
  const apiKey = readApiKeyStorageState(db);
  if (apiKey.storage !== "hashed") {
    fail("API_KEY_STATE_INVALID", "hashed API key storage required");
  }
  if (cred.storage === "legacy") {
    requireRoot(root);
    // Pre-encryption behaviour preserved byte-for-byte: HKDF of the master
    // whose kid IS the frozen hash kid.
    if (root.kid !== apiKey.hashKid) {
      fail("API_KEY_STATE_INVALID", "root does not match the frozen hash kid");
    }
    return { hashKid: apiKey.hashKid, hashKey: deriveApiKeyHashKey(root.key) };
  }
  return unwrapFrozenHashKey(db, requireRoot(root), cred, apiKey.hashKid);
}

/**
 * Async facade. `root` may be omitted; the root is then loaded with the kid
 * the current state demands (frozen hash kid pre-encryption, current KEK kid
 * after) — a rotated KEK never satisfies the legacy expectation and vice versa.
 * @param {object} [opts] `{ root?: {kid:string,key:Buffer} }`
 * @returns {Promise<{hashKid:string,hashKey:Buffer}>}
 */
export async function getApiKeyHashKey(db, opts = {}) {
  assertCredentialOperationAllowed(db);
  const cred = credentialState(db);
  if (opts.root !== undefined && opts.root !== null) return resolve(db, opts.root, cred);
  const apiKey = readApiKeyStorageState(db);
  if (apiKey.storage !== "hashed") {
    fail("API_KEY_STATE_INVALID", "hashed API key storage required");
  }
  const expectedKid = cred.storage === "encrypted" ? cred.kekKid : apiKey.hashKid;
  const { kid, key } = await loadMasterKey({ expectedKid });
  return resolve(db, { kid, key }, cred);
}

/**
 * Sync proof for transactions and startup: root must already be loaded
 * (async file/env loading belongs to the caller).
 * @returns {{hashKid:string,hashKey:Buffer}}
 */
export function resolveApiKeyHashKeySync(db, root) {
  assertCredentialOperationAllowed(db);
  return resolve(db, root, credentialState(db));
}
