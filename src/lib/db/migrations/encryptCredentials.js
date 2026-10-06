// YAN-365 (task 3.1): the pure synchronous first-activation worker. NOT a
// registered schema migration — activateCredentialEncryption.js owns async
// preparation (root, verified private backup, legacy MITM helper) and runs
// this inside ONE non-yielding transaction. No await anywhere.
//
// Order inside the transaction (D1/D4/D6/D11):
//   adopt ownerless rows into Default → per-workspace DEKs on demand →
//   encrypt every D10 leaf (existing envelopes are authenticated, never
//   re-encrypted) → strict legacy MITM re-key (typed abort, never null) →
//   wrap the DERIVED API-key hash key under the KEK → latch the durable
//   marker pair + cleanup-pending.
import {
  CREDENTIAL_FIELD_ALLOWLIST,
  buildAad,
  buildHashKeyWrapAad,
  decryptBytes,
  encryptBytes,
  isEnvelopeShape,
  zeroBuffer,
} from "../../security/envelope.js";
import {
  createMigrationContext,
  decodeCredentialRowSync,
  ensureWorkspaceDekSync,
  parseCredentialBlob,
  prepareCredentialContext,
} from "../helpers/credentialStorage.js";
import { deriveApiKeyHashKey } from "../../security/masterKey.js";

const OWNED_TABLES = ["providerConnections", "providerNodes"];
const KID_RE = /^[0-9a-f]{16}$/;
const PSD_PREFIX = "providerSpecificData.";
const ENVELOPE_KEYS = ["ct", "iv", "kid", "tag", "v"];
// The legacy MITM machine cipher is ivHex:tagHex:ctHex (manager.js format).
const LEGACY_MITM_RE = /^[0-9a-fA-F]+:[0-9a-fA-F]+:[0-9a-fA-F]+$/;

function fail(code, message) {
  throw Object.assign(new Error(`[credential-activation] ${message}`), { code });
}

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

function defaultWorkspaceId(db) {
  return db.get(`SELECT value FROM _meta WHERE key = 'defaultWorkspaceId'`)?.value ?? null;
}

function setMeta(db, key, value) {
  db.run(
    `INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, String(value)],
  );
}

// D1: a NULL workspaceId cannot be encrypted — adoption happens first.
function adoptOwnerless(db, defaultId) {
  const owner = db.get(`SELECT id FROM users WHERE instanceRole = 'owner'`)?.id ?? null;
  let adopted = 0;
  for (const table of OWNED_TABLES) {
    adopted += db.run(
      `UPDATE ${table} SET workspaceId = ?, createdByUserId = COALESCE(createdByUserId, ?) WHERE workspaceId IS NULL`,
      [defaultId, owner],
    ).changes;
  }
  return adopted;
}

// D11: strict one-time legacy machine-cipher decrypt. A value in the legacy
// hex-triple shape MUST decrypt; failure aborts typed with operator guidance
// and never silently nulls or clears the secret. Non-legacy plaintext is left
// for the normal encryption pass below.
function rekeyLegacyMitm(blob, legacyDecrypt) {
  const value = blob.mitmSudoEncrypted;
  if (typeof value !== "string" || value.length === 0 || isEnvelopeShape(value)) return false;
  if (!LEGACY_MITM_RE.test(value)) return false;
  if (typeof legacyDecrypt !== "function")
    fail("MITM_LEGACY_INVALID", "legacy MITM helper unavailable");
  const plain = legacyDecrypt(value);
  if (typeof plain !== "string" || plain.length === 0) {
    fail(
      "MITM_LEGACY_INVALID",
      "legacy MITM sudo secret could not be decrypted; re-enter or clear it, then retry",
    );
  }
  blob.mitmSudoEncrypted = plain;
  return true;
}

// Encrypt every covered leaf of one row under its workspace DEK. Existing
// envelopes are authenticated against the row's coordinates and left
// byte-identical (activation rerun safety). Empty/null/absent semantics are
// preserved; non-secret leaves never move.
function encryptLeaves(db, ctx, table, row, blob, workspaceId) {
  let changed = false;
  for (const field of CREDENTIAL_FIELD_ALLOWLIST[table]) {
    const leaf = getLeaf(blob, field);
    if (leaf === undefined || leaf === null) continue;
    const aad = buildAad({
      table,
      rowId: table === "settings" ? "1" : row.id,
      workspaceId,
      field,
    });
    if (isEnvelopeShape(leaf)) {
      const dek = ensureWorkspaceDekSync(db, workspaceId, ctx);
      zeroBuffer(decryptBytes(dek.dek, leaf, aad)); // authenticate only
      continue;
    }
    if (isLookalike(leaf)) fail("ENVELOPE_INVALID", "credential envelope is invalid");
    if (typeof leaf !== "string" || leaf.length === 0) continue;
    if (typeof workspaceId !== "string" || !workspaceId)
      fail("DATA_CORRUPT", "cannot encrypt a row without a workspace");
    const dek = ensureWorkspaceDekSync(db, workspaceId, ctx);
    setLeaf(blob, field, encryptBytes(dek.dek, dek.kid, Buffer.from(leaf, "utf8"), aad));
    changed = true;
  }
  return changed;
}

/**
 * The first irreversible activation transaction. Caller owns the verified
 * pre-mutation backup and the sync critical section. Returns per-table
 * mutation counts; never resolves a promise.
 * @param {object} db adapter (sync API) inside the caller's transaction.
 * @param {{kid:string,key:Buffer}} root master key (KEK) whose kid is the frozen hash kid.
 * @param {{legacyDecrypt?: (stored: string) => string | null}} [opts]
 */
export function encryptCredentialsInTransaction(db, root, { legacyDecrypt } = {}) {
  const defaultId = defaultWorkspaceId(db);
  if (typeof defaultId !== "string" || !defaultId)
    fail("ACTIVATION_DEFAULT_WORKSPACE_MISSING", "Established Default workspace required");
  const ctx = createMigrationContext(db, root);
  const hashKid = db.get(`SELECT value FROM _meta WHERE key = 'apiKeysHashKid'`)?.value ?? null;
  if (typeof hashKid !== "string" || !KID_RE.test(hashKid))
    fail("API_KEY_STATE_INVALID", "hashed API-key storage required");

  const adopted = adoptOwnerless(db, defaultId);
  const counts = { adopted, connections: 0, nodes: 0, settings: 0 };

  for (const table of OWNED_TABLES) {
    for (const row of db.all(`SELECT id, data, workspaceId FROM ${table}`)) {
      const blob = parseCredentialBlob(row.data);
      if (encryptLeaves(db, ctx, table, row, blob, row.workspaceId)) {
        db.run(`UPDATE ${table} SET data = ? WHERE id = ?`, [JSON.stringify(blob), row.id]);
        counts[table === "providerConnections" ? "connections" : "nodes"] += 1;
      }
    }
  }

  const settingsRow = db.get(`SELECT data FROM settings WHERE id = 1`);
  if (settingsRow) {
    const blob = parseCredentialBlob(settingsRow.data);
    const mitmChanged = rekeyLegacyMitm(blob, legacyDecrypt);
    const encChanged = encryptLeaves(db, ctx, "settings", { id: "1" }, blob, defaultId);
    if (mitmChanged || encChanged) {
      db.run(`UPDATE settings SET data = ? WHERE id = 1`, [JSON.stringify(blob)]);
      counts.settings += 1;
    }
  }

  // D6: store the DERIVED 32-byte hash key, wrapped under the KEK with the
  // frozen hash-kid AAD. The old master is never stored anywhere.
  const derived = deriveApiKeyHashKey(root.key);
  let wrapped;
  try {
    wrapped = encryptBytes(root.key, root.kid, derived, buildHashKeyWrapAad(defaultId, hashKid));
  } finally {
    zeroBuffer(derived);
  }
  setMeta(db, "apiKeyHashKeyWrapped", JSON.stringify(wrapped));

  // D4: latch the durable marker pair; D7: force restart-finished cleanup.
  setMeta(db, "credentialsEncryptedVersion", "1");
  setMeta(db, "credentialsKekKid", root.kid);
  setMeta(db, "credentialsCleanupPending", "1");
  return counts;
}

/**
 * Established-storage startup proof: every stored envelope must authenticate
 * unchanged under the current root (runtime mode also rejects plaintext
 * covered secrets). Read-only; used by activation recovery before readiness.
 * @param {object} db adapter.
 * @param {{kid:string,key:Buffer}} root must match the marker kid.
 */
export function verifyEncryptedRowsSync(db, root) {
  const ctx = prepareCredentialContext(db, root);
  const defaultId = defaultWorkspaceId(db);
  for (const table of OWNED_TABLES) {
    for (const row of db.all(`SELECT id, data, workspaceId FROM ${table}`)) {
      decodeCredentialRowSync(db, row, ctx, { table, mode: "runtime" });
    }
  }
  const settingsRow = db.get(`SELECT id, data FROM settings WHERE id = 1`);
  if (settingsRow) {
    decodeCredentialRowSync(db, settingsRow, ctx, {
      table: "settings",
      mode: "runtime",
      workspaceId: defaultId,
    });
  }
}
