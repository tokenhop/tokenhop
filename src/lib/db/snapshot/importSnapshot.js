// Whole-instance import: validation, root proof, preflight, pre-import backup
// and the destructive apply. Moved from the db barrel; error codes unchanged.
import { getAdapter } from "../driver.js";
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

async function importDbUnlocked(
  payload,
  { masterKey = null, force = false, actor = null, passphrase, returnSnapshot = false } = {},
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid database payload");
  }
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
  assertImportDiskSpace({ phase: "backup", stageBytes: 0 });

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
  const { exportDb } = await import("../index.js");
  return await exportDb();
}

/**
 * Replace the instance with `payload`. Resolves `undefined`; tests may pass
 * `{ returnSnapshot: true }` to receive the post-import export instead.
 */
export function importDb(payload, opts = {}) {
  return withInstanceImportLock(() => importDbUnlocked(payload, opts));
}
