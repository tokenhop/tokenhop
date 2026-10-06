// Startup seam used by startupReadiness before serving requests/background
// writers, after owner/Default bootstrap and credential-sink review.
// Single-flight below coordinates activation callers ONLY; it is not a lock
// for other DB writers. No live-toggle support: parent must keep request
// readiness latched off on any failure, invalidate legacy key/usage caches
// before serving, and ensure no other process writes this DATA_DIR. Shutdown flushers swallow errors and are
// NOT a substitute for draining pending usage/request buffers before this call.
import fs from "node:fs";
import path from "node:path";
import { BACKUPS_DIR } from "./paths.js";
import { backupDbLite } from "./backup.js";
import { readApiKeyStorageState } from "./apiKeyState.js";
import { readCredentialEncryptionState } from "./credentialEncryptionState.js";
import { getApiKeyHashKey } from "../security/apiKeyHashKey.js";
import { HASHED_API_KEYS_TABLE } from "./schema.js";
import { hashGatewayKeysSync } from "./migrations/hashGatewayKeys.js";
import {
  initGatewayVideoJobsSync,
  requireGatewayVideoJobsSync,
} from "./repos/gatewayVideoJobsRepo.js";
import {
  deriveApiKeyHashKey,
  hashApiKey,
  loadMasterKey,
  masterKeyId,
} from "../security/masterKey.js";

const flights = new WeakMap();

function fail(code, message) {
  throw Object.assign(new Error(`[gateway-key-activation] ${message}`), { code });
}

function requireOwnerAndDefault(db) {
  const owner = db.get("SELECT id FROM users WHERE instanceRole = 'owner' AND status = 'active'");
  const defaultId = db.get("SELECT value FROM _meta WHERE key = 'defaultWorkspaceId'")?.value;
  if (!owner) fail("ACTIVATION_OWNER_MISSING", "Active instance owner required");
  if (
    !defaultId ||
    !db.get("SELECT id FROM workspaces WHERE id = ? AND kind = 'shared'", [defaultId])
  )
    fail("ACTIVATION_DEFAULT_WORKSPACE_MISSING", "Established Default workspace required");
  if (
    !db.get(
      "SELECT userId FROM memberships WHERE workspaceId = ? AND userId = ? AND role = 'owner'",
      [defaultId, owner.id],
    )
  )
    fail("ACTIVATION_DEFAULT_WORKSPACE_MISSING", "Default owner membership required");
  return defaultId;
}

// Fresh private directory contains raw credentials. Activation backups are
// exempt from backup.js's newest-3 auto-prune (PROTECTED_BACKUP_PREFIX):
// retention/recovery is manual by contract.
function protectedBackup(db) {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const parent = fs.lstatSync(BACKUPS_DIR);
  if (!parent.isDirectory() || parent.isSymbolicLink())
    fail("ACTIVATION_BACKUP_INVALID", "Backup directory must be a real directory");
  // backupDbLite creates the file with the process umask; this copy carries
  // raw gateway keys, so creation itself must be private, not just a later
  // chmod. Startup-only, single-threaded: a scoped umask window is safe.
  const previousUmask = process.umask(0o077);
  let dir;
  let file;
  try {
    dir = fs.mkdtempSync(path.join(BACKUPS_DIR, "gateway-key-activation-"));
    file = backupDbLite(db, dir);
    fs.chmodSync(dir, 0o700);
    fs.chmodSync(file, 0o600);
    const fd = fs.openSync(file, "r");
    try {
      if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size === 0)
        fail("ACTIVATION_BACKUP_INVALID", "Empty or invalid backup");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    process.umask(previousUmask);
  }
  // POSIX directory sync is required, not swallowed. Windows has no directory
  // fsync; private Unix modes also need deployment ACL protection there.
  if (process.platform !== "win32") {
    for (const target of [dir, BACKUPS_DIR]) {
      const directory = fs.openSync(target, "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    }
  }
  return { dir, file };
}

// Read-only open through the installed supported SQLite facility, same
// preference order as driver.js (bun:sqlite is skipped: not in this process
// when activation runs under Node; better-sqlite3 is skipped on Node >= 24
// where the addon SIGSEGVs). sql.js is the always-available fallback; its WASM
// is module-cached, and activation runs once per boot, so no per-request init.
async function openBackupReadonly(file) {
  if (!process.versions.bun) {
    const [maj, min] = process.versions.node.split(".").map(Number);
    if (maj > 22 || (maj === 22 && min >= 5)) {
      try {
        const { DatabaseSync } = await import("node:sqlite");
        const handle = new DatabaseSync(file, { readOnly: true });
        return {
          get: (sql, params = []) => handle.prepare(sql).get(...params),
          all: (sql, params = []) => handle.prepare(sql).all(...params),
          close: () => handle.close(),
        };
      } catch {}
    }
    const [nodeMajor] = process.versions.node.split(".").map(Number);
    if (nodeMajor < 24) {
      try {
        const { default: Database } = await import("better-sqlite3");
        const handle = new Database(file, { readonly: true });
        return {
          get: (sql, params = []) => handle.prepare(sql).get(...params),
          all: (sql, params = []) => handle.prepare(sql).all(...params),
          close: () => handle.close(),
        };
      } catch {}
    }
  }
  try {
    const { createSqlJsAdapter } = await import("./adapters/sqljsAdapter.js");
    const adapter = await createSqlJsAdapter(file);
    return { get: adapter.get, all: adapter.all, close: () => adapter.close() };
  } catch {
    fail("ACTIVATION_BACKUP_INVALID", "Backup snapshot unreadable");
  }
}

// The backup is the only recovery path for the raw keys activation destroys,
// so its bytes are validated BEFORE any mutation. Checks: SQLite integrity,
// legacy marker/schema at backup time (a hashed/wrong snapshot is not a
// pre-activation copy), row count, and per-key id + HMAC-digest equality with
// the live table. Raw keys are compared via keyed digests only — never
// materialized into logs or error messages.
async function verifyBackupSnapshot(file, db, root) {
  let ro;
  try {
    ro = await openBackupReadonly(file);
  } catch (err) {
    if (err?.code?.startsWith("ACTIVATION")) throw err;
    fail("ACTIVATION_BACKUP_INVALID", "Backup snapshot unreadable");
  }
  try {
    if (ro.get("PRAGMA quick_check")?.quick_check !== "ok")
      fail("ACTIVATION_BACKUP_INVALID", "Backup failed SQLite integrity check");
    const marker = ro.get("SELECT value FROM _meta WHERE key = 'apiKeysHashedVersion'");
    const kid = ro.get("SELECT value FROM _meta WHERE key = 'apiKeysHashKid'");
    if (marker || kid) fail("ACTIVATION_BACKUP_INVALID", "Backup is not a pre-activation snapshot");
    const columns = ro.all("PRAGMA table_info(apiKeys)").map((c) => c.name);
    if (!columns.includes("key") || columns.includes("keyHash"))
      fail("ACTIVATION_BACKUP_INVALID", "Backup apiKeys schema is not the legacy shape");
    const liveCount = db.get("SELECT COUNT(*) AS c FROM apiKeys")?.c ?? 0;
    if ((ro.get("SELECT COUNT(*) AS c FROM apiKeys")?.c ?? -1) !== liveCount)
      fail("ACTIVATION_BACKUP_INVALID", "Backup apiKeys row count mismatch");
    const hashKey = deriveApiKeyHashKey(root.key);
    const live = db.all("SELECT id, key FROM apiKeys ORDER BY id");
    const backup = ro.all("SELECT id, key FROM apiKeys ORDER BY id");
    for (let i = 0; i < live.length; i++) {
      if (live[i].id !== backup[i].id)
        fail("ACTIVATION_BACKUP_INVALID", "Backup apiKeys id set mismatch");
      if (hashApiKey(live[i].key, hashKey) !== hashApiKey(backup[i].key, hashKey))
        fail("ACTIVATION_BACKUP_INVALID", "Backup apiKeys credential mismatch");
    }
  } catch (err) {
    if (err?.code?.startsWith("ACTIVATION")) throw err;
    fail("ACTIVATION_BACKUP_INVALID", "Backup snapshot unreadable");
  } finally {
    try {
      ro.close();
    } catch {}
  }
}

function flush(db) {
  if (db.driver === "sql.js") {
    if (typeof db.flushSync !== "function")
      fail("ACTIVATION_FLUSH_REQUIRED", "Throwing sql.js flush required");
    db.flushSync();
  } else if (["better-sqlite3", "node:sqlite", "bun:sqlite"].includes(db.driver)) {
    // Native adapters commit to WAL; FULL covers activation durability.
    const row = db.get("PRAGMA wal_checkpoint(FULL)");
    if (row?.busy) fail("ACTIVATION_FLUSH_FAILED", "WAL checkpoint busy");
  } else fail("ACTIVATION_DRIVER_UNSUPPORTED", "Unsupported durability contract");
}

function verifyHashed(db, kid) {
  const state = readApiKeyStorageState(db);
  const columns = db.all("PRAGMA table_info(apiKeys)").map((c) => c.name);
  const required = Object.keys(HASHED_API_KEYS_TABLE.columns);
  if (
    state.storage !== "hashed" ||
    state.hashKid !== kid ||
    columns.length !== required.length ||
    required.some((c) => !columns.includes(c))
  )
    fail("API_KEY_STATE_INVALID", "Hashed marker/schema mismatch");
  const fkViolations = db.all("PRAGMA foreign_key_check");
  if (
    db.get(
      "SELECT 1 AS invalid FROM apiKeys WHERE hashKid != ? OR keyHash IS NULL OR length(keyHash) != 64 OR keyHash GLOB '*[^0-9a-f]*' LIMIT 1",
      [kid],
    ) ||
    fkViolations.length
  )
    fail(
      "API_KEY_STATE_INVALID",
      `Invalid hashed rows or references (${fkViolations.map((v) => v.table).join(", ") || "apiKeys"})`,
    );
  requireGatewayVideoJobsSync(db);
  return state;
}

/**
 * activateGatewayKeys(db, { enabled = false, beforeServing = false,
 *   credentialSinksVetted = false, masterKey = null } = {}) -> Promise<result>
 *
 * Trusted startup-only attestations, NEVER request input. beforeServing means
 * all writers (including timers/other processes) are absent or drained for the
 * whole await; credentialSinksVetted means parent reviewed other raw sinks.
 * Optional masterKey is for isolated fixtures; production omits it and uses
 * loadMasterKey({create: legacy, expectedKid: durableKid}). Hashed restarts
 * never generate a new root, even with feature switch off. Off + pristine
 * legacy makes no master, backup or DB writes. Ambiguous presets always stop.
 * Flush failure throws: marker in memory is NOT readiness; retry must flush
 * again. Caller must hold its readiness latch closed until success. The
 * pre-mutation backup is validated (integrity + legacy shape/marker + ids and
 * keyed digests); a nonempty corrupt or wrong snapshot aborts with zero
 * mutation, and activation backups are exempt from the newest-3 auto-prune.
 */
export function activateGatewayKeys(db, options = {}) {
  // Concurrent callers are rejected, never silently handed the first caller's
  // outcome: a shared promise would let {enabled:false} answer a caller that
  // passed {enabled:true}.
  if (flights.has(db)) fail("ACTIVATION_IN_FLIGHT", "Gateway key activation already in flight");
  // Defer so flight is installed even when all preflight checks are synchronous.
  const promise = Promise.resolve().then(() => activate(db, options));
  flights.set(db, promise);
  return promise.finally(() => flights.delete(db));
}

async function activate(
  db,
  { enabled = false, beforeServing = false, credentialSinksVetted = false, masterKey = null } = {},
) {
  if (typeof enabled !== "boolean") fail("ACTIVATION_OPTIONS_INVALID", "Boolean switch required");
  const pre = readApiKeyStorageState(db);
  if (pre.storage === "legacy" && !enabled) return { status: "skipped-off", isReady: false };
  if (beforeServing !== true || credentialSinksVetted !== true)
    fail("ACTIVATION_STARTUP_REQUIRED", "Quiesced startup and credential-sink review required");
  const defaultWorkspaceId = requireOwnerAndDefault(db);
  const columns = db.all("PRAGMA table_info(apiKeys)").map((c) => c.name);
  if (pre.storage === "legacy" && (!columns.includes("key") || columns.includes("keyHash")))
    fail("API_KEY_STATE_INVALID", "Legacy marker/schema mismatch");
  // YAN-365 D6: on established credential encryption the root identity to
  // load is the CURRENT KEK kid, not the frozen hash kid. The proof below
  // then verifies the KEK kid and unwraps the frozen derived hash key.
  const cred = readCredentialEncryptionState(db);
  const expectedKid = cred.storage === "encrypted" ? cred.kekKid : pre.hashKid;
  const root =
    masterKey === null
      ? await loadMasterKey({ create: pre.storage === "legacy", expectedKid })
      : { key: masterKey, kid: masterKeyId(masterKey) };
  if (pre.storage === "hashed") {
    // Root proof by current KEK + authenticated unwrap (legacy: HKDF master
    // whose kid is the frozen hash kid). Wrong/rotated roots throw here.
    const proof = await getApiKeyHashKey(db, { root });
    if (proof.hashKid !== pre.hashKid)
      fail("API_KEY_STATE_INVALID", "Master does not match durable kid");
    flush(db); // Also retry a prior in-memory commit whose flush failed.
    return { status: "already-hashed", isReady: true, ...verifyHashed(db, pre.hashKid) };
  }
  if (db.driver === "sql.js" && typeof db.flushSync !== "function")
    fail("ACTIVATION_FLUSH_REQUIRED", "Throwing sql.js flush required");
  const backup = protectedBackup(db);
  // Zero-mutation gate: a nonempty but corrupt or wrong backup aborts here,
  // before the synchronous-PRAGMA change and the hash transaction.
  await verifyBackupSnapshot(backup.file, db, root);
  const synchronous = db.get("PRAGMA synchronous").synchronous;
  db.exec("PRAGMA synchronous = FULL");
  try {
    const migration = db.transaction(() => {
      const result = hashGatewayKeysSync(db, {
        masterKey: root.key,
        expectedKid: root.kid,
        defaultWorkspaceId,
        backup: { completed: true, db },
      });
      initGatewayVideoJobsSync(db);
      verifyHashed(db, root.kid);
      return result;
    });
    flush(db);
    return {
      status: "ready",
      isReady: true,
      ...verifyHashed(db, root.kid),
      migration,
      backupDir: backup.dir,
    };
  } finally {
    db.exec(`PRAGMA synchronous = ${synchronous}`);
  }
}
