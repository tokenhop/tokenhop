// Public API barrel — all DB functions
import { getAdapter } from "./driver.js";
import { parseJson } from "./helpers/jsonCol.js";
import { latestVersion } from "./migrations/index.js";
import { defaultWorkspaceIdUnscoped } from "./repos/ownership.js";
import { makeInstancePortable } from "./helpers/instancePortable.js";
import {
  TransferError,
  exportGatewayKeySnapshot,
  gatewayKeyStorageSnapshot,
} from "./helpers/gatewayKeyTransfer.js";
import { isLegacyDefaultKey, stripWsKey } from "./snapshot/legacyKeys.js";

export { importDb } from "./snapshot/importSnapshot.js";

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
  mutateBillingLockUnscoped,
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
export { getRollupUsageTotals, getRollupRangeTotals } from "./repos/usageRollupTotals.js";
export { getSavingsTotals } from "./repos/usageSavingsTotals.js";
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
  unlinkSsoIdentityGuarded,
  findIdentityUnscoped,
  listIdentitiesUnscoped,
  linkIdentityUnscoped,
} from "./repos/identitiesRepo.js";
export {
  createSessionUnscoped,
  getSessionForValidationUnscoped,
  touchSessionUnscoped,
  rebindSessionUnscoped,
  listSessions,
  revokeSession,
  revokeSessionUnscoped,
  pruneExpiredSessionsUnscoped,
  invalidateSessionCache,
} from "./repos/sessionsRepo.js"; // YAN-751
export {
  listWorkspaces,
  getWorkspace,
  listWorkspacesUnscoped,
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
  getMembershipRoleUnscoped,
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

// Export/import full DB
export async function exportDb({ passphrase } = {}) {
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
    disabledModels: {},
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
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'disabledModels'`)) {
    if (!isLegacyDefaultKey(r.key, defaultWs)) continue;
    const ids = parseJson(r.value, []);
    out.disabledModels[stripWsKey(r.key)] = Array.isArray(ids) ? ids : [];
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
  const { isMultiUserEnabled } = await import("@/lib/users/featureSwitch.js");
  const multiUserTransfer = await isMultiUserEnabled();
  const snapshot = exportGatewayKeySnapshot(db, out, gatewayKeyStorageSnapshot(db), {
    multiUserTransfer,
  });
  if (!multiUserTransfer && passphrase !== undefined) {
    throw new TransferError(
      "TRANSFER_PORTABLE_UNSUPPORTED",
      "Passphrase exports require Users & teams",
    );
  }
  if (passphrase === undefined) return snapshot;
  if (!snapshot.credentialEncryption) {
    throw new TransferError(
      "TRANSFER_PORTABLE_UNSUPPORTED",
      "Passphrase-protected exports need encrypted credentials",
    );
  }
  const { loadMasterKey } = await import("@/lib/security/masterKey.js");
  const root = await loadMasterKey();
  try {
    if (root.kid !== snapshot.credentialEncryption.kekKid) {
      throw new TransferError(
        "TRANSFER_ROOT_MISMATCH",
        "Trusted master key does not match this instance's root",
      );
    }
    return await makeInstancePortable(snapshot, { passphrase, masterKey: root.key });
  } finally {
    root.key.fill(0);
  }
}

export { TransferError };

// Eager init helper (optional)
export async function initDb() {
  await getAdapter();
}
