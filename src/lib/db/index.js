// Public API barrel — all DB functions
import { getAdapter } from "./driver.js";
import { stringifyJson, parseJson } from "./helpers/jsonCol.js";
import { latestVersion } from "./migrations/index.js";
import { adoptOwnerlessRowsUnscoped, defaultWorkspaceIdUnscoped } from "./repos/ownership.js";
import { getMetaSync } from "./helpers/metaStore.js";
import {
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
  backfillSavingsLifetime,
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
  saveRequestUsage,
  getUsageHistory,
  getUsageStatsUnscoped,
  getChartData,
  getUsageSavings,
  getUsageTotals,
  getLastActivity,
  getHomeSummary,
  getLiveRoutesFeed,
  getRequestRateSeries,
  getSavingsLifetime,
  recordFallbackHop,
  appendRequestLog,
  getRecentLogsUnscoped,
} from "./repos/usageRepo.js";

// Request details
export {
  saveRequestDetail,
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

// YAN-364: the export/import snapshot stays the legacy single-user shape.
// Default-workspace alias/custom keys travel unprefixed; other workspaces are
// never silently flattened into it (user-aware export is YAN-375).
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
        const { key, kid } = await loadMasterKey();
        if (kid !== instanceHint.hashKid) {
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

  const invalidateCaches = await prepareTransferCacheInvalidation();

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
    db.transaction(() => applyGatewayKeySnapshot(db, payload, plan));
    // Persistence contract (activation lane): adapters with deferred
    // persistence (sql.js debounced save) must expose sync flushSync() that
    // throws on I/O failure, so a reported success is a durable import.
    // No-op where absent — better-sqlite3/node:sqlite write synchronously.
    invalidateCaches();
    db.flushSync?.();
    return await exportDb();
  }

  db.transaction(() => {
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

  // Persistence contract (see hashed branch above): durable before success.
  invalidateCaches();
  db.flushSync?.();
  return await exportDb();
}

/** Load caches before mutation; clear synchronously after commit, before flush.
 * Resolver cache holds ids only and always live-checks eligibility; clearing
 * still prevents old state surviving replacement. Import/clear errors propagate.
 */
async function prepareTransferCacheInvalidation() {
  const { clearApiKeyPrincipalCache } = await import("@/lib/auth/apiKeyPrincipal.js");
  const { invalidatePricingCache } = await import("./repos/pricingRepo.js");
  return () => {
    try {
      clearApiKeyPrincipalCache();
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
