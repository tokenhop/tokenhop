// Public API barrel — all DB functions
import { getAdapter } from "./driver.js";
import { stringifyJson, parseJson } from "./helpers/jsonCol.js";
import { latestVersion } from "./migrations/index.js";
import { adoptOwnerlessRowsUnscoped, defaultWorkspaceIdUnscoped } from "./repos/ownership.js";
import { readCredentialEncryptionState } from "./credentialEncryptionState.js";
import {
  isCredentialMaintenancePoisoned,
  poisonCredentialMaintenance,
} from "./credentialMaintenance.js";
import { getMetaSync } from "./helpers/metaStore.js";
import {
  CREDENTIAL_TRANSFER_FORMAT_VERSION,
  TransferError,
  applyGatewayKeySnapshot,
  exportGatewayKeySnapshot,
  gatewayKeyStorageSnapshot,
  insertLegacyKeysHashedSync,
  preflightGatewayKeyImport,
  preserveLocalVerifierSettings,
} from "./helpers/gatewayKeyTransfer.js";
import {
  PRE_IMPORT_BACKUP_PREFIX,
  backupDbLite,
  makeProtectedBackupDir,
  prepareProtectedBackupVerifier,
} from "./backup.js";

// Settings
export {
  getSettings,
  updateSettings,
  updateComboStrategies,
  isCloudEnabled,
  getCloudUrl,
  exportSettings,
  getEffectivePreferences,
  listEffectivePreferencesUnscoped,
} from "./repos/settingsRepo.js";

// Workspace settings overrides + user preferences (YAN-362)
export {
  getWorkspaceSettings,
  updateWorkspaceSettings,
  updateWorkspaceComboStrategies,
  getUserPreferences,
  updateUserPreferences,
  mirrorToDefaultWorkspace,
  seedDefaultWorkspaceSettingsUnscoped,
  removeLegacyPasswordUnscoped,
  getLegacyPasswordHash,
} from "./repos/workspaceSettingsRepo.js";

// Provider connections
export {
  getProviderConnectionsUnscoped,
  getProviderConnectionByIdUnscoped,
  createProviderConnectionUnscoped,
  updateProviderConnectionUnscoped,
  deleteProviderConnectionUnscoped,
  deleteProviderConnectionsByProviderUnscoped,
  reorderProviderConnectionsUnscoped,
  cleanupProviderConnectionsUnscoped,
  listConnections,
  getConnection,
  createConnection,
  updateConnection,
  deleteConnection,
} from "./repos/connectionsRepo.js";
export { adoptOwnerlessUnscoped } from "./repos/ownership.js";

// Provider nodes
export {
  getProviderNodesUnscoped,
  getProviderNodeByIdUnscoped,
  createProviderNodeUnscoped,
  updateProviderNodeUnscoped,
  deleteProviderNodeUnscoped,
  listNodes,
  getNode,
  createNode,
  updateNode,
  deleteNode,
} from "./repos/nodesRepo.js";

// Proxy pools
export {
  getProxyPools,
  getProxyPoolById,
  createProxyPool,
  updateProxyPool,
  deleteProxyPool,
} from "./repos/proxyPoolsRepo.js";

// API keys
export {
  getApiKeys,
  getApiKeyById,
  createApiKey,
  updateApiKey,
  deleteApiKey,
  validateApiKey,
} from "./repos/apiKeysRepo.js";

// API key usage (from usageHistory)
export { getApiKeyUsage } from "./repos/apiKeyUsageRepo.js";

export {
  rowSavedFromSavings,
  backfillSavingsLifetimeUnscoped,
  SAVINGS_LIFETIME_KEY,
} from "./repos/usageRepo.js";

// Combos (YAN-364: scoped + Unscoped APIs)
export {
  getCombosUnscoped,
  getComboByIdUnscoped,
  getComboByNameUnscoped,
  createComboUnscoped,
  updateComboUnscoped,
  deleteComboUnscoped,
  reorderCombosUnscoped,
  listCombos,
  getCombo,
  getComboByNameScoped,
  createCombo,
  updateCombo,
  deleteCombo,
  reorderCombos,
} from "./repos/combosRepo.js";

// Aliases (model + custom scoped/unscoped + instance-scope mitm)
export {
  getModelAliases,
  setModelAlias,
  deleteModelAlias,
  getCustomModels,
  addCustomModel,
  deleteCustomModel,
  getModelAliasesUnscoped,
  setModelAliasUnscoped,
  deleteModelAliasUnscoped,
  getCustomModelsUnscoped,
  addCustomModelUnscoped,
  deleteCustomModelUnscoped,
  getMitmAlias,
  setMitmAliasAll,
} from "./repos/aliasRepo.js";

// CLI tool card settings (kv scope cliToolSettings, key = toolId)
export {
  getCliToolSettings,
  setCliToolSettings,
  deleteCliToolSettings,
  getCliToolPresets,
  setCliToolPresets,
} from "./repos/cliToolSettingsRepo.js";

// Pricing
export {
  getPricing,
  getPricingForModel,
  getUserPricing,
  updatePricing,
  resetPricing,
  resetAllPricing,
  invalidatePricingCache,
} from "./repos/pricingRepo.js";

// Disabled models (YAN-364: scoped + Unscoped APIs)
export {
  getDisabledModels,
  getDisabledByProvider,
  disableModels,
  enableModels,
  getDisabledModelsUnscoped,
  getDisabledByProviderUnscoped,
  disableModelsUnscoped,
  enableModelsUnscoped,
} from "./repos/disabledModelsRepo.js";

// Usage
export {
  statsEmitter,
  trackPendingRequest,
  getLiveSnapshot,
} from "./repos/usageLiveFeed.js";
export { getUsageStats, getChartData } from "./repos/usageStatsRepo.js";
export {
  saveRequestUsageUnscoped,
  getUsageHistory,
  getUsageSavings,
  getUsageTotals,
  getLastActivity,
  getHomeSummary,
  getLiveRoutesFeed,
  getRequestRateSeries,
  getSavingsLifetime,
  recordFallbackHop,
  appendRequestLog,
  getRecentLogs,
} from "./repos/usageRepo.js";

// Request details
export {
  saveRequestDetailUnscoped,
  getRequestDetails,
  getRequestDetailById,
  getDistinctProviders,
} from "./repos/requestDetailsRepo.js";

// Users & teams identity and tenancy (YAN-353). Inert until the multi-user
// switch is on; scoped functions take a Principal (`@/lib/users/principal.js`).
export {
  getUser,
  getUserUnscoped,
  listUsersUnscoped,
  getOwnerUnscoped,
  countActiveUsersUnscoped,
  getSessionUserUnscoped,
  bumpSessionVersion,
  getUserPasswordHashUnscoped,
  findUsersByLoginUnscoped,
  setUserPasswordUnscoped,
  createUserUnscoped,
  bootstrapOwnerUnscoped,
  updateUserUnscoped,
  deleteUserUnscoped,
  transferOwnership,
} from "./repos/usersRepo.js";
export {
  listIdentities,
  unlinkIdentity,
  findIdentityUnscoped,
  listIdentitiesUnscoped,
  linkIdentityUnscoped,
} from "./repos/identitiesRepo.js";
export {
  listWorkspaces,
  getWorkspace,
  listWorkspacesUnscoped,
  countSharedWorkspacesUnscoped,
  createSharedWorkspace,
  renameWorkspace,
  deleteWorkspace,
} from "./repos/workspacesRepo.js";
export { getMeta, setMeta } from "./helpers/metaStore.js";
export * as auditRepo from "./repos/auditRepo.js"; // YAN-367
export {
  listMemberships,
  addMembership,
  updateMembershipRole,
  removeMembership,
} from "./repos/membershipsRepo.js";
export {
  INVITATION_TTL_MS,
  hashInvitationToken,
  createInvitation,
  listInvitations,
  revokeInvitation,
  getInvitationForConsumeSync,
  consumeInvitationSync,
} from "./repos/invitationsRepo.js";
export {
  listGrantsForConnection,
  getGrantById,
  createGrant,
  revokeGrant,
  listActiveGrantsForPrincipal,
} from "./repos/connectionGrantsRepo.js"; // YAN-369

// YAN-364: the export/import snapshot stays the legacy single-user shape.
// Default-workspace alias/custom keys travel unprefixed; other workspaces are
// never silently flattened into it (user-aware export is YAN-375).
// YAN-365: on established credential encryption — or an ambiguous/corrupt
// marker (fail closed) — only formatVersion 3 enters. "Legacy" classification
// (formatVersion 1) happens before any credential-shape check, so an exact
// version pin here closes the `{}`/`null` credentialEncryption smuggle that
// would otherwise route to the wipe-and-write-plaintext apply.
function assertEncryptedImportAllowed(db, payload) {
  let encrypted = false;
  try {
    encrypted = readCredentialEncryptionState(db, { strict: true }).storage === "encrypted";
  } catch {
    encrypted = true;
  }
  if (encrypted && payload?.formatVersion !== CREDENTIAL_TRANSFER_FORMAT_VERSION) {
    throw new TransferError(
      "TRANSFER_FORMAT_INVALID",
      "Encrypted instance: restore a v3 snapshot with the matching root",
    );
  }
}
const WS_KEY_PREFIX_RE = /^ws:[^/]+\//;

function stripWsKey(key) {
  return key.replace(WS_KEY_PREFIX_RE, "");
}

function isLegacyDefaultKey(key, defaultWs) {
  return !WS_KEY_PREFIX_RE.test(key) || (defaultWs != null && key.startsWith(`ws:${defaultWs}/`));
}

// Export/import full DB
export async function exportDb() {
  const db = await getAdapter();
  const { exportSettings } = await import("./repos/settingsRepo.js");
  const defaultWs = defaultWorkspaceIdUnscoped(db);

  const out = {
    schemaVersion: latestVersion(),
    settings: await exportSettings(),
    providerConnections: db.all(`SELECT * FROM providerConnections`).map((r) => ({
      ...parseJson(r.data, {}),
      id: r.id,
      provider: r.provider,
      authType: r.authType,
      name: r.name,
      email: r.email,
      priority: r.priority,
      isActive: r.isActive === 1,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    providerNodes: db.all(`SELECT * FROM providerNodes`).map((r) => ({
      ...parseJson(r.data, {}),
      id: r.id,
      type: r.type,
      name: r.name,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    proxyPools: db.all(`SELECT * FROM proxyPools`).map((r) => ({
      ...parseJson(r.data, {}),
      id: r.id,
      isActive: r.isActive === 1,
      testStatus: r.testStatus,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    apiKeys: db.all(`SELECT * FROM apiKeys`).map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      machineId: r.machineId,
      isActive: r.isActive === 1,
      createdAt: r.createdAt,
    })),
    combos: db.all(`SELECT * FROM combos`).map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      models: parseJson(r.models, []),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    modelAliases: {},
    customModels: [],
    mitmAlias: {},
    cliToolSettings: {},
    cliToolPresets: {},
    pricing: {},
  };

  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'modelAliases'`)) {
    if (!isLegacyDefaultKey(r.key, defaultWs)) continue;
    out.modelAliases[stripWsKey(r.key)] = parseJson(r.value);
  }
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'customModels'`)) {
    if (!isLegacyDefaultKey(r.key, defaultWs)) continue;
    out.customModels.push(parseJson(r.value));
  }
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'mitmAlias'`))
    out.mitmAlias[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'cliToolSettings'`))
    out.cliToolSettings[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'cliToolPresets'`))
    out.cliToolPresets[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'pricing'`))
    out.pricing[r.key] = parseJson(r.value);

  // YAN-363: hashed instances additionally carry the format v2 sections
  // (key metadata only, identity graph, security marker). Legacy instances
  // export the exact legacy snapshot shape — byte-compatible roundtrip.
  return exportGatewayKeySnapshot(db, out, gatewayKeyStorageSnapshot(db));
}

export async function importDb(payload, { masterKey = null } = {}) {
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
  assertEncryptedImportAllowed(db, payload);

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
  const instance = gatewayKeyStorageSnapshot(db);
  const plan = preflightGatewayKeyImport(payload, {
    instance,
    db,
    masterKey: resolvedMaster,
    defaultWorkspaceId: getMetaSync(db, "defaultWorkspaceId"),
  });
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
  const verifyBackup = await prepareProtectedBackupVerifier();

  // Pre-import backup AFTER all validation above (shape, root, preflight):
  // a recoverable private pre-import-* snapshot before either destructive
  // transaction. Backup failure aborts with zero mutation.
  let preImportDir;
  try {
    preImportDir = makeProtectedBackupDir(PRE_IMPORT_BACKUP_PREFIX);
    const preImportFile = backupDbLite(db, preImportDir, "data.sqlite", true);
    verifyBackup(preImportDir, preImportFile);
  } catch (error) {
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
    commitDurably(db, invalidateCaches);
    return await exportDb();
  }

  db.transaction(() => {
    assertStateCurrent();
    // Host-local MITM verifier: read the live row BEFORE the wipe below.
    const restoredSettings = preserveLocalVerifierSettings(
      db,
      payload.settings ? { ...payload.settings } : undefined,
    );
    // Wipe all tables (keep _meta)
    db.run(`DELETE FROM settings`);
    db.run(`DELETE FROM providerConnections`);
    db.run(`DELETE FROM providerNodes`);
    db.run(`DELETE FROM proxyPools`);
    db.run(`DELETE FROM apiKeys`);
    db.run(`DELETE FROM combos`);
    // No disabledModels here: the legacy snapshot has no section for it, so
    // local disabled-model preferences survive a config import.
    db.run(
      `DELETE FROM kv WHERE scope IN ('modelAliases', 'customModels', 'mitmAlias', 'cliToolSettings', 'cliToolPresets', 'pricing')`,
    );

    // Settings: full destructive replace except the host-local MITM verifier
    // hash — a live local verifier (running child custody) survives and any
    // imported one is dropped, so no imported value can ever become the
    // runtime verifier.
    if (restoredSettings !== undefined) {
      db.run(
        `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
        [stringifyJson(restoredSettings)],
      );
    }

    for (const c of payload.providerConnections || []) {
      const {
        id,
        provider,
        authType,
        name,
        email,
        priority,
        isActive,
        createdAt,
        updatedAt,
        workspaceId: _ws,
        createdByUserId: _by,
        ...rest
      } = c;
      db.run(
        `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          provider,
          authType || "oauth",
          name || null,
          email || null,
          priority || null,
          isActive === false ? 0 : 1,
          stringifyJson(rest),
          createdAt || new Date().toISOString(),
          updatedAt || new Date().toISOString(),
        ],
      );
    }
    for (const n of payload.providerNodes || []) {
      const {
        id,
        type,
        name,
        createdAt,
        updatedAt,
        workspaceId: _ws,
        createdByUserId: _by,
        ...rest
      } = n;
      db.run(
        `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [
          id,
          type || null,
          name || null,
          stringifyJson(rest),
          createdAt || new Date().toISOString(),
          updatedAt || new Date().toISOString(),
        ],
      );
    }
    for (const p of payload.proxyPools || []) {
      const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
      db.run(
        `INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [
          id,
          isActive === false ? 0 : 1,
          testStatus || "unknown",
          stringifyJson(rest),
          createdAt || new Date().toISOString(),
          updatedAt || new Date().toISOString(),
        ],
      );
    }
    // Legacy storage keeps the byte-identical raw-key import. A hashed
    // instance never receives a plaintext row: keys are HMAC'd into hashed
    // rows (Default workspace, legacy=1) and cliToolPresets are converted to
    // apiKeyId references after the generic loops wrote them.
    if (instance.storage === "legacy") {
      for (const k of payload.apiKeys || []) {
        db.run(
          `INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)`,
          [
            k.id,
            k.key,
            k.name || null,
            k.machineId || null,
            k.isActive === false ? 0 : 1,
            k.createdAt || new Date().toISOString(),
          ],
        );
      }
    }
    for (const c of payload.combos || []) {
      db.run(
        `INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [
          c.id,
          c.name,
          c.kind || null,
          stringifyJson(c.models || []),
          c.createdAt || new Date().toISOString(),
          c.updatedAt || new Date().toISOString(),
        ],
      );
    }
    // Keys from newer workspace-aware snapshots lose their `ws:<id>/` prefix
    // so they land bare and are adopted into the local Default workspace.
    for (const [a, m] of Object.entries(payload.modelAliases || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [
        stripWsKey(a),
        stringifyJson(m),
      ]);
    }
    for (const m of payload.customModels || []) {
      const k = stripWsKey(`${m.providerAlias}|${m.id}|${m.type || "llm"}`);
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [
        k,
        stringifyJson(m),
      ]);
    }
    for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [
        tool,
        stringifyJson(mappings || {}),
      ]);
    }
    for (const [tool, settings] of Object.entries(payload.cliToolSettings || {})) {
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) continue;
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('cliToolSettings', ?, ?)`, [
        tool,
        stringifyJson(settings || {}),
      ]);
    }
    for (const [kind, items] of Object.entries(payload.cliToolPresets || {})) {
      if (!["endpoints", "apiKeys"].includes(kind) || !Array.isArray(items)) continue;
      // Hashed instances never accept the raw apiKeys preset kind — converted
      // apiKeyId rows are written by insertLegacyKeysHashedSync instead, so
      // no plaintext ever reaches a table page or WAL frame.
      if (kind === "apiKeys" && instance.storage === "hashed") continue;
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('cliToolPresets', ?, ?)`, [
        kind,
        stringifyJson(items),
      ]);
    }
    for (const [provider, models] of Object.entries(payload.pricing || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [
        provider,
        stringifyJson(models || {}),
      ]);
    }
    // YAN-361: imported connections and nodes belong to Default (no-op before bootstrap).
    adoptOwnerlessRowsUnscoped(db);

    if (instance.storage === "hashed") insertLegacyKeysHashedSync(db, payload, plan);
  });

  commitDurably(db, invalidateCaches);
  return await exportDb();
}

const NATIVE_DRIVERS = ["better-sqlite3", "node:sqlite", "bun:sqlite"];

// Same strict durability contract as activation/rotation (not imported: those
// modules sit above this barrel). sql.js must expose a throwing flushSync;
// native drivers commit synchronously and need a checked FULL checkpoint.
function flushStrict(db) {
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
function commitDurably(db, invalidateCaches) {
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
async function prepareTransferCacheInvalidation(db) {
  const { clearApiKeyPrincipalCache } = await import("@/lib/auth/apiKeyPrincipal.js");
  const { invalidatePricingCache } = await import("./repos/pricingRepo.js");
  const { clearCredentialCache } = await import("./helpers/credentialStorage.js");
  const { clearApiKeyHashKeyStateCache } = await import("@/lib/security/apiKeyHashKey.js");
  const mitm = await import("@/mitm/manager.js").catch(() => null);
  // CJS module: named export or default.* depending on interop.
  const setter = mitm?.default?.setCachedPassword ?? mitm?.setCachedPassword;
  return () => {
    try {
      clearApiKeyPrincipalCache();
      clearCredentialCache(db);
      clearApiKeyHashKeyStateCache(db);
      setter?.(null);
    } finally {
      invalidatePricingCache();
    }
  };
}

export { TransferError };

// Eager init helper (optional)
export async function initDb() {
  await getAdapter();
}
