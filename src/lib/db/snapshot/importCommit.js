// Import commit helpers: durable flush, cache invalidation and the
// encrypted-import gate. Moved verbatim from the db barrel.
import { readCredentialEncryptionState } from "../credentialEncryptionState.js";
import { poisonCredentialMaintenance } from "../credentialMaintenance.js";
import { clearApiKeysSchemaCache } from "../helpers/apiKeysSchema.js";
import { isConfirmedLegacyPayload } from "../helpers/legacyEncryptedImport.js";
import {
  CREDENTIAL_TRANSFER_FORMAT_VERSION,
  TransferError,
} from "../helpers/gatewayKeyTransfer.js";

// YAN-365: on established credential encryption — or an ambiguous/corrupt
// marker (fail closed) — only formatVersion 3 enters. "Legacy" classification
// (formatVersion 1) happens before any credential-shape check, so an exact
// version pin here closes the `{}`/`null` credentialEncryption smuggle that
// would otherwise route to the wipe-and-write-plaintext apply.
// YAN-375: the one exception is a confirmed legacy (v1, no credential/marker
// section) payload while the multi-user switch is ON and the marker is cleanly
// encrypted: it imports into Default through the credential codec. Returns
// true for that route. A corrupt marker still fails closed (strict read throws).
export async function assertEncryptedImportAllowed(db, payload) {
  let encrypted = false;
  let clean = false;
  try {
    encrypted = readCredentialEncryptionState(db, { strict: true }).storage === "encrypted";
    clean = true;
  } catch {
    encrypted = true;
  }
  if (!encrypted || payload?.formatVersion === CREDENTIAL_TRANSFER_FORMAT_VERSION) return false;
  if (clean && isConfirmedLegacyPayload(payload)) {
    const { isMultiUserEnabled } = await import("@/lib/users/featureSwitch.js");
    if (await isMultiUserEnabled()) return true;
  }
  throw new TransferError(
    "TRANSFER_FORMAT_INVALID",
    "Encrypted instance: restore a v3 snapshot with the matching root",
  );
}

const NATIVE_DRIVERS = ["better-sqlite3", "node:sqlite", "bun:sqlite"];

// Same strict durability contract as activation/rotation (not imported: those
// modules sit above this barrel). sql.js must expose a throwing flushSync;
// native drivers commit synchronously and need a checked FULL checkpoint.
export function flushStrict(db) {
  const fail = (code, message) => {
    throw Object.assign(new Error(`[db-import] ${message}`), { code });
  };
  if (db.driver === "sql.js") {
    if (typeof db.flushSync !== "function")
      fail("IMPORT_FLUSH_REQUIRED", "Throwing sql.js flush required");
    db.flushSync();
  } else if (NATIVE_DRIVERS.includes(db.driver)) {
    const row = db.get("PRAGMA wal_checkpoint(FULL)");
    if (row?.busy) fail("IMPORT_FLUSH_FAILED", "WAL checkpoint busy");
  } else fail("IMPORT_DRIVER_UNSUPPORTED", "Unsupported durability contract");
}

// The destructive transaction already committed in memory/WAL. Prove it is
// durable BEFORE invalidating caches or reporting success. Failure is an
// uncertain commit: never claim rollback; poison the adapter so no credential
// use or raw write proceeds until restart, then surface the original error.
export function commitDurably(db, invalidateCaches) {
  try {
    flushStrict(db);
  } catch (error) {
    poisonCredentialMaintenance(db, error);
    throw error;
  }
  invalidateCaches();
}

/** Load caches before mutation; clear synchronously AFTER verified persistence.
 * Resolver cache holds ids only and always live-checks eligibility; clearing
 * still prevents old state surviving replacement. Import/clear errors propagate.
 * YAN-365: credential DEK cache, the hash-key state memo and the MITM sudo
 * cache join the API/pricing purge after an encrypted restore.
 */
export async function prepareTransferCacheInvalidation(db) {
  const { clearApiKeyPrincipalCache } = await import("@/lib/auth/apiKeyPrincipal.js");
  const { invalidatePricingCache } = await import("../repos/pricingRepo.js");
  const { clearCredentialCache } = await import("../helpers/credentialStorage.js");
  const { clearApiKeyHashKeyStateCache } = await import("@/lib/security/apiKeyHashKey.js");
  const mitm = await import("@/mitm/manager.js").catch(() => null);
  // CJS module: named export or default.* depending on interop.
  const setter = mitm?.default?.setCachedPassword ?? mitm?.setCachedPassword;
  return () => {
    try {
      clearApiKeysSchemaCache(db);
      clearApiKeyPrincipalCache();
      clearCredentialCache(db);
      clearApiKeyHashKeyStateCache(db);
      setter?.(null);
    } finally {
      invalidatePricingCache();
    }
  };
}
