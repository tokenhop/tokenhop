// YAN-375: legacy (formatVersion 1) snapshot → ESTABLISHED credential
// encryption. Imports the legacy config into the Default workspace under the
// live root: covered credential leaves are encoded with the existing
// credentialStorage codec (Default workspace DEK, SQL row coordinates), so no
// plaintext covered value ever reaches a table page or WAL frame. The live
// identity / DEK / hash-key graph is never touched. Sync + adapter-passed
// (no barrel/driver/switch imports); the caller resolves the feature switch
// and the trusted root asynchronously first.
import { masterKeyId } from "../../security/masterKey.js";
import { readCredentialEncryptionState } from "../credentialEncryptionState.js";
import { isCredentialMaintenancePoisoned } from "../credentialMaintenance.js";
import { defaultWorkspaceIdUnscoped } from "../repos/ownership.js";
import { TransferError, preflightGatewayKeyImport } from "./gatewayKeyTransfer.js";
import { encodeCredentialRowSync, prepareCredentialContext } from "./credentialStorage.js";

const CODE_MAP = { KEY_MISMATCH: "TRANSFER_ROOT_MISMATCH" };

/**
 * A payload that is unambiguously the legacy single-user shape: version 1 (or
 * absent) and no credential/hash-marker section of any kind (own property,
 * even null/{}). Anything else is never routed to the legacy encrypted path.
 */
export function isConfirmedLegacyPayload(payload) {
  return (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    (payload.formatVersion ?? 1) === 1 &&
    !Object.hasOwn(payload, "credentialEncryption") &&
    !Object.hasOwn(payload, "workspaceKeys") &&
    !Object.hasOwn(payload, "apiKeyStorage")
  );
}

/**
 * Encode settings/connections/nodes for the Default workspace. Pure (reads
 * only; a missing Default DEK throws KEY_MISSING, runtime contexts never
 * create keys). Refuses to run unless encryption is established — it can
 * never emit a plaintext row.
 */
export function encodeLegacyCredentialRows(db, payload, settings, masterKey, plan) {
  const state = readCredentialEncryptionState(db);
  if (state.storage !== "encrypted") {
    throw Object.assign(new Error("[legacy-import] encrypted storage required"), {
      code: "CREDENTIAL_STATE_INVALID",
    });
  }
  const ctx = prepareCredentialContext(db, { kid: state.kekKid, key: masterKey });
  const ws = plan.defaultWorkspaceId;
  const now = new Date().toISOString();
  const encode = (table, id, data) =>
    encodeCredentialRowSync(db, { id, data }, ctx, { table, workspaceId: ws });

  const out = {
    workspaceId: ws,
    createdByUserId: plan.ownerId ?? null,
    settings: settings === undefined ? undefined : encode("settings", "1", settings),
    connections: [],
    nodes: [],
  };
  for (const c of payload.providerConnections || []) {
    const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...r } =
      c;
    const { workspaceId: _ws, createdByUserId: _by, ...rest } = r;
    out.connections.push({
      id,
      provider,
      authType: authType || "oauth",
      name: name || null,
      email: email || null,
      priority: priority || null,
      isActive: isActive === false ? 0 : 1,
      data: encode("providerConnections", id, rest),
      createdAt: createdAt || now,
      updatedAt: updatedAt || now,
    });
  }
  for (const n of payload.providerNodes || []) {
    const { id, type, name, createdAt, updatedAt, ...r } = n;
    const { workspaceId: _ws, createdByUserId: _by, ...rest } = r;
    out.nodes.push({
      id,
      type: type || null,
      name: name || null,
      data: encode("providerNodes", id, rest),
      createdAt: createdAt || now,
      updatedAt: updatedAt || now,
    });
  }
  return out;
}

/**
 * Pure preflight (no writes) for a legacy payload on an encrypted instance.
 * Reuses the existing legacy hashed-instance plan (key HMAC under the stable
 * hash key, preset conversion, retained video jobs) and dry-encodes every
 * covered row so Default-DEK/shape problems fail BEFORE backup or wipe.
 */
export function preflightLegacyEncryptedImport(payload, { instance, db, masterKey }) {
  let live;
  try {
    live = readCredentialEncryptionState(db, { strict: true });
  } catch {
    throw new TransferError("TRANSFER_STATE_INVALID", "Destination credential state is unreadable");
  }
  if (live.storage !== "encrypted") {
    throw new TransferError(
      "TRANSFER_INSTANCE_MODE_UNSUPPORTED",
      "Legacy encrypted import requires established credential encryption",
    );
  }
  if (live.pendingRotation || live.cleanupPending) {
    throw new TransferError(
      "TRANSFER_ROTATION_IN_FLIGHT",
      "Restore refused while key maintenance is pending",
    );
  }
  if (isCredentialMaintenancePoisoned(db)) {
    throw new TransferError(
      "TRANSFER_STATE_INVALID",
      "Restore refused: credential maintenance is unavailable",
    );
  }
  if (masterKey === null || masterKey === undefined) {
    throw new TransferError(
      "TRANSFER_MASTER_REQUIRED",
      "Importing requires the instance master key",
    );
  }
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
    throw new TransferError("TRANSFER_MASTER_KEY_INVALID", "masterKey must be a 32-byte Buffer");
  }
  if (masterKeyId(masterKey) !== live.kekKid) {
    throw new TransferError(
      "TRANSFER_ROOT_MISMATCH",
      "Supplied master key does not match the root",
    );
  }
  const defaultWorkspaceId = defaultWorkspaceIdUnscoped(db);
  if (!defaultWorkspaceId) {
    throw new TransferError("TRANSFER_STATE_INVALID", "Instance has no Default workspace");
  }
  // The legacy plan compares the supplied kid with the FROZEN hash kid; after
  // a KEK rotation the current root differs from it by design. The authority
  // here is resolveApiKeyHashKeySync inside the plan (authenticated unwrap
  // under the current KEK), so present the shadow instance whose hashKid is
  // the proven root, then restore the frozen kid on the returned plan.
  const plan = preflightGatewayKeyImport(payload, {
    instance: { ...instance, hashKid: live.kekKid },
    db,
    masterKey,
    defaultWorkspaceId,
  });
  if (plan.format !== "legacy" || !plan.hashKey) {
    throw new TransferError("TRANSFER_STATE_INVALID", "Legacy plan unavailable on this instance");
  }
  const full = {
    ...plan,
    kid: instance.hashKid,
    defaultWorkspaceId,
    ownerId: db.get(`SELECT id FROM users WHERE instanceRole = 'owner'`)?.id ?? null,
  };
  try {
    encodeLegacyCredentialRows(db, payload, payload.settings ?? undefined, masterKey, full);
  } catch (error) {
    if (error instanceof TransferError) throw error;
    throw new TransferError(
      CODE_MAP[error?.code] ?? "TRANSFER_STATE_INVALID",
      `Legacy credential rows cannot be encrypted: ${error?.message ?? error}`,
    );
  }
  return full;
}

/** Insert pre-encoded connection/node rows (Default workspace + owner). */
export function insertLegacyEncryptedRowsSync(db, enc) {
  for (const c of enc.connections) {
    db.run(
      `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, workspaceId, createdByUserId)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        c.id,
        c.provider,
        c.authType,
        c.name,
        c.email,
        c.priority,
        c.isActive,
        c.data,
        c.createdAt,
        c.updatedAt,
        enc.workspaceId,
        enc.createdByUserId,
      ],
    );
  }
  for (const n of enc.nodes) {
    db.run(
      `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt, workspaceId, createdByUserId)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        n.id,
        n.type,
        n.name,
        n.data,
        n.createdAt,
        n.updatedAt,
        enc.workspaceId,
        enc.createdByUserId,
      ],
    );
  }
}
