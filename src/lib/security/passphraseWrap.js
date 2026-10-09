// YAN-375 passphrase portability wrap (single per-file scrypt KDF + single
// AES-GCM seal). A portable instance snapshot carries one compact wrapped
// key bundle: every workspace DEK (covered by the export) and the derived
// API-key hash key, sealed under ONE scrypt(passphrase) key so a restore on
// an instance with a DIFFERENT KEK can adopt the graph and rewrap it under
// its own root. Same-root restores never need it.
//
// Pure module: node:crypto + the envelope codec only (no DB/driver/switch
// imports). The wrap body reuses the versioned `{v:1,kid,iv,ct,tag}` envelope
// codec; wrapping metadata (scrypt params + salt) is authenticated by being
// encoded INSIDE the sealed blob — any tamper or wrong passphrase surfaces as
// the one generic code, never an oracle. Salt 16 bytes, KDF key 32 bytes,
// iv 12 / tag 16 exact (the codec's strict parser enforces).
import crypto from "node:crypto";
import { decryptBytes, encryptBytes, zeroBuffer } from "./envelope.js";

export const PASSPHRASE_WRAP_VERSION = 1;
export const PASSPHRASE_WRAP_KID = "pw1";
// One scrypt per file: params travel in plaintext metadata for the importer
// (exact-pin check below) AND verbatim inside the sealed blob so the
// authenticated proof covers them.
const KDF = Object.freeze({ algo: "scrypt", N: 65536, r: 8, p: 1 });
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const MAX_PASSPHRASE_BYTES = 1024;
// scrypt sync peak memory ≈ 128·N·r·p + 1 MiB slack; params are pinned, so
// this caps derivation at exactly the published KDF cost.
const SCRYPT_MAXMEM = 128 * KDF.N * KDF.r * KDF.p + 1024 * 1024;
const MAX_WRAP_B64 = Math.ceil((64 * 1024) / 3) * 4; // sealed JSON ≤ 64 KiB
const MAX_WRAP_KEYS = 512;
const MAX_DEK_B64 = 44; // canonical base64 of 32 bytes
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

function invalid() {
  throw Object.assign(new Error("[passphrase-wrap] passphrase wrap is invalid or corrupt"), {
    code: "PASSPHRASE_WRAP_INVALID",
  });
}

export function passphraseWrapInvalid() {
  return invalid();
}

function strictB64(value, bytes) {
  if (typeof value !== "string") return null;
  if (value.length !== Math.ceil(bytes / 3) * 4 || !B64.test(value)) return null;
  const raw = Buffer.from(value, "base64");
  return raw.length === bytes && raw.toString("base64") === value ? raw : null;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Plaintext param pre-validation (import side): parse/pin BEFORE any
// scrypt runs so a hostile N never burns memory. Anything odd → generic fail.
function checkParams(section) {
  if (!isPlainObject(section)) invalid();
  const keys = Object.keys(section).sort();
  if (keys.join(",") !== "kdf,salt,v,wrap") invalid();
  if (section.v !== PASSPHRASE_WRAP_VERSION) invalid();
  const { kdf } = section;
  if (
    !isPlainObject(kdf) ||
    kdf.algo !== KDF.algo ||
    kdf.N !== KDF.N ||
    kdf.r !== KDF.r ||
    kdf.p !== KDF.p
  ) {
    invalid();
  }
  const salt = strictB64(section.salt, SALT_BYTES);
  if (!salt) invalid();
  return { kdf: { ...KDF }, salt };
}

// Derive the wrap key under the pinned KDF; raw scrypt failures (never
// expected) surface as the same generic invalid() as any other bad wrap.
function deriveWrapKey(passphrase, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(passphrase, salt, KEY_BYTES, { ...KDF, maxmem: SCRYPT_MAXMEM }, (err, out) =>
      err ? reject(err) : resolve(out),
    );
  }).catch(() => invalid());
}

/** Strict structural predicate; never derives and never throws. */
export function isPassphraseWrapShape(value) {
  try {
    const { salt } = checkParams(value);
    return salt !== null;
  } catch {
    return false;
  }
}

/**
 * Seal `keys` ({ hashKey: base64(32), deks: { workspaceId: base64(32) } })
 * under one scrypt(passphrase) key. The wrap body is a standard envelope
 * (`kid: "pw1"`); salt/params are ALSO authenticated by the sealed copy, so
 * importing metadata that disagrees with the sealed copy fails authentication.
 */
export async function wrapPortableKeys(options) {
  const { passphrase, hashKey, deks } = options ?? {};
  if (
    typeof passphrase !== "string" ||
    passphrase.length === 0 ||
    Buffer.byteLength(passphrase, "utf8") > MAX_PASSPHRASE_BYTES
  ) {
    invalid();
  }
  if (!Buffer.isBuffer(hashKey) || hashKey.length !== KEY_BYTES) invalid();
  const dekEntries = Object.entries(deks ?? {});
  if (dekEntries.length > MAX_WRAP_KEYS) invalid();
  const bodyDeks = {};
  for (const [workspaceId, dek] of dekEntries) {
    if (typeof workspaceId !== "string" || !workspaceId || workspaceId.length > 128) invalid();
    if (!Buffer.isBuffer(dek) || dek.length !== KEY_BYTES) invalid();
    bodyDeks[workspaceId] = dek.toString("base64");
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await deriveWrapKey(passphrase, salt);
  let bodyBuffer = null;
  try {
    const body = JSON.stringify({
      v: PASSPHRASE_WRAP_VERSION,
      kdf: { ...KDF },
      salt: salt.toString("base64"),
      hashKey: hashKey.toString("base64"),
      deks: bodyDeks,
    });
    bodyBuffer = Buffer.from(body, "utf8");
    const wrap = encryptBytes(
      key,
      PASSPHRASE_WRAP_KID,
      bodyBuffer,
      ["v1", "passphraseWrap", String(KDF.N), salt.toString("base64")].join("|"),
    );
    return {
      v: PASSPHRASE_WRAP_VERSION,
      kdf: { ...KDF },
      salt: salt.toString("base64"),
      wrap,
    };
  } finally {
    zeroBuffer(bodyBuffer);
    zeroBuffer(key);
  }
}

/**
 * Unseal a portable wrap. Async: the one scrypt runs before any caller-side
 * mutation. Every failure — bad shape, pinned-params mismatch, tampered
 * metadata/body, wrong passphrase — is the same PASSPHRASE_WRAP_INVALID.
 * @returns {Promise<{hashKey: Buffer, deks: Map<string, Buffer>}>}
 */
export async function unwrapPortableKeys(passphraseWrap, options) {
  const { passphrase } = options ?? {};
  if (
    typeof passphrase !== "string" ||
    passphrase.length === 0 ||
    Buffer.byteLength(passphrase, "utf8") > MAX_PASSPHRASE_BYTES
  ) {
    invalid();
  }
  const { kdf, salt } = checkParams(passphraseWrap);
  const wrap = passphraseWrap?.wrap;
  if (!isPlainObject(wrap) || wrap.kid !== PASSPHRASE_WRAP_KID) invalid();
  if (typeof wrap.ct !== "string" || wrap.ct.length > MAX_WRAP_B64) invalid();
  const key = await deriveWrapKey(passphrase, salt);
  let plain;
  try {
    plain = decryptBytes(
      key,
      wrap,
      ["v1", "passphraseWrap", String(kdf.N), salt.toString("base64")].join("|"),
    );
  } catch {
    invalid();
  } finally {
    zeroBuffer(key);
  }
  try {
    let body;
    try {
      body = JSON.parse(plain.toString("utf8"));
    } catch {
      invalid();
    }
    if (
      !isPlainObject(body) ||
      body.v !== PASSPHRASE_WRAP_VERSION ||
      !isPlainObject(body.kdf) ||
      body.kdf.algo !== kdf.algo ||
      body.kdf.N !== kdf.N ||
      body.kdf.r !== kdf.r ||
      body.kdf.p !== kdf.p ||
      body.salt !== salt.toString("base64")
    ) {
      invalid();
    }
    // Validate the deks container BEFORE allocating the hash key so a
    // shape failure never leaves key material unzeroed.
    if (!isPlainObject(body.deks) || Object.keys(body.deks).length > MAX_WRAP_KEYS) invalid();
    const hashKey = strictB64(body.hashKey, KEY_BYTES);
    if (!hashKey) invalid();
    const deks = new Map();
    try {
      for (const [workspaceId, encoded] of Object.entries(body.deks)) {
        if (typeof workspaceId !== "string" || !workspaceId || workspaceId.length > 128) invalid();
        if (typeof encoded !== "string" || encoded.length > MAX_DEK_B64) invalid();
        const dek = strictB64(encoded, KEY_BYTES);
        if (!dek) invalid();
        deks.set(workspaceId, dek);
      }
    } catch (error) {
      // partial parse: zero every secret allocated so far, then re-throw.
      zeroBuffer(hashKey);
      for (const dek of deks.values()) zeroBuffer(dek);
      throw error;
    }
    return { hashKey, deks };
  } finally {
    zeroBuffer(plain);
  }
}
