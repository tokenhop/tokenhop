// Tenancy classification of every table and kv scope (YAN-354, ADR-0001).
// SQLite has no row-level security, so tests/unit/tenancy-guard.test.js fails
// on any table or kv scope missing here, and on any repo function that reads a
// `scoped` table or kv scope without taking `ctx` first (or ending in
// `Unscoped`). Pure data: nothing reads it at runtime yet.
//
// Classes:
// - scoped: rows belong to a workspace or user; `scopeColumn` is the filter.
// - instance: one per instance, managed by admins only.
// - system: internal bookkeeping, never user data.
// - usage-attribution: usage rows; scoped views arrive with `issue`.
// - pending-scope: owned data still global today; `issue` scopes it. This list
//   must shrink to zero by M3.

export const TABLE_CLASSES = {
  _meta: { class: "system" },
  settings: {
    class: "instance",
    note: "instance row; split by YAN-362 into instance + workspace + user",
  },
  workspaceSettings: { class: "scoped", scopeColumn: "workspaceId" },
  userPreferences: { class: "scoped", scopeColumn: "userId" },
  providerConnections: {
    class: "scoped",
    scopeColumn: "workspaceId",
    note: "NULL until the owner bootstrap adopts rows into Default (YAN-361)",
  },
  providerNodes: { class: "scoped", scopeColumn: "workspaceId" },
  proxyPools: { class: "instance" },
  apiKeys: { class: "pending-scope", issue: "YAN-363" },
  combos: {
    class: "scoped",
    scopeColumn: "workspaceId",
    note: "NULL until owner bootstrap (YAN-364)",
  },
  kv: { class: "pending-scope", note: "classified per scope in KV_SCOPE_CLASSES" },
  usageHistory: { class: "usage-attribution", issue: "YAN-370" },
  usageDaily: { class: "usage-attribution", issue: "YAN-370" },
  requestDetails: { class: "usage-attribution", issue: "YAN-370" },
  users: { class: "instance", note: "admin-managed; self reads go through getUser(ctx)" },
  identities: { class: "scoped", scopeColumn: "userId" },
  workspaces: { class: "scoped", scopeColumn: "id", note: "visible through memberships" },
  memberships: { class: "scoped", scopeColumn: "workspaceId" },
};

// Workspace kv scopes take the `ws:<workspaceId>/` key prefix when scoped.
export const KV_SCOPE_CLASSES = {
  modelAliases: { class: "scoped", scopeColumn: "key", note: "ws:<workspaceId>/ key prefix" },
  customModels: { class: "scoped", scopeColumn: "key", note: "ws:<workspaceId>/ key prefix" },
  mitmAlias: { class: "instance", note: "host MITM tooling (cli-tools routes)" },
  disabledModels: { class: "scoped", scopeColumn: "key", note: "ws:<workspaceId>/ key prefix" },
  cliToolSettings: { class: "pending-scope", issue: "YAN-374" },
  cliToolPresets: { class: "pending-scope", issue: "YAN-374" },
  pricing: { class: "instance" },
  gemini_thought_signatures: { class: "system", note: "upstream signature cache" },
};

/**
 * Names missing from the registry.
 * @param {{ tables?: string[], kvScopes?: string[] }} found
 */
export function findUnclassified({ tables = [], kvScopes = [] } = {}) {
  return {
    tables: tables.filter((t) => !Object.hasOwn(TABLE_CLASSES, t)),
    kvScopes: kvScopes.filter((s) => !Object.hasOwn(KV_SCOPE_CLASSES, s)),
  };
}
