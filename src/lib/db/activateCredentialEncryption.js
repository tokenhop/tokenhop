// YAN-365 (task 3.1) backup-gated credential-encryption activation.
// Trusted startup-only options, NEVER request input (same contract as
// activateGatewayKeys). Startup order in startupReadiness: lock/schema →
// pending-rotation recovery (fail-closed stub until B4) → strict state + root
// prep for established storage → raw switch → owner bootstrap → gateway-key
// activation → THIS activation.
//
// First activation pre-resolves the root and the legacy MITM helper (module
// import, never the MITM manager), takes a verified PRIVATE pre-activation
// backup — a corrupt backup aborts with zero mutation — then commits ONE
// sync transaction (DEKs, D10 encryption, MITM re-key, wrapped derived hash
// key, marker + cleanup-pending) and runs the D7 physical cleanup: strict
// flush, checked WAL TRUNCATE, live VACUUM, TRUNCATE again, durable
// cleanup-pending clear. A crash between commit and cleanup leaves the
// durable marker; the next start finishes cleanup before readiness.
//
// Never: claim zero mutation after an uncertain commit (it poisons the
// adapter instead), regenerate a replacement root, fall back to plaintext,
// or leave a workspace DEK behind a deleted workspace.
import { readCredentialEncryptionState } from "./credentialEncryptionState.js";
import { readApiKeyStorageState } from "./apiKeyState.js";
import { loadMasterKey } from "../security/masterKey.js";
import { prepareCredentialContext } from "./helpers/credentialStorage.js";
import { resolveApiKeyHashKeySync } from "../security/apiKeyHashKey.js";
import { poisonCredentialMaintenance } from "./credentialMaintenance.js";
import {
  CREDENTIAL_ENCRYPTION_BACKUP_PREFIX,
  backupDbLite,
  makeProtectedBackupDir,
  prepareProtectedBackupVerifier,
} from "./backup.js";
import {
  encryptCredentialsInTransaction,
  verifyEncryptedRowsSync,
} from "./migrations/encryptCredentials.js";
import legacyMitm from "../../mitm/legacyPasswordCrypto.cjs";

const NATIVE_DRIVERS = ["better-sqlite3", "node:sqlite", "bun:sqlite"];
const flights = new WeakMap();

function fail(code, message) {
  throw Object.assign(new Error(`[credential-activation] ${message}`), { code });
}

function flushStrict(db) {
  if (db.driver === "sql.js") {
    if (typeof db.flushSync !== "function")
      fail("ACTIVATION_FLUSH_REQUIRED", "Throwing sql.js flush required");
    db.flushSync();
  } else if (NATIVE_DRIVERS.includes(db.driver)) {
    // Native adapters commit to WAL; FULL covers activation durability.
    const row = db.get("PRAGMA wal_checkpoint(FULL)");
    if (row?.busy) fail("ACTIVATION_FLUSH_FAILED", "WAL checkpoint busy");
  } else fail("ACTIVATION_DRIVER_UNSUPPORTED", "Unsupported durability contract");
}

// D7 physical plaintext cleanup after the encryption commit. Any failure
// leaves the durable cleanup-pending marker set: the next start redoes this
// before readiness. VACUUM rebuilds freelist pages; the checked TRUNCATE
// checkpoints drop the WAL frames both sides of it.
function finishCleanup(db) {
  if (NATIVE_DRIVERS.includes(db.driver)) {
    const first = db.get("PRAGMA wal_checkpoint(TRUNCATE)");
    if (first?.busy) fail("ACTIVATION_CHECKPOINT_BUSY", "WAL checkpoint busy");
  }
  db.exec("VACUUM");
  if (NATIVE_DRIVERS.includes(db.driver)) {
    const second = db.get("PRAGMA wal_checkpoint(TRUNCATE)");
    if (second?.busy) fail("ACTIVATION_CHECKPOINT_BUSY", "WAL checkpoint busy");
  }
  db.run(`DELETE FROM _meta WHERE key = 'credentialsCleanupPending'`);
  flushStrict(db);
}

// Established storage (marker latched): root prep + KEK/hash-key proof +
// full envelope authentication; finish pending cleanup when set. Missing or
// wrong root poisons raw-write/credential admission until restart (D3) —
// never regenerate, never plaintext-fallback.
async function recover(db, state, root) {
  let resolvedRoot;
  try {
    resolvedRoot = root ?? (await loadMasterKey({ create: false, expectedKid: state.kekKid }));
    if (resolvedRoot.kid !== state.kekKid)
      fail("KEY_MISMATCH", "root does not match the credential KEK id");
    prepareCredentialContext(db, resolvedRoot);
    resolveApiKeyHashKeySync(db, resolvedRoot);
    verifyEncryptedRowsSync(db, resolvedRoot);
  } catch (err) {
    const wrapped =
      err?.code instanceof String || typeof err?.code === "string"
        ? err
        : Object.assign(
            new Error(`[credential-activation] root key unavailable: ${err?.message ?? err}`),
            { code: "KEY_MISSING", cause: err },
          );
    poisonCredentialMaintenance(db, wrapped);
    throw wrapped;
  }
  if (state.cleanupPending) {
    try {
      finishCleanup(db);
    } catch (err) {
      poisonCredentialMaintenance(db, err);
      throw err;
    }
  }
  return { status: "ready", isReady: true, alreadyEncrypted: true };
}

/**
 * @param {object} db adapter.
 * @param {{ enabled?: boolean, beforeServing?: boolean, root?: {kid:string,key:Buffer}|null,
 *   crashAfter?: "commit-before-cleanup" }} [options] trusted startup-only.
 * `root` is for isolated fixtures/tests; production omits it and the root is
 * loaded with the kid the current state demands (created only on a first
 * switch-on, mirroring gateway activation). `crashAfter` is a test-only
 * fixture boundary: the commit is made durable and the process state is
 * returned as crash-pending-cleanup instead of finishing cleanup.
 * @returns {Promise<{status:string,isReady:boolean,...}>}
 */
export function activateCredentialEncryption(db, options = {}) {
  if (flights.has(db)) fail("ACTIVATION_IN_FLIGHT", "Credential activation already in flight");
  const promise = Promise.resolve().then(() => activate(db, options));
  flights.set(db, promise);
  return promise.finally(() => flights.delete(db));
}

async function activate(
  db,
  { enabled = false, beforeServing = false, root = null, crashAfter = undefined } = {},
) {
  if (typeof enabled !== "boolean") fail("ACTIVATION_OPTIONS_INVALID", "Boolean switch required");
  if (crashAfter !== undefined && crashAfter !== "commit-before-cleanup")
    fail("ACTIVATION_OPTIONS_INVALID", "unknown crash boundary");
  if (
    root !== null &&
    (typeof root.kid !== "string" || !Buffer.isBuffer(root.key) || root.key.length !== 32)
  )
    fail("ACTIVATION_OPTIONS_INVALID", "root {kid,key} invalid");

  const state = readCredentialEncryptionState(db);
  const apiState = readApiKeyStorageState(db);
  // D4: a never-enabled install with the switch off performs zero mutation —
  // no root file, no backup, no DEKs, no marker.
  if (state.storage === "legacy" && !enabled) return { status: "skipped-off", isReady: false };
  if (beforeServing !== true) fail("ACTIVATION_STARTUP_REQUIRED", "Quiesced startup required");

  if (state.storage === "encrypted") return recover(db, state, root);

  // First irreversible activation requires established hashed gateway keys
  // (D6): gateway-key activation runs earlier in the same startup chain.
  if (apiState.storage !== "hashed")
    fail("ACTIVATION_GATEWAY_REQUIRED", "Gateway key activation must complete first");

  const resolvedRoot =
    root ?? (await loadMasterKey({ create: false, expectedKid: apiState.hashKid }));
  // Gateway-key activation earlier in the same startup chain already
  // established (or created) the root for this kid. A missing root HERE means
  // it vanished between the steps: fail — never create a replacement file.
  if (resolvedRoot.kid !== apiState.hashKid)
    fail("KEY_MISMATCH", "root does not match the frozen hash key id");

  const defaultId = db.get(`SELECT value FROM _meta WHERE key = 'defaultWorkspaceId'`)?.value;
  if (
    typeof defaultId !== "string" ||
    !defaultId ||
    !db.get(`SELECT id FROM workspaces WHERE id = ?`, [defaultId])
  )
    fail("ACTIVATION_DEFAULT_WORKSPACE_MISSING", "Established Default workspace required");

  if (db.driver === "sql.js" && typeof db.flushSync !== "function")
    fail("ACTIVATION_FLUSH_REQUIRED", "Throwing sql.js flush required");

  // Verified private pre-activation backup (deliberately still plaintext —
  // D7: it is a pre-existing copy with manual retention, exempt from prune).
  // sql.js resolves before the snapshot so verify is sync; a nonempty but
  // corrupt or wrong backup aborts here with zero mutation.
  const verifyBackup = await prepareProtectedBackupVerifier();
  const backupDir = makeProtectedBackupDir(CREDENTIAL_ENCRYPTION_BACKUP_PREFIX);
  const backupFile = backupDbLite(db, backupDir);
  verifyBackup(backupDir, backupFile);

  const synchronous = db.get("PRAGMA synchronous")?.synchronous;
  if (synchronous !== undefined) db.exec("PRAGMA synchronous = FULL");
  let counts;
  try {
    counts = db.transaction(() =>
      encryptCredentialsInTransaction(db, resolvedRoot, {
        legacyDecrypt: legacyMitm.decryptPassword,
      }),
    );
  } finally {
    if (synchronous !== undefined) db.exec(`PRAGMA synchronous = ${synchronous}`);
  }

  // Post-commit durability is not success-on-hope: flush the committed
  // marker, then finish cleanup. Any failure here poisons the adapter and
  // keeps recovery state (marker/marker-pending) for the next start.
  try {
    flushStrict(db);
    if (crashAfter === "commit-before-cleanup")
      return { status: "crash-pending-cleanup", isReady: false, backupDir, counts };
    finishCleanup(db);
  } catch (err) {
    poisonCredentialMaintenance(db, err);
    throw err;
  }
  return { status: "ready", isReady: true, backupDir, counts };
}
