// YAN-375 workspace-transfer passphrase wrap: a narrowly scoped, domain-
// separated primitive for ONE portable DEK. Not passphraseWrap.js (that lane
// owns the instance snapshot's hash-key + multi-DEK graph): this file only
// ever wraps a single 32-byte workspace export key. scrypt N=65536 r=8 p=1,
// salt 16 bytes, AES-256-GCM envelope via the shared codec; kdf params and
// salt are authenticated by a verbatim copy INSIDE the sealed body, and the
// AAD pins the domain (`v1|wsExportDek|<N>|<salt>`), so a wrap from another
// lane never authenticates here and metadata tampering fails closed.
// Import-side params are allow-list checked BEFORE any scrypt work (DoS
// guard). Every failure — bad shape, hostile params, tamper, wrong
// passphrase — is the same generic PASSPHRASE_INVALID; no oracle.
import crypto from "node:crypto";
import { decryptBytes, encryptBytes, zeroBuffer } from "../../security/envelope.js";

export const WS_EXPORT_WRAP_VERSION = 1;
const WS_EXPORT_KID = "wsxdek1";
const KDF = Object.freeze({ algo: "scrypt", N: 65536, r: 8, p: 1 });
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const SCRYPT_MAXMEM = 128 * KDF.N * KDF.r + 1024 * 1024;
const MAX_PASSPHRASE_BYTES = 1024; // reject before scrypt: bounded KDF input
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
const AAD = (n, saltB64) => ["v1", "wsExportDek", String(n), saltB64].join("|");

function invalid() {
  throw Object.assign(
    new Error("[workspace-transfer] passphrase is incorrect or the snapshot is corrupt"),
    { code: "PASSPHRASE_INVALID" },
  );
}

function validPassphrase(p) {
  return (
    typeof p === "string" && p.length > 0 && Buffer.byteLength(p, "utf8") <= MAX_PASSPHRASE_BYTES
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strictB64(value, bytes) {
  if (typeof value !== "string") return null;
  if (value.length !== Math.ceil(bytes / 3) * 4 || !B64.test(value)) return null;
  const raw = Buffer.from(value, "base64");
  return raw.length === bytes && raw.toString("base64") === value ? raw : null;
}

// Plaintext param pre-validation (import side) BEFORE any scrypt runs.
function checkKdfSection(section) {
  if (!isPlainObject(section)) invalid();
  const keys = Object.keys(section).sort();
  if (keys.join(",") !== "N,alg,p,r") invalid();
  const { N, r, p } = section;
  if (section.alg !== "scrypt" || N !== KDF.N || r !== KDF.r || p !== KDF.p) {
    invalid();
  }
  return { algo: "scrypt", N, r: 8, p: 1 };
}

function derive(passphrase, kdf, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(passphrase, salt, KEY_BYTES, { ...kdf, maxmem: SCRYPT_MAXMEM }, (err, out) =>
      err ? reject(err) : resolve(out),
    );
  });
}

/**
 * Wrap one 32-byte portable DEK under scrypt(passphrase).
 * @returns {{kdf:{alg:'scrypt',N:number,r:number,p:number}, saltB64:string, wrappedDek:object}}
 */
export async function wrapWorkspaceExportDek(passphrase, dek) {
  if (!validPassphrase(passphrase)) invalid();
  if (!Buffer.isBuffer(dek) || dek.length !== KEY_BYTES) invalid();
  const kdf = { ...KDF };
  const salt = crypto.randomBytes(SALT_BYTES);
  const saltB64 = salt.toString("base64");
  const key = await derive(passphrase, kdf, salt).catch(() => invalid());
  let bodyBuffer;
  try {
    bodyBuffer = Buffer.from(
      JSON.stringify({
        v: WS_EXPORT_WRAP_VERSION,
        kdf,
        salt: saltB64,
        dek: dek.toString("base64"),
      }),
      "utf8",
    );
    return {
      kdf: { alg: "scrypt", N: kdf.N, r: kdf.r, p: kdf.p },
      saltB64,
      wrappedDek: encryptBytes(key, WS_EXPORT_KID, bodyBuffer, AAD(kdf.N, saltB64)),
    };
  } finally {
    zeroBuffer(bodyBuffer);
    zeroBuffer(key);
  }
}

/**
 * Unwrap the portable DEK. Every failure is the same generic PASSPHRASE_INVALID.
 * @returns {Promise<Buffer>} the 32-byte DEK (caller zeroes it)
 */
export async function unwrapWorkspaceExportDek(document, options) {
  const { kdf, saltB64, wrappedDek } = isPlainObject(document) ? document : {};
  const passphrase = isPlainObject(options) ? options.passphrase : undefined;
  if (!validPassphrase(passphrase)) invalid();
  const params = checkKdfSection(kdf);
  const salt = typeof saltB64 === "string" ? strictB64(saltB64, SALT_BYTES) : null;
  if (!salt) invalid();
  if (!isPlainObject(wrappedDek) || wrappedDek.kid !== WS_EXPORT_KID) invalid();
  const key = await derive(passphrase, params, salt).catch(() => invalid());
  let plain;
  try {
    plain = decryptBytes(key, wrappedDek, AAD(params.N, salt.toString("base64")));
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
      body.v !== WS_EXPORT_WRAP_VERSION ||
      !isPlainObject(body.kdf) ||
      body.kdf.algo !== params.algo ||
      body.kdf.N !== params.N ||
      body.kdf.r !== params.r ||
      body.kdf.p !== params.p ||
      body.salt !== salt.toString("base64")
    ) {
      invalid();
    }
    const dek = strictB64(body.dek, KEY_BYTES);
    if (!dek) invalid();
    return dek;
  } finally {
    zeroBuffer(plain);
  }
}
