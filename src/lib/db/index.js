// Public API barrel — all DB functions
import { getAdapter } from "./driver.js";
import { stringifyJson, parseJson } from "./helpers/jsonCol.js";
import { latestVersion } from "./migrations/index.js";
import { adoptOwnerlessRowsUnscoped } from "./repos/ownership.js";

// Settings
export {
  getSettings,
  updateSettings,
  updateComboStrategies,
  isCloudEnabled,
  getCloudUrl,
  exportSettings,
} from "./repos/settingsRepo.js";

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

// Combos
export {
  getCombos,
  getComboById,
  getComboByName,
  createCombo,
  updateCombo,
  deleteCombo,
} from "./repos/combosRepo.js";

// Aliases (model + custom + mitm)
export {
  getModelAliases,
  setModelAlias,
  deleteModelAlias,
  getCustomModels,
  addCustomModel,
  deleteCustomModel,
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

// Disabled models
export {
  getDisabledModels,
  getDisabledByProvider,
  disableModels,
  enableModels,
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
export {
  listMemberships,
  addMembership,
  updateMembershipRole,
  removeMembership,
} from "./repos/membershipsRepo.js";

// Export/import full DB
export async function exportDb() {
  const db = await getAdapter();
  const { exportSettings } = await import("./repos/settingsRepo.js");

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

  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'modelAliases'`))
    out.modelAliases[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'customModels'`))
    out.customModels.push(parseJson(r.value));
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'mitmAlias'`))
    out.mitmAlias[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'cliToolSettings'`))
    out.cliToolSettings[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'cliToolPresets'`))
    out.cliToolPresets[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'pricing'`))
    out.pricing[r.key] = parseJson(r.value);

  return out;
}

export async function importDb(payload) {
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

  db.transaction(() => {
    // Wipe all tables (keep _meta)
    db.run(`DELETE FROM settings`);
    db.run(`DELETE FROM providerConnections`);
    db.run(`DELETE FROM providerNodes`);
    db.run(`DELETE FROM proxyPools`);
    db.run(`DELETE FROM apiKeys`);
    db.run(`DELETE FROM combos`);
    db.run(
      `DELETE FROM kv WHERE scope IN ('modelAliases', 'customModels', 'mitmAlias', 'cliToolSettings', 'cliToolPresets', 'pricing')`,
    );

    // Settings
    if (payload.settings) {
      db.run(
        `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
        [stringifyJson(payload.settings)],
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
    for (const [a, m] of Object.entries(payload.modelAliases || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [
        a,
        stringifyJson(m),
      ]);
    }
    for (const m of payload.customModels || []) {
      const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
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
  });

  return await exportDb();
}

// Eager init helper (optional)
export async function initDb() {
  await getAdapter();
}
