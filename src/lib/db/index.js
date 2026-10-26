// Public API barrel — all DB functions
import { getAdapter } from "./driver.js";
import { TransferError } from "./helpers/gatewayKeyTransfer.js";

export { importDb, importDbStream } from "./snapshot/importSnapshot.js";

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
  mutateProviderConnectionUnscoped,
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
export { adoptOwnerlessUnscoped, setMultiUserEnabledUnscoped } from "./repos/ownership.js";

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
export {
  getUsageStats,
  getChartData,
  streamRequestRows,
  streamDailyRows,
} from "./repos/usageStatsRepo.js";
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

// Export/import full DB (YAN-364 legacy single-user shape; YAN-1013 bounded-memory
// staging lives in ./snapshot/).
export { exportDb, exportDbToFile } from "./snapshot/exportSnapshot.js";

export { TransferError };

// Eager init helper (optional)
export async function initDb() {
  await getAdapter();
}
