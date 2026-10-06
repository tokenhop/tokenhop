// YAN-363 hashed key management, used by the /api/keys routes. Explicit
// session/CLI ctx + workspaceId: list/detail/create/update/revoke by
// management principals only. API-key principals are
// never management authority, even when eligible on the gateway. Every DB op
// is workspace-scoped; membership/role re-read from the DB per operation
// (ctx roles are advisory only). Foreign IDs are NOT_FOUND, never leaked.
// The personal-workspace secret boundary holds against instance admins
// unless they are actual members with a manager role there: admin oversight
// capabilities never include key secrets or management of keys.
import { hashApiKey } from "../security/masterKey.js";
import { getApiKeyHashKey } from "../security/apiKeyHashKey.js";
import { apiKeyMetadata, insertHashedApiKeySync } from "../db/repos/apiKeysRepo.js";
import { readApiKeyStorageState } from "../db/apiKeyState.js";
import { membershipRole } from "../db/repos/membershipsRepo.js";
import { can } from "./principal.js";
import { audit } from "./audit.js";
import { getAdapter } from "../db/driver.js";
import { TenancyError, assertCtx, mapConstraintErrors } from "./errors.js";
import { apiKeyPrefix, generateGatewayApiKey } from "../../shared/utils/apiKey.js";

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Management runs only on the hashed store; never legacy reads/writes. */
function requireHashedState(db) {
  const state = readApiKeyStorageState(db);
  if (state.storage !== "hashed") {
    throw new TenancyError("INVALID", "Key management requires hashed storage");
  }
  return state;
}

/** Bearer principals carry no management authority, even over their own row. */
function requireManagementCtx(ctx) {
  assertCtx(ctx);
  if (!["session", "cli"].includes(ctx.via) || ctx.apiKeyId != null) {
    throw new TenancyError("FORBIDDEN", "Authenticated session or CLI principal required");
  }
  if (typeof ctx.instanceRole !== "string" || !ctx.instanceRole) {
    throw new TenancyError("INVALID", "A principal (ctx) with instanceRole is required");
  }
}

/**
 * Live access snapshot: user status, instanceRole and workspace role are ALL
 * re-read from the DB on every call. A stale ctx (workspaceRoles or
 * instanceRole) never grants anything. Missing workspace and non-membership
 * are indistinguishable (NOT_FOUND) — no cross-workspace leak.
 */
function liveAccess(db, ctx, workspaceId) {
  const user = db.get(`SELECT instanceRole, status FROM users WHERE id = ?`, [ctx.userId]);
  if (user?.status !== "active") throw new TenancyError("NOT_FOUND", "User not found");
  const ws = db.get(`SELECT id FROM workspaces WHERE id = ?`, [workspaceId]);
  const role = ws ? membershipRole(db, workspaceId, ctx.userId) : null;
  if (!ws || !role) throw new TenancyError("NOT_FOUND", "Workspace not found");
  // Capabilities come from the shared role map using LIVE values only.
  const live = { instanceRole: user.instanceRole, workspaceRoles: { [workspaceId]: role } };
  const allowed = (capability) => can(live, capability, { workspaceId });
  return { create: allowed("workspace.keys.create"), manage: allowed("workspace.keys.manage") };
}

function requireManage(access, verb) {
  if (!access.manage) throw new TenancyError("FORBIDDEN", `Only managers can ${verb} keys`);
}

function scopedRow(db, id, workspaceId) {
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ? AND workspaceId = ?`, [id, workspaceId]);
  if (!row) throw new TenancyError("NOT_FOUND", "API key not found");
  return row;
}

function validName(name) {
  if (name === undefined || name === null) return null;
  if (typeof name !== "string" || name.length === 0 || name.length > 64) {
    throw new TenancyError("INVALID", "Key name must be a string of 1-64 chars");
  }
  return name;
}

// Same bounds the repo row validator enforces (128 entries, 1-256 chars each);
// the repo's validator is insert-only, so scoped UPDATE needs the check here.
function scopeJson(value, field) {
  if (value === undefined || value === null) return "[]";
  if (!Array.isArray(value) || value.length > 128) {
    throw new TenancyError("INVALID", `${field} must be an array of at most 128 strings`);
  }
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > 256) {
      throw new TenancyError("INVALID", `${field} entries must be strings of 1-256 chars`);
    }
  }
  return JSON.stringify(value);
}

// allowedCombos is an allowlist of combo IDs; a typo'd or display-name entry
// would persist into a key that can never authorize any combo (silent
// deny-everything). Entries must reference an existing instance combo —
// combos are instance-level config, not workspace-owned, until YAN-364; no
// per-workspace combo lookup here. Empty list stays unrestricted. Field-
// specific generic error: no combo IDs echoed back.
function requireExistingCombos(db, combos) {
  if (!Array.isArray(combos) || combos.length === 0) return;
  for (const id of combos) {
    if (!db.get(`SELECT 1 FROM combos WHERE id = ?`, [id])) {
      throw new TenancyError("INVALID", "allowedCombos entries must be existing combo IDs");
    }
  }
}

function validExpiry(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !ISO_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TenancyError("INVALID", "expiresAt must be an ISO-8601 UTC string or null");
  }
  return new Date(value).toISOString();
}

export async function listApiKeys(ctx, workspaceId) {
  requireManagementCtx(ctx);
  const db = await getAdapter();
  requireHashedState(db);
  const access = liveAccess(db, ctx, workspaceId);
  // D1 permission map: members create their own user keys; only managers
  // list/manage workspace key metadata. Viewers get nothing.
  requireManage(access, "list");
  return db
    .all(`SELECT * FROM apiKeys WHERE workspaceId = ? ORDER BY createdAt ASC`, [workspaceId])
    .map(apiKeyMetadata);
}

export async function getApiKey(ctx, workspaceId, id) {
  requireManagementCtx(ctx);
  const db = await getAdapter();
  requireHashedState(db);
  const access = liveAccess(db, ctx, workspaceId);
  const row = scopedRow(db, id, workspaceId);
  // Managers see any row; a user sees exactly their own user key. Like the
  // list rule, this is a role check, not ownership-by-principal confusion.
  if (!access.manage && !(row.userId === ctx.userId && row.userId !== null)) {
    throw new TenancyError("FORBIDDEN", "Only managers can view keys");
  }
  return apiKeyMetadata(row);
}

/**
 * Explicit create. Members create exactly their own user key; managers may
 * also create service keys (userId null). No key for another user, no silent
 * provisioning. Returns `{ key, metadata }`: the raw secret leaves only here;
 * afterwards only the prefix projection exists.
 */
export async function createApiKey(ctx, workspaceId, options = {}) {
  requireManagementCtx(ctx);
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TenancyError("INVALID", "Create body must be an object");
  }
  const allowed = ["type", "userId", "name", "allowedModels", "allowedCombos", "expiresAt"];
  if (Object.keys(options).some((field) => !allowed.includes(field))) {
    throw new TenancyError("INVALID", "Unknown create field");
  }
  const { type, userId = null, ...input } = options;
  if (type === "service" && userId !== null) {
    throw new TenancyError("INVALID", "Service keys cannot have a userId");
  }
  if (type !== "user" && type !== "service") {
    throw new TenancyError("INVALID", "Key type must be user or service");
  }
  if (userId != null && (typeof userId !== "string" || userId !== ctx.userId)) {
    throw new TenancyError("FORBIDDEN", "Cannot create a key for another user");
  }
  const name = validName(input.name);
  const expiresAt = validExpiry(input.expiresAt);
  if (expiresAt !== null && expiresAt <= new Date().toISOString()) {
    throw new TenancyError("INVALID", "expiresAt must be in the future");
  }
  if (input.allowedModels !== undefined) scopeJson(input.allowedModels, "allowedModels");
  if (input.allowedCombos !== undefined) scopeJson(input.allowedCombos, "allowedCombos");

  const db = await getAdapter();
  requireHashedState(db);
  const access = liveAccess(db, ctx, workspaceId);
  if (!access.create) throw new TenancyError("FORBIDDEN", "Not allowed to create keys");
  if (type === "service") requireManage(access, "create service");
  const keyUser = type === "user" ? ctx.userId : null;
  if (keyUser && !db.get(`SELECT id FROM users WHERE id = ? AND status = 'active'`, [keyUser])) {
    throw new TenancyError("NOT_FOUND", "User not found");
  }
  const { hashKid: kid, hashKey } = await getApiKeyHashKey(db);
  const raw = generateGatewayApiKey();
  const now = new Date().toISOString();
  const metadata = mapConstraintErrors(() =>
    db.transaction(() => {
      // Live recheck inside the write txn: membership may change between calls.
      if (!liveAccess(db, ctx, workspaceId).create)
        throw new TenancyError("FORBIDDEN", "Not allowed to create keys");
      if (type === "service") requireManage(liveAccess(db, ctx, workspaceId), "create service");
      requireExistingCombos(db, input.allowedCombos);
      return apiKeyMetadata(
        insertHashedApiKeySync(db, {
          workspaceId,
          userId: keyUser,
          createdByUserId: ctx.userId,
          keyHash: hashApiKey(raw, hashKey),
          hashKid: kid,
          prefix: apiKeyPrefix(raw),
          name,
          machineId: null,
          legacy: 0,
          isActive: 1,
          revokedAt: null,
          allowedModels: input.allowedModels ?? [],
          allowedCombos: input.allowedCombos ?? [],
          expiresAt,
          lastUsedAt: null,
          createdAt: now,
        }),
      );
    }),
  );
  await audit(
    { principal: ctx, workspaceId },
    "key.create",
    { type: "apiKey", id: metadata.id },
    {
      after: { id: metadata.id, name: metadata.name, keyPrefix: metadata.prefix, workspaceId },
    },
  );
  return { key: raw, metadata };
}

/**
 * Mutable allowlist: name/isActive/scopes/expiry only. Ownership, workspace,
 * hash and revokedAt assignment are rejected even for managers; a tombstoned
 * row can never be reactivated through `isActive: 1`.
 */
export async function updateApiKey(ctx, workspaceId, id, patch = {}) {
  requireManagementCtx(ctx);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new TenancyError("INVALID", "Update body must be an object");
  }
  const ALLOWED = ["name", "isActive", "allowedModels", "allowedCombos", "expiresAt"];
  for (const field of Object.keys(patch)) {
    if (!ALLOWED.includes(field)) {
      throw new TenancyError("INVALID", `Field ${field} cannot be updated`);
    }
  }
  const name = validName(patch.name);
  const isActive = patch.isActive === undefined ? null : patch.isActive === true;
  if (patch.isActive !== undefined && typeof patch.isActive !== "boolean") {
    throw new TenancyError("INVALID", "isActive must be a boolean");
  }
  const allowedModels = scopeJson(patch.allowedModels, "allowedModels");
  const allowedCombos = scopeJson(patch.allowedCombos, "allowedCombos");
  const expiresAt = validExpiry(patch.expiresAt);

  const db = await getAdapter();
  requireHashedState(db);
  requireManage(liveAccess(db, ctx, workspaceId), "update");

  const existing = db.get(
    `SELECT name, prefix, isActive FROM apiKeys WHERE id = ? AND workspaceId = ?`,
    [id, workspaceId],
  );
  const updated = await db.transaction(() => {
    requireManage(liveAccess(db, ctx, workspaceId), "update");
    const current = scopedRow(db, id, workspaceId);
    if (current.revokedAt != null) {
      if (patch.isActive === true) {
        throw new TenancyError("INVALID", "Revoked keys cannot be reactivated");
      }
      if (Object.keys(patch).length > 0) {
        throw new TenancyError("INVALID", "Revoked keys cannot be modified");
      }
      return apiKeyMetadata(current);
    }
    if (patch.allowedCombos !== undefined) requireExistingCombos(db, patch.allowedCombos);
    db.run(
      `UPDATE apiKeys SET name = ?, isActive = ?, allowedModels = ?, allowedCombos = ?, expiresAt = ? WHERE id = ? AND workspaceId = ?`,
      [
        patch.name === undefined ? current.name : name,
        patch.isActive === undefined ? current.isActive : isActive ? 1 : 0,
        patch.allowedModels === undefined ? current.allowedModels : allowedModels,
        patch.allowedCombos === undefined ? current.allowedCombos : allowedCombos,
        patch.expiresAt === undefined ? current.expiresAt : expiresAt,
        id,
        workspaceId,
      ],
    );
    return apiKeyMetadata(
      db.get(`SELECT * FROM apiKeys WHERE id = ? AND workspaceId = ?`, [id, workspaceId]),
    );
  });
  await audit(
    { principal: ctx, workspaceId },
    "key.update",
    { type: "apiKey", id },
    {
      before: existing
        ? { id, name: existing.name, keyPrefix: existing.prefix, workspaceId }
        : null,
      after: { id, name: updated.name, keyPrefix: updated.prefix, workspaceId },
    },
  );
  return updated;
}

/**
 * Manager revoke: permanent `revokedAt` tombstone, never a delete (usage
 * history stays attributable). Idempotent on an already-tombstoned row.
 */
export async function revokeApiKey(ctx, workspaceId, id, { now = new Date().toISOString() } = {}) {
  requireManagementCtx(ctx);
  const db = await getAdapter();
  requireHashedState(db);
  requireManage(liveAccess(db, ctx, workspaceId), "revoke");
  const canonicalNow = validExpiry(now);
  if (canonicalNow === null) throw new TenancyError("INVALID", "Revocation time is required");
  const existing = db.get(
    `SELECT name, prefix, revokedAt FROM apiKeys WHERE id = ? AND workspaceId = ?`,
    [id, workspaceId],
  );
  const revoked = await db.transaction(() => {
    requireManage(liveAccess(db, ctx, workspaceId), "revoke");
    const current = scopedRow(db, id, workspaceId);
    if (current.revokedAt == null) {
      db.run(`UPDATE apiKeys SET revokedAt = ? WHERE id = ? AND workspaceId = ?`, [
        canonicalNow,
        id,
        workspaceId,
      ]);
    }
    return apiKeyMetadata(
      db.get(`SELECT * FROM apiKeys WHERE id = ? AND workspaceId = ?`, [id, workspaceId]),
    );
  });
  if (existing?.revokedAt == null) {
    await audit(
      { principal: ctx, workspaceId },
      "key.revoke",
      { type: "apiKey", id },
      {
        before: { id, name: existing.name, keyPrefix: existing.prefix, workspaceId },
        after: { id, revokedAt: canonicalNow },
      },
    );
  }
  return revoked;
}
