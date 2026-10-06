// YAN-365 legacy MITM sudo crypto, extracted side-effect-free (D11). Same
// ivHex:tagHex:ctHex machine-id AES-256-GCM math manager.js always used;
// activation (B3) requires this module directly and never imports the
// manager. Machine-id resolution stays lazy inside the with-machine-id
// wrappers so requiring this file has zero effects.
const crypto = require("node:crypto");

const ENCRYPT_ALGO = "aes-256-gcm";
const ENCRYPT_SALT = "9router-mitm-pwd"; // legacy(9router): stored-data salt, keep

// "" machine id reproduces the legacy salt-only fallback key sha256(SALT).
function machineIdOrNull() {
  try {
    const { machineIdSync } = require("node-machine-id");
    const raw = machineIdSync();
    return typeof raw === "string" && raw ? raw : null;
  } catch {
    return null;
  }
}

function deriveLegacySudoKey(machineId) {
  return crypto.createHash("sha256").update(`${machineId}${ENCRYPT_SALT}`).digest();
}

/** Pure decrypt of one legacy `ivHex:tagHex:ctHex` value. Null on any corruption. */
function decryptLegacySudoPassword(stored, machineId) {
  try {
    if (typeof stored !== "string") return null;
    const [ivHex, tagHex, dataHex] = stored.split(":");
    if (!ivHex || !tagHex || !dataHex) return null;
    const key = deriveLegacySudoKey(machineId);
    const decipher = crypto.createDecipheriv(ENCRYPT_ALGO, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return decipher.update(Buffer.from(dataHex, "hex")) + decipher.final("utf8");
  } catch {
    return null;
  }
}

/** Pure encrypt with an explicit machine id (tests / activation diagnostics). */
function encryptLegacySudoPassword(plaintext, machineId) {
  const key = deriveLegacySudoKey(machineId);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPT_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/** Legacy decrypt with the real machine id (salt-only fallback preserved). */
function decryptPassword(stored) {
  return decryptLegacySudoPassword(stored, machineIdOrNull() ?? "");
}

/** Legacy encrypt with the real machine id (salt-only fallback preserved). */
function encryptPassword(plaintext) {
  return encryptLegacySudoPassword(plaintext, machineIdOrNull() ?? "");
}

module.exports = {
  ENCRYPT_ALGO,
  ENCRYPT_SALT,
  deriveLegacySudoKey,
  decryptLegacySudoPassword,
  encryptLegacySudoPassword,
  decryptPassword,
  encryptPassword,
};
