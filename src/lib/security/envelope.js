// YAN-365 pure AES-256-GCM envelope codec (D1, D2, D10). Node crypto only: no
// DB, driver, barrel, switch, session or readiness imports, so every storage,
// activation and rotation module can use it without a cycle.
//
// Envelope: { v:1, kid, iv, ct, tag } with canonical base64. Plaintext is
// returned only after the GCM tag verified (final() succeeded). Every
// parser/tag/AAD/key failure on decrypt shares one safe code and message.
import crypto from "node:crypto";

export const ENVELOPE_VERSION = 1;
export const MAX_SECRET_BYTES = 64 * 1024;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_KID_LEN = 64;
// Bound the encoded ct before any decode/allocation: canonical base64 of 64 KiB.
const MAX_CT_B64 = Math.ceil(MAX_SECRET_BYTES / 3) * 4;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

export const TABLE_NAMES = Object.freeze({
  providerConnections: "providerConnections",
  providerNodes: "providerNodes",
  settings: "settings",
});

// D10 shared allow-list: drives both encryption and metadata redaction. Nested
// provider data fields use dotted paths. Order is part of the frozen contract.
export const CREDENTIAL_FIELD_ALLOWLIST = Object.freeze({
  providerConnections: Object.freeze([
    "accessToken",
    "refreshToken",
    "idToken",
    "apiKey",
    "providerSpecificData.clientSecret",
    "providerSpecificData.copilotToken",
    "providerSpecificData.idToken",
    "providerSpecificData.firebaseIdToken",
    "providerSpecificData.mimoPassToken",
    "providerSpecificData.cookie",
    "providerSpecificData.apiKey",
    "providerSpecificData.secretAccessKey",
  ]),
  providerNodes: Object.freeze(["apiKey", "accessToken", "refreshToken", "idToken", "authHeader"]),
  settings: Object.freeze([
    "oidcClientSecret",
    "samlPrivateKey",
    "samlDecryptionKey",
    "samlSigningKey",
    "mitmSudoEncrypted",
  ]),
});

function fail(code, message) {
  throw Object.assign(new Error(`[envelope] ${message}`), { code });
}

// One shared public failure for every decrypt-side problem (no oracle).
function decryptFailed() {
  return Object.assign(new Error("[envelope] credential could not be decrypted"), {
    code: "DECRYPT_FAILED",
  });
}

function envelopeInvalid() {
  return Object.assign(new Error("[envelope] invalid credential envelope"), {
    code: "ENVELOPE_INVALID",
  });
}

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    fail("KEY_INVALID", "key must be a 32-byte Buffer");
  }
}

function checkComponent(name, value) {
  if (typeof value !== "string" || value.length === 0) fail("AAD_INVALID", `${name} is required`);
  // `|` separates components; control chars (U+0000-U+001F, U+007F) are banned.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters at the AAD boundary.
  if (value.includes("|") || /[\u0000-\u001f\u007f]/.test(value)) {
    fail("AAD_INVALID", `${name} contains a forbidden character`);
  }
}

/** D1 field AAD: `v1|<table>|<rowId>|<workspaceId>|<field>`. Same builder for encrypt and decrypt. */
export function buildAad({ table, rowId, workspaceId, field } = {}) {
  if (typeof table !== "string" || !Object.hasOwn(CREDENTIAL_FIELD_ALLOWLIST, table)) {
    fail("AAD_INVALID", "table is not a credential table");
  }
  checkComponent("rowId", rowId);
  checkComponent("workspaceId", workspaceId);
  checkComponent("field", field);
  if (!CREDENTIAL_FIELD_ALLOWLIST[table].includes(field)) {
    fail("AAD_INVALID", "field is not on the credential allow-list");
  }
  return `v1|${table}|${rowId}|${workspaceId}|${field}`;
}

/** DEK wrap AAD: `v1|workspaceKeys|<ws>|<ws>|dek:<dekKid>`. */
export function buildDekWrapAad(workspaceId, dekKid) {
  checkComponent("workspaceId", workspaceId);
  checkComponent("dekKid", dekKid);
  return `v1|workspaceKeys|${workspaceId}|${workspaceId}|dek:${dekKid}`;
}

/** Wrapped derived API-key hash key AAD: `v1|_meta|apiKeyHashKey|<defaultWs>|hashKid:<hashKid>`. */
export function buildHashKeyWrapAad(defaultWorkspaceId, hashKid) {
  checkComponent("defaultWorkspaceId", defaultWorkspaceId);
  checkComponent("hashKid", hashKid);
  return `v1|_meta|apiKeyHashKey|${defaultWorkspaceId}|hashKid:${hashKid}`;
}

// Canonical base64 of exactly `bytes` bytes, or null. Length check precedes decode.
function strictB64(value, { bytes, max } = {}) {
  if (typeof value !== "string") return null;
  if (bytes !== undefined) {
    if (value.length !== Math.ceil(bytes / 3) * 4) return null;
  } else if (value.length > max || value.length % 4 !== 0) {
    return null;
  }
  if (!B64.test(value)) return null;
  const raw = Buffer.from(value, "base64");
  if (bytes !== undefined && raw.length !== bytes) return null;
  return raw.toString("base64") === value ? raw : null;
}

const ENVELOPE_KEYS = ["ct", "iv", "kid", "tag", "v"];

function parseEnvelope(envelope) {
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) return null;
  const keys = Object.keys(envelope).sort();
  if (keys.length !== ENVELOPE_KEYS.length || keys.some((k, i) => k !== ENVELOPE_KEYS[i])) {
    return null;
  }
  if (envelope.v !== ENVELOPE_VERSION) return null;
  const { kid } = envelope;
  if (typeof kid !== "string" || kid.length === 0 || kid.length > MAX_KID_LEN) return null;
  const iv = strictB64(envelope.iv, { bytes: IV_BYTES });
  const tag = strictB64(envelope.tag, { bytes: TAG_BYTES });
  const ct = strictB64(envelope.ct, { max: MAX_CT_B64 });
  if (!iv || !tag || !ct || ct.length > MAX_SECRET_BYTES) return null;
  return { kid, iv, tag, ct };
}

/** Strict structural predicate. Never decodes unbounded input and never throws. */
export function isEnvelopeShape(value) {
  try {
    return parseEnvelope(value) !== null;
  } catch {
    return false;
  }
}

/** @returns {{v:1,kid:string,iv:string,ct:string,tag:string}} */
export function encryptBytes(key, kid, plaintext, aad) {
  assertKey(key);
  if (typeof kid !== "string" || kid.length === 0 || kid.length > MAX_KID_LEN) {
    fail("KID_INVALID", "kid is invalid");
  }
  if (!Buffer.isBuffer(plaintext)) fail("ENVELOPE_INVALID", "plaintext must be a Buffer");
  if (plaintext.length > MAX_SECRET_BYTES) fail("ENVELOPE_INVALID", "secret exceeds 64 KiB");
  if (typeof aad !== "string" || aad.length === 0) fail("AAD_INVALID", "aad is required");
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: ENVELOPE_VERSION,
    kid,
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/**
 * Plaintext only after the tag verified. Every failure after a key-shape check
 * is the same DECRYPT_FAILED; structural problems are ENVELOPE_INVALID.
 * @returns {Buffer}
 */
export function decryptBytes(key, envelope, aad) {
  assertKey(key);
  const parsed = parseEnvelope(envelope);
  if (!parsed) throw envelopeInvalid();
  if (typeof aad !== "string" || aad.length === 0) throw decryptFailed();
  let plaintext;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, parsed.iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(parsed.tag);
    // Buffer all output; nothing leaves this function unless final() verifies.
    plaintext = Buffer.concat([decipher.update(parsed.ct), decipher.final()]);
  } catch {
    throw decryptFailed();
  }
  return plaintext;
}

/** Best-effort zeroing of a key/plaintext Buffer. */
export function zeroBuffer(buf) {
  if (Buffer.isBuffer(buf)) buf.fill(0);
}

export function randomKey() {
  return crypto.randomBytes(KEY_BYTES);
}

/** Random DEK kid: `dk_` + 16 hex, unrelated to the root id. */
export function randomDekKid() {
  return `dk_${crypto.randomBytes(8).toString("hex")}`;
}
