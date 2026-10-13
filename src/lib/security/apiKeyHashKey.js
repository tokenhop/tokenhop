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
import { buildHashKeyWrapAad, decryptBytes, isEnvelopeShape, zeroBuffer } from "./envelope.js";
import { readApiKeyStorageState } from "../db/apiKeyState.js";
import {
  readCredentialEncryptionState,
  readCredentialMarkerValues,
} from "../db/credentialEncryptionState.js";
import { assertCredentialOperationAllowed } from "../db/credentialMaintenance.js";
import { mintGatewayPrincipal } from "./requestCredentialScope.js";
import { DEK_CACHE_TTL_MS } from "../db/helpers/credentialStorage.js";

function fail(code, message) {
  throw Object.assign(new Error(`[api-key-hash-key] ${message}`), { code });
}

function metaValue(db, key) {
  return db.get(`SELECT value FROM _meta WHERE key = ?`, [key])?.value ?? null;
}

// Marker-tuple memo per adapter: the credential state is a pure function of
// five `_meta` values plus the workspaceKeys count. The legacy verdict's
// envelope sniff is the expensive part; the tuple check is one batch select, so
// hot per-request callers never rescan tables. A marker change flips the
// tuple and forces a fresh read. If rows mutate without a marker change
// (corruption mid-process), the next restart re-verifies from scratch.
const stateCache = new WeakMap(); // db -> { sig, state }

function credentialState(db) {
  const values = readCredentialMarkerValues(db);
  const sig = [
    values.credentialsEncryptedVersion,
    values.credentialsKekKid,
    values.credentialsCleanupPending,
    values.credentialsPendingRotation,
    values.apiKeyHashKeyWrapped,
    db.get(`SELECT COUNT(*) AS c FROM workspaceKeys`)?.c ?? 0,
  ].join("|");
  const hit = stateCache.get(db);
  if (hit && hit.sig === sig) return { state: hit.state, values };
  const state = readCredentialEncryptionState(db);
  stateCache.set(db, { sig, state });
  return { state, values };
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

function resolve(db, root, cred, apiKeyState) {
  const apiKey = apiKeyState ?? readApiKeyStorageState(db);
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
 * `apiKeyState` is an already-read storage state (skips the re-reads).
 * @param {object} [opts] `{ root?, apiKeyState? }`
 * @returns {Promise<{hashKid:string,hashKey:Buffer}>}
 */
export async function getApiKeyHashKey(db, opts = {}) {
  return (await hashKeyAndRoot(db, opts)).out;
}

/**
 * Gateway auth: hash key plus a ONE-SHOT `mint(fields)` that creates the single
 * seeded principal for this authentication. The seed (root copy) is released on
 * first use; a second call, or a call after `release()`, throws. The root never
 * leaves this closure.
 * @returns {Promise<{hashKid:string,hashKey:Buffer,mint:(fields:object)=>object,release:()=>void}>}
 */
export async function resolveApiKeyHashKeyForAuth(db, { apiKeyState } = {}) {
  const { out, root, state, markers } = await hashKeyAndRoot(db, { apiKeyState });
  const at = Date.now();
  let seed = {
    root: state.storage === "encrypted" ? { kid: root.kid, key: Buffer.from(root.key) } : null,
    state,
    markers,
  };
  const release = () => {
    if (seed?.root) zeroBuffer(seed.root.key);
    seed = null;
  };
  const mint = (fields) => {
    if (!seed) throw new Error("Request credential seed already released");
    try {
      if (Date.now() - at >= DEK_CACHE_TTL_MS) throw new Error("Request credential seed expired");
      return mintGatewayPrincipal(fields, db, seed);
    } finally {
      release();
    }
  };
  return { ...out, mint, release };
}

async function hashKeyAndRoot(db, opts) {
  assertCredentialOperationAllowed(db);
  const { state: cred, values } = credentialState(db);
  const apiKey = opts.apiKeyState ?? readApiKeyStorageState(db);
  let root = opts.root;
  if (root === undefined || root === null) {
    if (apiKey.storage !== "hashed") {
      fail("API_KEY_STATE_INVALID", "hashed API key storage required");
    }
    const expectedKid = cred.storage === "encrypted" ? cred.kekKid : apiKey.hashKid;
    const { kid, key } = await loadMasterKey({ expectedKid });
    root = { kid, key };
  }
  return { out: resolve(db, root, cred, apiKey), root, state: cred, markers: values };
}

/**
 * Sync proof for transactions and startup: root must already be loaded
 * (async file/env loading belongs to the caller).
 * @returns {{hashKid:string,hashKey:Buffer}}
 */
export function resolveApiKeyHashKeySync(db, root) {
  assertCredentialOperationAllowed(db);
  return resolve(db, root, credentialState(db).state);
}
