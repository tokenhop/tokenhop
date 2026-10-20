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
import { deriveApiKeyHashKey, loadMasterKey, onMasterKeyChange } from "./masterKey.js";
import { buildHashKeyWrapAad, decryptBytes, isEnvelopeShape, zeroBuffer } from "./envelope.js";
import {
  invalidateMarkerCache,
  readApiKeyStorageState,
  readMetaValueCached,
} from "../db/apiKeyState.js";
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
  return readMetaValueCached(db, key);
}

// The credential state is a pure function of the five marker `_meta` values plus
// the workspaceKeys count. Both readers follow the adapter write generation
// (apiKeyState.js): a read repeats after any write made through THIS adapter.
// That is sound because processLock gives a DATA_DIR exactly one writer process
// and every marker writer goes through this adapter (enforced by
// marker-generation.test.js). A commit from another connection or an
// out-of-band edit of the live database file is NOT detected here: such edits
// require a restart, like any other offline change to a running instance.
function credentialState(db) {
  return { state: readCredentialEncryptionState(db), values: readCredentialMarkerValues(db) };
}

// YAN-1106 derived-key memo. The unwrapped hash key is a pure function of: the
// five credential markers (wrapped envelope + KEK kid), the frozen hash kid, the
// default workspace id (unwrap AAD) and the root that unwrapped it. The memo key
// is exactly that tuple, read through the write-generation readers, so ANY
// marker change (rotation, activation, import, restore) misses and re-runs the
// authenticated unwrap; it does not depend on how often unrelated rows write.
// Only a root loaded here by loadMasterKey is eligible (its kid is derived from
// its bytes). A caller-supplied `{kid, key}` is a proof input (rotation, import)
// and always runs the full authenticated unwrap. One entry, at most
// HASH_KEY_TTL_MS, zeroed by an unref'd timer, on any root change, and on
// clearApiKeyHashKeyStateCache. Callers always receive private copies.
const HASH_KEY_TTL_MS = 30_000;
// One process-wide slot (Symbol.for) so every bundled or reloaded copy of this
// module shares the entry, its timer and its zeroing.
const HASH_CACHE_KEY = Symbol.for("tokenhop.apiKeyHashKeyCache");
globalThis[HASH_CACHE_KEY] ??= { entry: null, timer: null };
const hashCache = globalThis[HASH_CACHE_KEY];

function dropHashKeyEntry() {
  if (hashCache.timer) clearTimeout(hashCache.timer);
  hashCache.timer = null;
  if (hashCache.entry) hashCache.entry.hashKey.fill(0);
  hashCache.entry = null;
}
onMasterKeyChange(dropHashKeyEntry, "apiKeyHashKey");

/** Drop memoized marker reads and the derived hash key (marker writes in-process). */
export function clearApiKeyHashKeyStateCache(db) {
  invalidateMarkerCache(db);
  dropHashKeyEntry();
}

function hashKeyFingerprint(db, cred, apiKey, values, root) {
  return JSON.stringify([
    cred.storage,
    values,
    apiKey.hashKid,
    root.kid,
    cred.storage === "encrypted" ? metaValue(db, "defaultWorkspaceId") : null,
  ]);
}

function cachedHashKey(db, fingerprint) {
  const entry = hashCache.entry;
  if (!entry) return null;
  if (entry.db !== db || entry.fingerprint !== fingerprint || Date.now() >= entry.expiresAt) {
    if (Date.now() >= entry.expiresAt) dropHashKeyEntry();
    return null;
  }
  return { hashKid: entry.hashKid, hashKey: Buffer.from(entry.hashKey) };
}

function rememberHashKey(db, fingerprint, out) {
  dropHashKeyEntry();
  hashCache.entry = {
    db,
    fingerprint,
    hashKid: out.hashKid,
    hashKey: Buffer.from(out.hashKey),
    expiresAt: Date.now() + HASH_KEY_TTL_MS,
  };
  hashCache.timer = setTimeout(dropHashKeyEntry, HASH_KEY_TTL_MS);
  hashCache.timer.unref?.();
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
  const loadedHere = root === undefined || root === null;
  if (loadedHere) {
    if (apiKey.storage !== "hashed") {
      fail("API_KEY_STATE_INVALID", "hashed API key storage required");
    }
    const expectedKid = cred.storage === "encrypted" ? cred.kekKid : apiKey.hashKid;
    const { kid, key } = await loadMasterKey({ expectedKid });
    root = { kid, key };
  }
  if (!loadedHere)
    return { out: resolve(db, root, cred, apiKey), root, state: cred, markers: values };
  // The root load yields. The fingerprint is built from reads taken BEFORE the
  // await, so re-read it now: if a rotation or marker write landed during the
  // load, bypass the memo completely (no lookup, no remember) and unwrap exactly
  // as before. The caller's own request-scope check then rejects the request.
  assertCredentialOperationAllowed(db);
  const fingerprint = hashKeyFingerprint(db, cred, apiKey, values, root);
  let stable = false;
  try {
    const now = credentialState(db);
    const apiNow = readApiKeyStorageState(db); // live: a caller-supplied state is the old read
    stable = hashKeyFingerprint(db, now.state, apiNow, now.values, root) === fingerprint;
  } catch {
    stable = false;
  }
  let out = stable ? cachedHashKey(db, fingerprint) : null;
  if (!out) {
    out = resolve(db, root, cred, apiKey);
    if (stable && apiKey.storage === "hashed") rememberHashKey(db, fingerprint, out);
  }
  return { out, root, state: cred, markers: values };
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
