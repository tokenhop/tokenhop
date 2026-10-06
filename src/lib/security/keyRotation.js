// YAN-365 (task 4.1) crash-safe KEK and workspace-DEK rotation + restart
// recovery. No route/CLI exposure (B6).
//
// KEK rotation (file-managed root): preflight (state, root, every wrap) →
// verified private backup → exclusive stage `keys/master.next` (0600, no
// symlink, fsync file+dirs) → ONE sync non-yielding maintenance section that
// rewraps EVERY DEK plus the preserved derived API-key hash key and latches
// the pending `{oldKid,newKid}` marker in one transaction → durable flush →
// rename stage over master → dir sync → verify → durable pending-clear →
// caches dropped. The DB marker, never the stage file, says whether the
// commit happened. No retired/escrow key is kept (D12).
//
// Env-managed roots refuse FIRST (409 KEK_ENV_MANAGED + guidance, zero stage /
// backup / DB / marker) — D9. Workspace DEK rotation still works under env.
//
// Workspace DEK rotation: ONE sync maintenance transaction re-encrypts only
// the target workspace's rows (connections, nodes, and for Default the five
// D10 settings secrets) under a fresh DEK. Ownership, KEK and the frozen API
// hash key never change.
//
// No `await` and no floating promise sits between the stage write and the
// finalize; everything async (root load, backup verifier) finishes first and
// the section revalidates state, root generation and live rows on entry.
// Imports: B1 codec/state/storage, hash getter, maintenance admission, backup
// helpers and masterKey sync primitives. Never driver/barrel/switch/session.
import {
  CREDENTIAL_FIELD_ALLOWLIST,
  buildAad,
  buildDekWrapAad,
  buildHashKeyWrapAad,
  decryptBytes,
  encryptBytes,
  isEnvelopeShape,
  randomDekKid,
  randomKey,
  zeroBuffer,
} from "./envelope.js";
import { readCredentialEncryptionState } from "../db/credentialEncryptionState.js";
import { readApiKeyStorageState } from "../db/apiKeyState.js";
import { getMetaSync, setMetaSync } from "../db/helpers/metaStore.js";
import { clearCredentialCache, parseCredentialBlob } from "../db/helpers/credentialStorage.js";
import { clearApiKeyHashKeyStateCache, resolveApiKeyHashKeySync } from "./apiKeyHashKey.js";
import {
  assertCredentialOperationAllowed,
  poisonCredentialMaintenance,
  runCredentialMaintenanceSync,
} from "../db/credentialMaintenance.js";
import {
  CREDENTIAL_ENCRYPTION_BACKUP_PREFIX,
  backupDbLite,
  makeProtectedBackupDir,
  prepareProtectedBackupVerifier,
} from "../db/backup.js";
import {
  loadMasterKey,
  masterKeyPaths,
  masterKeyId,
  promoteStagedMasterSync,
  randomMasterKey,
  readMasterKeyFileSync,
  removeStagedMasterSync,
  stageMasterKeySync,
} from "./masterKey.js";

export const MASTER_ENV = "TOKENHOP_MASTER_KEY";
export const KEK_ENV_MANAGED_GUIDANCE =
  "Env-managed roots can't be rotated in-process. Back up the DB plus the current key " +
  "separately. To move to file management, stop the server, provision the same current key " +
  "as 32 raw bytes in DATA_DIR/keys/master (0600 inside 0700 keys/), remove " +
  "TOKENHOP_MASTER_KEY from deployment configuration, restart, and verify the stored KEK " +
  "kid and gateway authentication before rotating. Never generate a different file key for " +
  "this conversion. Alternatively, wait for the approved manual two-key protocol.";

const OWNED_TABLES = ["providerConnections", "providerNodes"];
const PSD_PREFIX = "providerSpecificData.";
const ENVELOPE_KEYS = ["ct", "iv", "kid", "tag", "v"];
const KID_RE = /^[0-9a-f]{16}$/;
// Test-only fixture boundaries: the service returns instead of continuing so
// a child process can SIGKILL itself with exactly that durable state.
const BOUNDARIES = ["staged", "commit-before-rename", "renamed", "finalized"];

function fail(code, message, extra = {}) {
  return Object.assign(new Error(`[key-rotation] ${message}`), { code }, extra);
}

function envManaged(what) {
  return fail("KEK_ENV_MANAGED", `${what} refused. ${KEK_ENV_MANAGED_GUIDANCE}`, { status: 409 });
}

function validRoot(root) {
  return (
    !!root &&
    typeof root.kid === "string" &&
    KID_RE.test(root.kid) &&
    Buffer.isBuffer(root.key) &&
    root.key.length === 32
  );
}

function flushStrict(db) {
  if (db.driver === "sql.js") {
    if (typeof db.flushSync !== "function")
      throw fail("ROTATION_FLUSH_REQUIRED", "Throwing sql.js flush required");
    db.flushSync();
  } else if (["better-sqlite3", "node:sqlite", "bun:sqlite"].includes(db.driver)) {
    // FULL checkpoint folds the committed rewrap into the main file before the
    // file rename can depend on it.
    const row = db.get("PRAGMA wal_checkpoint(FULL)");
    if (row?.busy) throw fail("ROTATION_FLUSH_FAILED", "WAL checkpoint busy");
  } else throw fail("ROTATION_DRIVER_UNSUPPORTED", "Unsupported durability contract");
}

function dropCaches(db) {
  clearCredentialCache(db);
  clearApiKeyHashKeyStateCache(db);
}

function fileMasterSync() {
  const seen = readMasterKeyFileSync("master");
  if (seen.status === "ok") return { kid: seen.kid, key: seen.key };
  if (seen.status === "missing") throw fail("KEY_MISSING", "master key file missing");
  throw fail("KEY_MISSING", `master key file unreadable: ${seen.error?.message ?? seen.error}`);
}

// ─── leaf helpers (same AAD as activation) ─────────────────────────────────

function getLeaf(obj, field) {
  if (field.startsWith(PSD_PREFIX)) {
    const psd = obj.providerSpecificData;
    if (!psd || typeof psd !== "object" || Array.isArray(psd)) return undefined;
    return psd[field.slice(PSD_PREFIX.length)];
  }
  return obj[field];
}

function setLeaf(obj, field, value) {
  if (field.startsWith(PSD_PREFIX)) {
    obj.providerSpecificData = { ...(obj.providerSpecificData || {}) };
    obj.providerSpecificData[field.slice(PSD_PREFIX.length)] = value;
  } else {
    obj[field] = value;
  }
}

function isLookalike(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === ENVELOPE_KEYS.length && keys.every((k, i) => k === ENVELOPE_KEYS[i]);
}

function unwrapDekSync(row, workspaceId, kek) {
  let envelope;
  try {
    envelope = JSON.parse(row.wrappedDek);
  } catch {
    envelope = null;
  }
  if (!isEnvelopeShape(envelope))
    throw fail("ENVELOPE_INVALID", "workspace key is not an envelope");
  let dek;
  try {
    dek = decryptBytes(kek, envelope, buildDekWrapAad(workspaceId, row.kid));
  } catch {
    throw fail("DECRYPT_FAILED", "credential could not be decrypted");
  }
  if (dek.length !== 32) {
    zeroBuffer(dek);
    throw fail("DECRYPT_FAILED", "credential could not be decrypted");
  }
  return dek;
}

// Re-encrypt every covered leaf of `blob` from `oldDek` to `newDek` under the
// row's coordinates. `oldDek === null` means the workspace has no key row: any
// envelope found is a typed KEY_MISSING (never silently dropped).
function reencryptBlob(table, rowId, workspaceId, blob, oldDek, newKid, newDek) {
  let changed = false;
  for (const field of CREDENTIAL_FIELD_ALLOWLIST[table]) {
    const leaf = getLeaf(blob, field);
    if (leaf === undefined || leaf === null) continue;
    const aad = buildAad({ table, rowId, workspaceId, field });
    if (isEnvelopeShape(leaf)) {
      if (!oldDek) throw fail("KEY_MISSING", "workspace key not found");
      let plain;
      try {
        plain = decryptBytes(oldDek, leaf, aad);
      } catch {
        throw fail("DECRYPT_FAILED", "credential could not be decrypted");
      }
      setLeaf(blob, field, encryptBytes(newDek, newKid, plain, aad));
      zeroBuffer(plain);
      changed = true;
      continue;
    }
    if (isLookalike(leaf)) throw fail("ENVELOPE_INVALID", "credential envelope is invalid");
    // Plaintext in encrypted storage is never trusted here; leave it for the
    // runtime PLAINTEXT_REJECTED path rather than silently "fixing" it.
  }
  return changed;
}

// ─── KEK rotation ──────────────────────────────────────────────────────────

// One transaction: authenticate every wrap + the hash key under the current
// KEK, rewrap them under the new KEK, write marker + pending. Runs inside the
// sync maintenance section; revalidates everything it depends on.
function rewrapAll(db, current, newRoot) {
  const state = readCredentialEncryptionState(db);
  if (state.storage !== "encrypted")
    throw fail("ROTATION_NOT_ENCRYPTED", "credential encryption required");
  if (state.pendingRotation) throw fail("ROTATION_IN_FLIGHT", "a key rotation is pending recovery");
  if (state.cleanupPending)
    throw fail("ROTATION_NOT_READY", "pending activation cleanup must finish before rotation");
  if (state.kekKid !== current.kid)
    throw fail("KEY_MISMATCH", "root does not match the credential KEK id");
  if (readApiKeyStorageState(db).storage !== "hashed")
    throw fail("API_KEY_STATE_INVALID", "hashed API key storage required");
  const defaultId = getMetaSync(db, "defaultWorkspaceId", null);
  if (typeof defaultId !== "string" || !defaultId)
    throw fail("ACTIVATION_DEFAULT_WORKSPACE_MISSING", "Established Default workspace required");

  const hash = resolveApiKeyHashKeySync(db, current); // proves KEK + hash unwrap
  const unwrapped = [];
  try {
    for (const row of db.all(
      `SELECT workspaceId, kid, wrappedDek FROM workspaceKeys ORDER BY workspaceId`,
    )) {
      unwrapped.push({
        workspaceId: row.workspaceId,
        kid: row.kid,
        dek: unwrapDekSync(row, row.workspaceId, current.key),
      });
    }
    // Same DEK bytes and DEK kids: only the wraps change, field ciphertext
    // never moves.
    for (const { workspaceId, kid, dek } of unwrapped) {
      const env = encryptBytes(newRoot.key, newRoot.kid, dek, buildDekWrapAad(workspaceId, kid));
      db.run(`UPDATE workspaceKeys SET wrappedDek = ? WHERE workspaceId = ?`, [
        JSON.stringify(env),
        workspaceId,
      ]);
    }
    setMetaSync(
      db,
      "apiKeyHashKeyWrapped",
      JSON.stringify(
        encryptBytes(
          newRoot.key,
          newRoot.kid,
          hash.hashKey,
          buildHashKeyWrapAad(defaultId, hash.hashKid),
        ),
      ),
    );
    setMetaSync(db, "credentialsKekKid", newRoot.kid);
    setMetaSync(
      db,
      "credentialsPendingRotation",
      JSON.stringify({ oldKid: current.kid, newKid: newRoot.kid }),
    );
  } finally {
    for (const { dek } of unwrapped) zeroBuffer(dek);
    zeroBuffer(hash.hashKey);
  }
  return unwrapped.length;
}

function crashed(boundary, oldKid, newKid, extra = {}) {
  return {
    status: boundary === "finalized" ? "crash-finalized" : "crash-pending-rotation",
    isReady: false,
    boundary,
    oldKid,
    newKid,
    ...extra,
  };
}

/**
 * Rotate the KEK.
 * @param {object} db adapter.
 * @param {{ newRoot?: {kid:string,key:Buffer}, root?: {kid:string,key:Buffer}|null,
 *   fileManaged?: boolean, crashAfter?: "staged"|"commit-before-rename"|"renamed"|"finalized"}} [options]
 *   - `newRoot`: defaults to a fresh random 32-byte key (production).
 *   - `root`: explicit current root (fixtures); omitted → read keys/master.
 *   - `fileManaged`: publish through keys/master.next → master. Defaults to
 *     true when `root` is omitted. With an explicit root and `fileManaged:
 *     false` only the DB is rewrapped (no file is touched).
 *   - `crashAfter`: test-only boundary; returns instead of continuing.
 * @returns {Promise<{status:string,isReady:boolean,oldKid:string,newKid:string,deks?:number,backupDir?:string}>}
 * @throws KEK_ENV_MANAGED (status 409) FIRST when TOKENHOP_MASTER_KEY is set.
 */
export async function rotateKek(
  db,
  { newRoot = null, root = null, fileManaged = undefined, crashAfter = undefined } = {},
) {
  // D9 FIRST: before options, state, staging, backup, DB or marker.
  if (process.env[MASTER_ENV] !== undefined) throw envManaged("Automatic KEK rotation");
  assertCredentialOperationAllowed(db);
  if (crashAfter !== undefined && !BOUNDARIES.includes(crashAfter))
    throw fail("ROTATION_OPTIONS_INVALID", "unknown crash boundary");
  if (root !== null && !validRoot(root)) throw fail("ROOT_INVALID", "root {kid,key} invalid");
  const publishFile = fileManaged ?? root === null;
  if (publishFile === false && root === null)
    throw fail("ROOT_INVALID", "an explicit root is required without file management");
  let next = newRoot;
  if (next === null) {
    const key = randomMasterKey();
    next = { kid: masterKeyId(key), key };
  }
  if (!validRoot(next)) throw fail("ROOT_INVALID", "newRoot {kid,key} invalid");

  const state = readCredentialEncryptionState(db);
  if (state.storage !== "encrypted")
    throw fail("ROTATION_NOT_ENCRYPTED", "credential encryption required");
  if (state.pendingRotation) throw fail("ROTATION_IN_FLIGHT", "a key rotation is pending recovery");
  if (state.cleanupPending)
    throw fail("ROTATION_NOT_READY", "pending activation cleanup must finish before rotation");
  if (next.kid === state.kekKid)
    throw fail("ROTATION_OPTIONS_INVALID", "new root must differ from the current KEK");

  // Preflight (async work finishes here; the section below revalidates).
  const current = publishFile ? fileMasterSync() : root;
  if (current.kid !== state.kekKid)
    throw fail("KEY_MISMATCH", "root does not match the credential KEK id");
  // An explicit root must be the file master byte-for-byte, not just by kid.
  if (publishFile && root !== null && !root.key.equals(current.key))
    throw fail("KEY_MISMATCH", "master file does not match the explicit root");
  zeroBuffer(resolveApiKeyHashKeySync(db, current).hashKey);
  const verifyBackup = await prepareProtectedBackupVerifier();
  const backupDir = makeProtectedBackupDir(CREDENTIAL_ENCRYPTION_BACKUP_PREFIX);
  const backupFile = backupDbLite(db, backupDir);
  verifyBackup(backupDir, backupFile);

  // ── sync, non-yielding critical section from here to finalize ──────────
  if (publishFile) {
    try {
      stageMasterKeySync(next.key);
    } catch (err) {
      // EEXIST: another/leftover rotation owns the stage — never overwrite.
      if (err?.code === "EEXIST")
        throw fail("ROTATION_IN_FLIGHT", "a key rotation stage already exists");
      // Partial stage we may have created: unreferenced by any DB state.
      try {
        removeStagedMasterSync();
      } catch {}
      throw err;
    }
    if (crashAfter === "staged") return crashed("staged", current.kid, next.kid, { backupDir });
  }

  let deks;
  try {
    deks = runCredentialMaintenanceSync(db, () => {
      // Revalidate the root GENERATION inside the section: a file loaded
      // before awaits must not become the accepted root if it changed.
      const live = publishFile ? fileMasterSync() : current;
      if (live.kid !== current.kid || !live.key.equals(current.key))
        throw fail("KEY_MISMATCH", "root changed during rotation");
      return db.transaction(() => rewrapAll(db, live, next));
    });
  } catch (err) {
    // Rolled back: the marker never landed, so the stage names nothing.
    if (publishFile && getMetaSync(db, "credentialsPendingRotation", null) === null) {
      try {
        removeStagedMasterSync();
      } catch (cleanupErr) {
        poisonCredentialMaintenance(db, cleanupErr);
      }
    }
    throw err;
  }

  try {
    flushStrict(db); // durable commit before any file publication
  } catch (err) {
    // Uncertain commit: the marker may be durable. Keep the stage, stop
    // serving credential writes until a restart recovers from the DB marker.
    poisonCredentialMaintenance(db, err);
    throw err;
  }
  if (crashAfter === "commit-before-rename")
    return crashed("commit-before-rename", current.kid, next.kid, { backupDir });

  try {
    if (publishFile) {
      promoteStagedMasterSync();
      if (crashAfter === "renamed") return crashed("renamed", current.kid, next.kid, { backupDir });
      if (fileMasterSync().kid !== next.kid)
        throw fail("KEY_MISMATCH", "published master does not match the rotated KEK");
    }
    runCredentialMaintenanceSync(db, () =>
      db.transaction(() => db.run(`DELETE FROM _meta WHERE key = 'credentialsPendingRotation'`)),
    );
    flushStrict(db);
  } catch (err) {
    poisonCredentialMaintenance(db, err);
    throw err;
  }
  if (crashAfter === "finalized") return crashed("finalized", current.kid, next.kid, { backupDir });

  dropCaches(db);
  // Reload proof: the published root, read fresh, unwraps the rotated state.
  zeroBuffer(resolveApiKeyHashKeySync(db, publishFile ? fileMasterSync() : next).hashKey);
  return { status: "ready", isReady: true, oldKid: current.kid, newKid: next.kid, deks, backupDir };
}

/**
 * Restart recovery. DB marker first; the stage file alone never says the
 * commit happened.
 *  - No marker, stage present: pre-commit leftover → delete it (unreferenced).
 *  - Marker + stage: stage must be exactly newKid and unwrap EVERY pending
 *    wrap; only then rename over master, verify, durably clear pending.
 *  - Marker, no stage, master == newKid: rename already done → finalize.
 *  - Marker, no stage, master == oldKid / other / missing: the new key is
 *    gone → poison, retain everything, never invent a root.
 *  - Env root set while a pending file rotation exists: fail closed (D9).
 * Any uncertain failure poisons admission and retains stage + master.
 * @returns {Promise<{status:"ready",isReady:true,oldKid?:string,newKid?:string}>}
 */
export async function recoverKeyRotation(db) {
  const state = readCredentialEncryptionState(db);
  if (state.storage !== "encrypted")
    throw fail("ROTATION_NOT_ENCRYPTED", "credential encryption required");
  // Validation failures (corrupt size, loose mode, symlink, bad keys dir) throw
  // from the reader; fs errors come back as status "error". Both become one
  // actionable failure that names the fixed stage path. Never auto-deletes.
  let staged;
  let stageProblem = null;
  try {
    staged = readMasterKeyFileSync("stage");
    if (staged.status === "error") stageProblem = staged.error;
  } catch (cause) {
    stageProblem = cause;
  }
  if (stageProblem) {
    const stagePath = masterKeyPaths().stage;
    const err = fail(
      "KEY_MISSING",
      `staged master ${stagePath} unreadable: ${stageProblem?.message ?? stageProblem}. ` +
        (state.pendingRotation
          ? "Resolve the stage (restore its bytes, or delete it only after proving the master already matches the pending new kid), then restart."
          : "No rotation is pending, so it is an unreferenced leftover; inspect it and delete it by hand once verified."),
    );
    if (state.pendingRotation) poisonCredentialMaintenance(db, err);
    throw err;
  }
  if (!state.pendingRotation) {
    if (staged.status === "ok") removeStagedMasterSync();
    return { status: "ready", isReady: true };
  }

  const { oldKid, newKid } = state.pendingRotation;
  if (process.env[MASTER_ENV] !== undefined) {
    const err = envManaged("Pending file key rotation recovery");
    poisonCredentialMaintenance(db, err);
    throw err;
  }
  try {
    if (staged.status === "ok") {
      if (staged.kid !== newKid)
        throw fail("KEY_MISMATCH", "staged master does not match the pending rotation");
      // Proof before promotion: every DEK wrap and the hash key authenticate
      // under the staged key.
      const proof = resolveApiKeyHashKeySync(db, { kid: staged.kid, key: staged.key });
      zeroBuffer(proof.hashKey);
      for (const row of db.all(`SELECT workspaceId, kid, wrappedDek FROM workspaceKeys`)) {
        zeroBuffer(unwrapDekSync(row, row.workspaceId, staged.key));
      }
      promoteStagedMasterSync();
    } else {
      const master = fileMasterSync(); // missing → KEY_MISSING (poison below)
      if (master.kid !== newKid) {
        throw fail(
          master.kid === oldKid ? "KEY_MISSING" : "KEY_MISMATCH",
          "pending rotation has no staged key and the master is not the new key: " +
            "restore the verified pre-rotation backup with its master",
        );
      }
    }
    const published = fileMasterSync();
    if (published.kid !== newKid)
      throw fail("KEY_MISMATCH", "master file does not match the rotated KEK");
    const proof = resolveApiKeyHashKeySync(db, published);
    zeroBuffer(proof.hashKey);
    runCredentialMaintenanceSync(db, () =>
      db.transaction(() => db.run(`DELETE FROM _meta WHERE key = 'credentialsPendingRotation'`)),
    );
    flushStrict(db);
  } catch (err) {
    poisonCredentialMaintenance(db, err);
    throw err;
  }
  dropCaches(db);
  return { status: "ready", isReady: true, oldKid, newKid };
}

// ─── workspace DEK rotation ────────────────────────────────────────────────

/**
 * Re-encrypt ONLY the target workspace under a fresh DEK (connections, nodes,
 * and for the Default workspace the five D10 settings secrets) in one sync
 * maintenance transaction. Works under an env-managed KEK. A workspace with
 * no key row and no envelopes is a no-op (`status:"noop"`).
 * @param {object} db adapter.
 * @param {string} workspaceId
 * @param {{root?: {kid:string,key:Buffer}|null}} [options] explicit fixture
 *   root; otherwise the root is loaded fresh per call (env or file).
 * @returns {Promise<{status:"ready"|"noop",isReady:true,workspaceId:string,dekKid:string|null,oldDekKid:string|null,rotated:number}>}
 */
export async function rotateWorkspaceDek(db, workspaceId, { root = null } = {}) {
  assertCredentialOperationAllowed(db);
  if (typeof workspaceId !== "string" || !workspaceId)
    throw fail("ROTATION_OPTIONS_INVALID", "workspace id required");
  if (root !== null && !validRoot(root)) throw fail("ROOT_INVALID", "root {kid,key} invalid");
  const state = readCredentialEncryptionState(db);
  if (state.storage !== "encrypted")
    throw fail("ROTATION_NOT_ENCRYPTED", "credential encryption required");
  // Async root load first; the section revalidates against the live marker.
  const loaded = root ?? (await loadMasterKey({ expectedKid: state.kekKid }));
  if (loaded.kid !== state.kekKid)
    throw fail("KEY_MISMATCH", "root does not match the credential KEK id");

  // Rolled-back failures commit nothing and need no poison; flush below is
  // the only uncertain step.
  const result = runCredentialMaintenanceSync(db, () =>
    db.transaction(() => {
      const live = readCredentialEncryptionState(db);
      if (live.storage !== "encrypted" || live.kekKid !== loaded.kid)
        throw fail("KEY_MISMATCH", "root does not match the credential KEK id");
      if (live.pendingRotation)
        throw fail("ROTATION_IN_FLIGHT", "a key rotation is pending recovery");
      if (live.cleanupPending)
        throw fail("ROTATION_NOT_READY", "pending activation cleanup must finish before rotation");
      if (!db.get(`SELECT id FROM workspaces WHERE id = ?`, [workspaceId]))
        throw fail("ROTATION_WORKSPACE_MISSING", "workspace not found");
      const defaultId = getMetaSync(db, "defaultWorkspaceId", null);
      const keyRow = db.get(`SELECT kid, wrappedDek FROM workspaceKeys WHERE workspaceId = ?`, [
        workspaceId,
      ]);
      const oldDek = keyRow ? unwrapDekSync(keyRow, workspaceId, loaded.key) : null;
      const newDek = randomKey();
      const newKid = randomDekKid();
      try {
        const targets = [];
        for (const table of OWNED_TABLES) {
          for (const row of db.all(`SELECT id, data FROM ${table} WHERE workspaceId = ?`, [
            workspaceId,
          ])) {
            targets.push({ table, rowId: row.id, data: row.data, column: "id" });
          }
        }
        if (workspaceId === defaultId) {
          const s = db.get(`SELECT data FROM settings WHERE id = 1`);
          if (s) targets.push({ table: "settings", rowId: "1", data: s.data, column: "id" });
        }
        let rotated = 0;
        const writes = [];
        for (const t of targets) {
          const blob = parseCredentialBlob(t.data);
          if (reencryptBlob(t.table, t.rowId, workspaceId, blob, oldDek, newKid, newDek)) {
            writes.push({ ...t, blob });
            rotated += 1;
          }
        }
        if (!keyRow || rotated === 0) {
          // Nothing encrypted to rotate: no key churn, no write.
          return {
            status: "noop",
            dekKid: keyRow?.kid ?? null,
            oldDekKid: keyRow?.kid ?? null,
            rotated: 0,
          };
        }
        db.run(`UPDATE workspaceKeys SET kid = ?, wrappedDek = ? WHERE workspaceId = ?`, [
          newKid,
          JSON.stringify(
            encryptBytes(loaded.key, loaded.kid, newDek, buildDekWrapAad(workspaceId, newKid)),
          ),
          workspaceId,
        ]);
        for (const w of writes) {
          db.run(
            w.table === "settings"
              ? `UPDATE settings SET data = ? WHERE id = 1`
              : `UPDATE ${w.table} SET data = ? WHERE id = ?`,
            w.table === "settings" ? [JSON.stringify(w.blob)] : [JSON.stringify(w.blob), w.rowId],
          );
        }
        return { status: "ready", dekKid: newKid, oldDekKid: keyRow.kid, rotated };
      } finally {
        zeroBuffer(newDek);
        if (oldDek) zeroBuffer(oldDek);
      }
    }),
  );
  if (result.status === "ready") {
    try {
      flushStrict(db);
    } catch (err) {
      poisonCredentialMaintenance(db, err);
      throw err;
    }
  }
  clearCredentialCache(db, workspaceId);
  return { isReady: true, workspaceId, ...result };
}
