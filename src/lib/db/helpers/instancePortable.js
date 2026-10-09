// YAN-375 instance-level passphrase portability over a format-v3 encrypted
// snapshot. Pure module: the shared envelope codec, passphraseWrap and
// masterKeyId only — no DB/driver/barrel/switch imports, so routes and the
// transfer preflight can share it cycle-free.
//
// make: unwrap every workspaceKeys.wrappedDek and the wrapped API-key hash
// key under the SOURCE master key (authenticated AAD at the exact row
// coordinates), seal the whole DEK graph under ONE scrypt(passphrase) wrap
// (passphraseWrap.js) and mark credentialEncryption.portable. The returned
// snapshot is a fresh clone; no master or raw key material is ever embedded.
// unlock: unseal that bundle, rewrap every DEK and the hash key under the
// DESTINATION master key (same dekKid/hashKid, credential leaf envelopes stay
// byte-exact), set credentialEncryption.kekKid to the destination kid and
// drop the portable marker. Every failure — bad shape, wrong root, wrong
// passphrase, tamper — is the one generic INSTANCE_PORTABLE_INVALID; all key
// buffers are zeroed in finally.
import {
  buildDekWrapAad,
  buildHashKeyWrapAad,
  decryptBytes,
  encryptBytes,
  isEnvelopeShape,
  zeroBuffer,
} from "../../security/envelope.js";
import {
  isPassphraseWrapShape,
  unwrapPortableKeys,
  wrapPortableKeys,
} from "../../security/passphraseWrap.js";
import { masterKeyId } from "../../security/masterKey.js";

const KID_RE = /^[0-9a-f]{16}$/;
const DEK_KID_RE = /^dk_[0-9a-f]{16}$/;

function fail() {
  throw Object.assign(
    new Error("[instance-portable] snapshot is not a convertible encrypted snapshot"),
    { code: "INSTANCE_PORTABLE_INVALID" },
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireMaster(masterKey) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) fail();
  return masterKey;
}

function parseEnvelopeString(raw) {
  let env;
  try {
    env = JSON.parse(raw);
  } catch {
    fail();
  }
  if (!isEnvelopeShape(env)) fail();
  return env;
}

/**
 * Shared shape check of a format-v3 encrypted snapshot (own fields only, no
 * root work): credentialEncryption (version/kekKid/apiKeyHashKeyWrapped),
 * frozen apiKeyStorage.hashKid, tenancy.defaultWorkspaceId and the exact
 * workspaceKeys row set. Returns the live pieces both directions need.
 */
function graph(snapshot) {
  if (!isPlainObject(snapshot)) fail();
  const cred = snapshot.credentialEncryption;
  if (!isPlainObject(cred) || cred.version !== 1) fail();
  if (typeof cred.kekKid !== "string" || !KID_RE.test(cred.kekKid)) fail();
  if (typeof cred.apiKeyHashKeyWrapped !== "string" || !cred.apiKeyHashKeyWrapped) fail();
  const storage = snapshot.apiKeyStorage;
  if (
    !isPlainObject(storage) ||
    typeof storage.hashKid !== "string" ||
    !KID_RE.test(storage.hashKid)
  ) {
    fail();
  }
  const defaultWs = snapshot.tenancy?.defaultWorkspaceId;
  if (typeof defaultWs !== "string" || !defaultWs) fail();
  if (!Array.isArray(snapshot.workspaceKeys)) fail();
  const seenWs = new Set();
  const seenKid = new Set();
  for (const row of snapshot.workspaceKeys) {
    if (!isPlainObject(row)) fail();
    if (typeof row.workspaceId !== "string" || !row.workspaceId) fail();
    if (typeof row.kid !== "string" || !DEK_KID_RE.test(row.kid)) fail();
    if (seenWs.has(row.workspaceId) || seenKid.has(row.kid)) fail();
    seenWs.add(row.workspaceId);
    seenKid.add(row.kid);
  }
  return { cred, hashKid: storage.hashKid, defaultWs, rows: snapshot.workspaceKeys };
}

/**
 * Convert an encrypted (format-v3) snapshot into a passphrase-locked portable
 * snapshot: decrypt the current wrap graph under the SOURCE master key and
 * reseal every DEK plus the derived API-key hash key under one
 * scrypt(passphrase) bundle stored as `credentialEncryption.portable`.
 * Source row ciphertext is left in place (dead under a foreign root); the
 * returned snapshot is a NEW object and carries no master/raw key.
 * @param {object} snapshot format-v3 encrypted snapshot.
 * @param {{passphrase:string, masterKey:Buffer}} opts source root + passphrase.
 * @returns {Promise<object>} cloned portable snapshot (portable marker set).
 */
export async function makeInstancePortable(snapshot, { passphrase, masterKey } = {}) {
  const src = graph(snapshot);
  requireMaster(masterKey);
  if (typeof passphrase !== "string" || passphrase.length === 0) fail();
  if (src.cred.portable !== undefined) fail(); // already portable
  const deks = new Map();
  let hashKey = null;
  try {
    for (const row of src.rows) {
      if (typeof row.wrappedDek !== "string" || !row.wrappedDek) fail();
      const env = parseEnvelopeString(row.wrappedDek);
      if (env.kid !== src.cred.kekKid) fail();
      let dek;
      try {
        dek = decryptBytes(masterKey, env, buildDekWrapAad(row.workspaceId, row.kid));
      } catch {
        fail();
      }
      if (dek.length !== 32) {
        zeroBuffer(dek);
        fail();
      }
      deks.set(row.workspaceId, dek);
    }
    const wrappedHash = parseEnvelopeString(src.cred.apiKeyHashKeyWrapped);
    if (wrappedHash.kid !== src.cred.kekKid) fail();
    try {
      hashKey = decryptBytes(
        masterKey,
        wrappedHash,
        buildHashKeyWrapAad(src.defaultWs, src.hashKid),
      );
    } catch {
      fail();
    }
    if (hashKey.length !== 32) fail();
    let bundle;
    try {
      bundle = await wrapPortableKeys({
        passphrase,
        hashKey,
        deks: Object.fromEntries(deks),
      });
    } catch {
      fail();
    }
    const out = structuredClone(snapshot);
    out.credentialEncryption.portable = bundle;
    return out;
  } finally {
    zeroBuffer(hashKey);
    for (const dek of deks.values()) zeroBuffer(dek);
  }
}

/**
 * Reverse of makeInstancePortable: unseal the portable bundle under the
 * passphrase and rewrap every DEK and the hash key under the DESTINATION
 * master key (same dekKid/hashKid — credential leaf envelopes stay
 * byte-exact). Sets credentialEncryption.kekKid to the destination kid and
 * removes the portable marker. Returns a NEW normalized snapshot.
 * @param {object} snapshot portable snapshot (credentialEncryption.portable set).
 * @param {{passphrase:string, masterKey:Buffer}} opts destination root + passphrase.
 * @returns {Promise<object>} cloned format-v3 snapshot under the destination root.
 */
export async function unlockInstancePortable(snapshot, { passphrase, masterKey } = {}) {
  const src = graph(snapshot);
  if (!isPassphraseWrapShape(src.cred.portable)) fail();
  requireMaster(masterKey);
  if (typeof passphrase !== "string" || passphrase.length === 0) fail();
  const out = structuredClone(snapshot);
  const rows = out.workspaceKeys;
  const cred = out.credentialEncryption;
  let unsealed = null;
  try {
    try {
      unsealed = await unwrapPortableKeys(src.cred.portable, { passphrase });
    } catch {
      fail();
    }
    if (unsealed.deks.size !== rows.length) fail();
    const kid = masterKeyId(masterKey);
    for (const row of rows) {
      const dek = unsealed.deks.get(row.workspaceId);
      if (!dek) fail();
      row.wrappedDek = JSON.stringify(
        encryptBytes(masterKey, kid, dek, buildDekWrapAad(row.workspaceId, row.kid)),
      );
    }
    cred.apiKeyHashKeyWrapped = JSON.stringify(
      encryptBytes(
        masterKey,
        kid,
        unsealed.hashKey,
        buildHashKeyWrapAad(src.defaultWs, src.hashKid),
      ),
    );
    cred.kekKid = kid;
    delete cred.portable;
    return out;
  } finally {
    if (unsealed) {
      zeroBuffer(unsealed.hashKey);
      for (const dek of unsealed.deks.values()) zeroBuffer(dek);
    }
  }
}
