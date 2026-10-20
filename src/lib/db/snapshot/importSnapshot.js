// Whole-instance import: validation, root proof, preflight, pre-import backup
// and the destructive apply. Moved from the db barrel; error codes unchanged.
import { getAdapter } from "../driver.js";
import { parseSnapshotValue, createSnapshotSplitter } from "@/shared/utils/snapshotJsonSplitter.js";
import { MAX_SNAPSHOT_ROW_BYTES } from "./limits.js";
import { INSTANCE_SNAPSHOT_SECTION_NAMES } from "../helpers/instanceSnapshotTables.js";
import { makeStagingDir, removeStagingDir } from "../stagingFiles.js";
import { openStage } from "./importStage.js";
import { latestVersion } from "../migrations/index.js";
import { readCredentialEncryptionState } from "../credentialEncryptionState.js";
import { isCredentialMaintenancePoisoned } from "../credentialMaintenance.js";
import { getMetaSync } from "../helpers/metaStore.js";
import { assertInstanceUsersMatch } from "../helpers/instanceUserDiff.js";
import { unlockInstancePortable } from "../helpers/instancePortable.js";
import { preflightLegacyEncryptedImport } from "../helpers/legacyEncryptedImport.js";
import {
  TransferError,
  applyGatewayKeySnapshot,
  gatewayKeyStorageSnapshot,
  preflightGatewayKeyImport,
} from "../helpers/gatewayKeyTransfer.js";
import {
  PRE_IMPORT_BACKUP_PREFIX,
  backupDbLite,
  makeProtectedBackupDir,
  prepareProtectedBackupVerifier,
  removeUnverifiedBackupDir,
} from "../backup.js";
import { assertImportDiskSpace } from "../diskPreflight.js";
import {
  assertEncryptedImportAllowed,
  commitDurably,
  prepareTransferCacheInvalidation,
} from "./importCommit.js";
import { applyLegacySnapshotSync } from "./legacyApply.js";
import { withInstanceImportLock } from "./transferLock.js";

const STRIP_KEYS = ["password", "ssoProof", "passphrase", "force"];
const STAGE_BATCH_ROWS = 500;
const STAGE_BATCH_BYTES = 4 * 1024 * 1024;
// A client that stops sending must not pin the import lock and its staging disk.
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

function assertSnapshotObject(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid database payload");
  }
}

function assertSchemaGate(payload) {
  // Exports before YAN-352 carry no schemaVersion; they are the v1.0.0 shape.
  const { schemaVersion } = payload;
  if (schemaVersion !== undefined) {
    if (!Number.isInteger(schemaVersion) || schemaVersion < 0) {
      throw new Error("Invalid database payload: bad schemaVersion");
    }
    if (schemaVersion > latestVersion()) {
      throw new Error(
        `Backup is from a newer version (schema ${schemaVersion}, this install reads up to ${latestVersion()}). Upgrade before importing.`,
      );
    }
  }
}

/**
 * Import core: `head` is the snapshot WITHOUT its staged instance sections
 * (those live in `stage`). Everything past the schema gate is the former
 * importDb order, with `stage` threaded into preflight.
 */
async function importStaged(
  payload,
  stage,
  { masterKey = null, force = false, actor = null, passphrase, returnSnapshot = false } = {},
) {
  assertSnapshotObject(payload);
  assertSchemaGate(payload);
  const db = await getAdapter();
  // YAN-365: on established credential encryption a payload without a v3
  // credential section is a plaintext/legacy restore — it would write
  // covered secrets unencrypted and drop workspaceId. Reject before the root
  // proof, backup or wipe (B5 adds the v3 path). A malformed marker fails
  // closed the same way.
  const legacyEncrypted = await assertEncryptedImportAllowed(db, payload);

  // YAN-363: trusted root loader. Callers (HTTP route) never supply raw key
  // material; the master comes only from env/file via the crypto module when
  // the instance actually needs root proof. An explicit masterKey argument
  // overrides (tests/backup flows); never from the request body.
  let resolvedMaster = masterKey;
  if (resolvedMaster === null || resolvedMaster === undefined) {
    const instanceHint = gatewayKeyStorageSnapshot(db);
    if (instanceHint.storage === "hashed") {
      try {
        const { loadMasterKey } = await import("@/lib/security/masterKey.js");
        // Path 7: the trusted root must be the one the current state demands —
        // the frozen hash kid before encryption, the CURRENT KEK kid after
        // (a rotated KEK never equals the frozen hash kid). Hash proof itself
        // is the authenticated unwrap in preflight, never kid rederivation.
        const cred = readCredentialEncryptionState(db);
        const expectedKid = cred.storage === "encrypted" ? cred.kekKid : instanceHint.hashKid;
        const { key, kid } = await loadMasterKey();
        if (kid !== expectedKid) {
          throw new TransferError(
            "TRANSFER_ROOT_MISMATCH",
            "Trusted master key does not match this instance's root",
          );
        }
        resolvedMaster = key;
      } catch (error) {
        if (error instanceof TransferError) throw error;
        throw Object.assign(new Error(`Cannot prove instance root: ${error?.message ?? error}`), {
          code: "TRANSFER_MASTER_REQUIRED",
        });
      }
    }
  }

  // YAN-363: pure preflight BEFORE any destructive work. Validates snapshot
  // format, master/root/kid consistency (wrong root fails here, with zero
  // mutation), and full ownership/reference integrity of every row. Importing
  // into hashed storage additionally requires the separately supplied master
  // (approved Q4) and converts legacy plaintext keys to hashed rows — no raw
  // key is ever written to a hashed instance.
  const { isMultiUserEnabled } = await import("@/lib/users/featureSwitch.js");
  const multiUserTransfer = await isMultiUserEnabled();
  let allowPortableHashAdoption = false;
  if (payload.credentialEncryption?.portable !== undefined) {
    if (!multiUserTransfer) {
      throw new TransferError("TRANSFER_FORMAT_INVALID", "Portable restores require Users & teams");
    }
    if (passphrase === undefined || !resolvedMaster) {
      throw new TransferError("TRANSFER_PASSPHRASE_REQUIRED", "This backup needs its passphrase");
    }
    payload = await unlockInstancePortable(payload, { passphrase, masterKey: resolvedMaster });
    // Trusted local proof, never read from the import document or HTTP body.
    allowPortableHashAdoption = true;
  }
  const instance = gatewayKeyStorageSnapshot(db);
  const plan = legacyEncrypted
    ? preflightLegacyEncryptedImport(payload, { instance, db, masterKey: resolvedMaster })
    : preflightGatewayKeyImport(payload, {
        instance,
        db,
        masterKey: resolvedMaster,
        defaultWorkspaceId: getMetaSync(db, "defaultWorkspaceId"),
        allowPortableHashAdoption,
        multiUserTransfer,
        stage,
      });
  // YAN-375: validate shape before diffing identities; refuse replacements
  // before backups/mutations unless the authenticated owner forces them.
  if (multiUserTransfer) assertInstanceUsersMatch(db, payload, { force, actor });
  // Capture the live state preflight proved, BEFORE any async preparation.
  // A rotation can commit while imports below yield; re-prove generation as
  // the FIRST statement of either destructive transaction, or apply nothing.
  const provedState = readCredentialEncryptionState(db);
  const assertStateCurrent = () => {
    const live = readCredentialEncryptionState(db);
    if (
      isCredentialMaintenancePoisoned(db) ||
      live.storage !== provedState.storage ||
      live.kekKid !== provedState.kekKid ||
      live.cleanupPending !== provedState.cleanupPending ||
      JSON.stringify(live.pendingRotation) !== JSON.stringify(provedState.pendingRotation)
    ) {
      throw new TransferError(
        "TRANSFER_STATE_CHANGED",
        "Credential state changed during import; retry",
      );
    }
  };

  const invalidateCaches = await prepareTransferCacheInvalidation(db);

  // sql.js init completes here, BEFORE the snapshot: the returned verifier is
  // sync, so snapshot -> verify -> destructive transaction never yields. No
  // await may separate the backup below from either destructive transaction.
  const verifyBackup = await prepareProtectedBackupVerifier(db);

  // Disk preflight stays inside the no-await window (synchronous).
  assertImportDiskSpace({ phase: "backup", stageBytes: stage.size() });

  // Pre-import backup AFTER all validation above (shape, root, preflight):
  // a recoverable private pre-import-* snapshot before either destructive
  // transaction. Backup failure aborts with zero mutation.
  let preImportDir;
  try {
    preImportDir = makeProtectedBackupDir(PRE_IMPORT_BACKUP_PREFIX);
    const preImportFile = backupDbLite(db, preImportDir, "data.sqlite", true);
    verifyBackup(preImportDir, preImportFile);
  } catch (error) {
    removeUnverifiedBackupDir(preImportDir);
    throw Object.assign(
      new Error(`[db-import] pre-import backup failed: ${error?.message ?? error}`),
      { code: "IMPORT_BACKUP_FAILED" },
    );
  }

  if (plan.format === "hashed") {
    db.transaction(() => {
      assertStateCurrent();
      applyGatewayKeySnapshot(db, payload, plan);
    });
  } else {
    db.transaction(() => {
      assertStateCurrent();
      applyLegacySnapshotSync(db, payload, { legacyEncrypted, resolvedMaster, plan, instance });
    });
  }

  commitDurably(db, invalidateCaches);
  if (!returnSnapshot) return undefined;
  const { exportDb } = await import("./exportSnapshot.js");
  return await exportDb();
}

const tooLarge = (maxBytes) =>
  Object.assign(new Error(`Import body exceeds ${maxBytes} bytes`), {
    code: "IMPORT_PAYLOAD_TOO_LARGE",
  });

function jsonInvalid(error) {
  if (error?.code !== "SNAPSHOT_JSON_INVALID") return error;
  return new TransferError("IMPORT_JSON_INVALID", error.message);
}

async function withStage(opts, run) {
  const db = await getAdapter();
  const dir = makeStagingDir("import-");
  let stage = null;
  try {
    stage = await openStage(db, dir);
    stage.onProgress = opts.__onProgress ?? null;
    return await run(stage);
  } finally {
    // After commit/rollback: DETACH is illegal inside a transaction.
    stage?.close();
    removeStagingDir(dir);
  }
}

function importDbUnlocked(payload, opts) {
  assertSnapshotObject(payload);
  assertSchemaGate(payload);
  return withStage(opts, async (stage) => {
    const head = { ...payload };
    for (const name of INSTANCE_SNAPSHOT_SECTION_NAMES) {
      // A non-array stays in the head so preflight fails it with a typed error.
      if (Array.isArray(head[name])) {
        stage.stageArray(name, head[name]);
        delete head[name];
      }
    }
    return importStaged(head, stage, opts);
  });
}

// Uniform pull/cancel view over every accepted body shape: a web
// ReadableStream (reader), an async iterable (Node stream, async generator), a
// sync iterable (array of chunks) or a single binary chunk. `cancel()` is
// best-effort, never awaited by callers and never throws: it must not mask the
// error that ended the import.
function openSource(body) {
  if (body === null || body === undefined) body = [];
  else if (ArrayBuffer.isView(body) || typeof body === "string") body = [body];
  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    return {
      next: () => reader.read(),
      cancel() {
        try {
          reader.cancel().catch(() => {});
        } catch {}
      },
    };
  }
  const factory = body[Symbol.asyncIterator] ?? body[Symbol.iterator];
  if (typeof factory !== "function") {
    throw new TypeError("Import body must be a stream or an iterable of chunks");
  }
  const iterator = factory.call(body);
  return {
    next: () => iterator.next(),
    cancel() {
      try {
        Promise.resolve(iterator.return?.()).catch(() => {});
      } catch {}
    },
  };
}

// Next chunk of `source`, or an "Upload was incomplete" error when none
// arrives within `idleMs` (the caller then cancels the stalled source).
async function nextChunk(source, idleMs) {
  if (!(idleMs > 0)) return source.next();
  let timer;
  const stalled = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new TransferError("TRANSFER_FORMAT_INVALID", "Upload was incomplete")),
      idleMs,
    );
  });
  try {
    return await Promise.race([source.next(), stalled]);
  } finally {
    clearTimeout(timer);
  }
}

async function feedStream(
  body,
  stage,
  { maxBytes, declaredBytes, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS },
) {
  const head = {};
  const sections = new Set(INSTANCE_SNAPSHOT_SECTION_NAMES);
  let batch = [];
  let batchBytes = 0;
  let current = null;
  const flush = () => {
    if (current && batch.length) stage.stageRows(current, batch);
    batch = [];
    batchBytes = 0;
  };
  const splitter = createSnapshotSplitter({
    streamedArrays: sections,
    maxElementBytes: MAX_SNAPSHOT_ROW_BYTES,
    onValue(key, bytes) {
      const value = parseSnapshotValue(bytes);
      // Reject a newer-schema file as soon as its version is seen, before the
      // (possibly huge) rest of the upload is staged. Same gate and message.
      if (key === "schemaVersion") assertSchemaGate({ schemaVersion: value });
      // defineProperty: a "__proto__" key must stay an own data property.
      Object.defineProperty(head, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    },
    onArrayStart(key) {
      current = key;
      stage.stageRows(key, []); // marks own-present, so [] clears
    },
    onElement(_key, bytes) {
      batch.push(parseSnapshotValue(bytes));
      batchBytes += bytes.length;
      if (batch.length >= STAGE_BATCH_ROWS || batchBytes >= STAGE_BATCH_BYTES) flush();
    },
    onArrayEnd() {
      flush();
      current = null;
    },
  });
  const encoder = new TextEncoder();
  let total = 0;
  let source = null;
  let clean = false;
  try {
    source = openSource(body);
    for (;;) {
      const { done, value: chunk } = await nextChunk(source, idleTimeoutMs);
      if (done) break;
      const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
      total += bytes.length;
      if (maxBytes != null && total > maxBytes) throw tooLarge(maxBytes);
      if (declaredBytes != null && total > declaredBytes) {
        throw new TransferError("TRANSFER_FORMAT_INVALID", "Upload was incomplete");
      }
      splitter.write(bytes);
    }
    if (declaredBytes != null && total !== declaredBytes) {
      throw new TransferError("TRANSFER_FORMAT_INVALID", "Upload was incomplete");
    }
    splitter.end();
    clean = true;
  } catch (error) {
    throw jsonInvalid(error);
  } finally {
    // Any non-clean exit (too large, invalid JSON, schema gate, staging error,
    // stall, source error) must release the request body, not leave it open.
    if (!clean) source?.cancel();
  }
  return head;
}

async function importStreamUnlocked(body, opts) {
  const { maxBytes, declaredBytes, idleTimeoutMs, transformHead, stripKeys = STRIP_KEYS } = opts;
  // Before any byte is staged: fail with zero side effects when the disk is short.
  assertImportDiskSpace({ phase: "staging", incomingBytes: declaredBytes ?? maxBytes ?? 0 });
  return withStage(opts, async (stage) => {
    let head = await feedStream(body, stage, {
      maxBytes,
      declaredBytes,
      ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
    });
    // An uploaded file never carries request control (auth/force).
    for (const key of stripKeys) delete head[key];
    if (typeof transformHead === "function") head = transformHead(head) ?? head;
    return importStaged(head, stage, opts);
  });
}

/**
 * Replace the instance with `payload`. Resolves `undefined`; tests may pass
 * `{ returnSnapshot: true }` to receive the post-import export instead.
 */
export function importDb(payload, opts = {}) {
  return withInstanceImportLock(() => importDbUnlocked(payload, opts));
}

/**
 * Replace the instance from a raw snapshot byte stream (async iterable of
 * Uint8Array). Rows go straight into the staging DB; the heap holds only the
 * head and one batch. Options: maxBytes, declaredBytes, transformHead,
 * stripKeys, idleTimeoutMs (per-chunk stall limit, default 60 s; 0 = off),
 * __onProgress plus the importDb options.
 */
export function importDbStream(body, opts = {}) {
  return withInstanceImportLock(() => importStreamUnlocked(body, opts));
}
