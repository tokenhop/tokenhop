export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 30000000;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`;

// Declarative current schema: what the migration chain in ./migrations/ must
// produce (a test checks the two match). syncSchemaFromTables() also adds
// missing tables/columns/indexes from it after the chain, as a safety net.
// Every change here needs a matching migration — see ./migrations/index.js.
export const TABLES = {
  _meta: {
    columns: {
      key: "TEXT PRIMARY KEY",
      value: "TEXT NOT NULL",
    },
  },
  settings: {
    columns: {
      id: "INTEGER PRIMARY KEY CHECK (id = 1)",
      data: "TEXT NOT NULL",
    },
  },
  providerConnections: {
    columns: {
      id: "TEXT PRIMARY KEY",
      provider: "TEXT NOT NULL",
      authType: "TEXT NOT NULL",
      name: "TEXT",
      email: "TEXT",
      priority: "INTEGER",
      isActive: "INTEGER DEFAULT 1",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
      // YAN-361 (migration 005): owning workspace and creator.
      workspaceId: "TEXT REFERENCES workspaces(id) ON DELETE CASCADE",
      createdByUserId: "TEXT REFERENCES users(id) ON DELETE SET NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider)",
      "CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority)",
      "CREATE INDEX IF NOT EXISTS idx_pc_ws_provider ON providerConnections(workspaceId, provider)",
    ],
  },
  providerNodes: {
    columns: {
      id: "TEXT PRIMARY KEY",
      type: "TEXT",
      name: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
      workspaceId: "TEXT REFERENCES workspaces(id) ON DELETE CASCADE",
      createdByUserId: "TEXT REFERENCES users(id) ON DELETE SET NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pn_type ON providerNodes(type)",
      "CREATE INDEX IF NOT EXISTS idx_pn_ws_type ON providerNodes(workspaceId, type)",
    ],
  },
  proxyPools: {
    columns: {
      id: "TEXT PRIMARY KEY",
      isActive: "INTEGER DEFAULT 1",
      testStatus: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pp_active ON proxyPools(isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pp_status ON proxyPools(testStatus)",
    ],
  },
  apiKeys: {
    columns: {
      id: "TEXT PRIMARY KEY",
      key: "TEXT UNIQUE NOT NULL",
      name: "TEXT",
      machineId: "TEXT",
      isActive: "INTEGER DEFAULT 1",
      createdAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)"],
  },
  combos: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT NOT NULL",
      kind: "TEXT",
      models: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
      sortOrder: "INTEGER",
      // YAN-364 (migration 009): UNIQUE(workspaceId,name); NULL workspaceId until bootstrap adopts into Default
      workspaceId: "TEXT REFERENCES workspaces(id) ON DELETE CASCADE",
      createdByUserId: "TEXT REFERENCES users(id) ON DELETE SET NULL",
    },
    constraints: ["UNIQUE (workspaceId, name)"],
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_combo_ws ON combos(workspaceId)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_combo_name_legacy ON combos(name) WHERE workspaceId IS NULL",
    ],
  },
  kv: {
    columns: {
      scope: "TEXT NOT NULL",
      key: "TEXT NOT NULL",
      value: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (scope, key)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope)"],
  },
  usageHistory: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      apiKey: "TEXT",
      endpoint: "TEXT",
      promptTokens: "INTEGER DEFAULT 0",
      completionTokens: "INTEGER DEFAULT 0",
      cost: "REAL DEFAULT 0",
      status: "TEXT",
      tokens: "TEXT",
      meta: "TEXT",
      // YAN-370 (migration 014): attribution columns. `apiKey` is NULL from 014
      // on; the identity lives in apiKeyId. NULL workspace/user until bootstrap.
      workspaceId: "TEXT REFERENCES workspaces(id) ON DELETE SET NULL",
      userId: "TEXT REFERENCES users(id) ON DELETE SET NULL",
      apiKeyId: "TEXT",
      grantId: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_uh_ts ON usageHistory(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_uh_provider ON usageHistory(provider)",
      "CREATE INDEX IF NOT EXISTS idx_uh_model ON usageHistory(model)",
      "CREATE INDEX IF NOT EXISTS idx_uh_conn ON usageHistory(connectionId)",
      "CREATE INDEX IF NOT EXISTS idx_uh_ws_ts ON usageHistory(workspaceId, timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_uh_user_ts ON usageHistory(userId, timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_uh_key_ts ON usageHistory(apiKeyId, timestamp DESC)",
    ],
  },
  // YAN-370 (migration 014): daily rollup replacing the usageDaily blob. Null
  // dims are '' (SQLite NULLs are distinct in a composite primary key).
  usageRollup: {
    columns: {
      dateKey: "TEXT NOT NULL",
      workspaceId: "TEXT NOT NULL DEFAULT ''",
      userId: "TEXT NOT NULL DEFAULT ''",
      apiKeyId: "TEXT NOT NULL DEFAULT 'local-no-key'",
      provider: "TEXT NOT NULL DEFAULT ''",
      model: "TEXT NOT NULL DEFAULT ''",
      connectionId: "TEXT NOT NULL DEFAULT ''",
      endpoint: "TEXT NOT NULL DEFAULT ''",
      requests: "INTEGER NOT NULL DEFAULT 0",
      tokensIn: "INTEGER NOT NULL DEFAULT 0",
      tokensOut: "INTEGER NOT NULL DEFAULT 0",
      tokensCached: "INTEGER NOT NULL DEFAULT 0",
      cost: "REAL NOT NULL DEFAULT 0",
    },
    primaryKey:
      "PRIMARY KEY (dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_ur_ws_date ON usageRollup(workspaceId, dateKey)"],
  },
  requestDetails: {
    columns: {
      id: "TEXT PRIMARY KEY",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      status: "TEXT",
      data: "TEXT NOT NULL",
      workspaceId: "TEXT REFERENCES workspaces(id) ON DELETE SET NULL",
      userId: "TEXT REFERENCES users(id) ON DELETE SET NULL",
      apiKeyId: "TEXT",
      grantId: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rd_ts ON requestDetails(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rd_provider ON requestDetails(provider)",
      "CREATE INDEX IF NOT EXISTS idx_rd_model ON requestDetails(model)",
      "CREATE INDEX IF NOT EXISTS idx_rd_conn ON requestDetails(connectionId)",
      "CREATE INDEX IF NOT EXISTS idx_rd_ws_ts ON requestDetails(workspaceId, timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rd_user_ts ON requestDetails(userId, timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rd_key_ts ON requestDetails(apiKeyId, timestamp DESC)",
    ],
  },
  // Users & teams identity and tenancy (migration 004, YAN-353).
  users: {
    columns: {
      id: "TEXT PRIMARY KEY",
      email: "TEXT UNIQUE COLLATE NOCASE",
      username: "TEXT UNIQUE COLLATE NOCASE",
      displayName: "TEXT",
      instanceRole: "TEXT NOT NULL CHECK (instanceRole IN ('owner', 'admin', 'user', 'pending'))",
      status: "TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled'))",
      passwordHash: "TEXT",
      sessionVersion: "INTEGER NOT NULL DEFAULT 1",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
      lastLoginAt: "TEXT",
      mustChangePassword: "INTEGER NOT NULL DEFAULT 0 CHECK (mustChangePassword IN (0, 1))",
      instanceRoleSource: "TEXT CHECK (instanceRoleSource IN ('idp'))",
    },
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_owner ON users(instanceRole) WHERE instanceRole = 'owner'",
    ],
  },
  identities: {
    columns: {
      id: "TEXT PRIMARY KEY",
      userId: "TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE",
      provider: "TEXT NOT NULL CHECK (provider IN ('password', 'oidc', 'saml', 'header'))",
      issuer: "TEXT NOT NULL DEFAULT ''",
      subject: "TEXT NOT NULL",
      emailAtLink: "TEXT",
      createdAt: "TEXT NOT NULL",
      lastLoginAt: "TEXT",
    },
    constraints: ["UNIQUE (provider, issuer, subject)"],
    indexes: ["CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(userId)"],
  },
  workspaces: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT NOT NULL",
      kind: "TEXT NOT NULL CHECK (kind IN ('personal', 'shared'))",
      createdBy: "TEXT REFERENCES users(id) ON DELETE SET NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_personal ON workspaces(createdBy) WHERE kind = 'personal'",
    ],
  },
  memberships: {
    columns: {
      workspaceId: "TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE",
      userId: "TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE",
      role: "TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'member', 'viewer'))",
      source: "TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'invite', 'idp'))",
      createdAt: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (workspaceId, userId)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(userId)"],
  },
  // Settings split (migration 008, YAN-362): explicit overrides only; the
  // `settings` blob remains the instance row and default.
  workspaceSettings: {
    columns: {
      workspaceId: "TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE",
      data: "TEXT NOT NULL DEFAULT '{}'",
      updatedAt: "TEXT",
    },
  },
  userPreferences: {
    columns: {
      userId: "TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE",
      data: "TEXT NOT NULL DEFAULT '{}'",
      updatedAt: "TEXT",
    },
  },
  // Audit log (migration 010, YAN-367). No FKs: events outlive users/workspaces.
  auditEvents: {
    columns: {
      id: "TEXT PRIMARY KEY",
      ts: "TEXT NOT NULL",
      actorUserId: "TEXT",
      actorApiKeyId: "TEXT",
      via: "TEXT",
      ip: "TEXT",
      workspaceId: "TEXT",
      action: "TEXT NOT NULL",
      targetType: "TEXT",
      targetId: "TEXT",
      before: "TEXT",
      after: "TEXT",
      result: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_audit_ws_ts ON auditEvents(workspaceId, ts)",
      "CREATE INDEX IF NOT EXISTS idx_audit_actor_ts ON auditEvents(actorUserId, ts)",
    ],
  },
  // Invitations (migration 012, YAN-360). Token stored as SHA-256 hex only.
  invitations: {
    columns: {
      id: "TEXT PRIMARY KEY",
      workspaceId: "TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE",
      role: "TEXT NOT NULL CHECK (role IN ('manager', 'member', 'viewer'))",
      email: "TEXT",
      tokenHash: "TEXT NOT NULL UNIQUE",
      createdByUserId: "TEXT REFERENCES users(id) ON DELETE SET NULL",
      createdAt: "TEXT NOT NULL",
      expiresAt: "TEXT NOT NULL",
      consumedAt: "TEXT",
      consumedByUserId: "TEXT REFERENCES users(id) ON DELETE SET NULL",
      revokedAt: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_invitations_ws ON invitations(workspaceId, createdAt, id)",
    ],
  },
  // Workspace DEKs (migration 013, YAN-365). One wrapped data key per owning
  // workspace; the table stays empty until credential encryption activates.
  workspaceKeys: {
    columns: {
      workspaceId: "TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE",
      kid: "TEXT NOT NULL",
      wrappedDek: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
    },
  },
  // Connection grants (migration 015, YAN-369, ADR-0006). Exactly one of
  // workspaceId/userId names the grantee. budgetId is unwired (no FK; YAN-372).
  connectionGrants: {
    columns: {
      id: "TEXT PRIMARY KEY",
      connectionId: "TEXT NOT NULL REFERENCES providerConnections(id) ON DELETE CASCADE",
      workspaceId: "TEXT REFERENCES workspaces(id) ON DELETE CASCADE",
      userId: "TEXT REFERENCES users(id) ON DELETE CASCADE",
      allowedModels: "TEXT",
      rpm: "INTEGER",
      tpm: "INTEGER",
      budgetId: "TEXT",
      createdByUserId: "TEXT REFERENCES users(id) ON DELETE SET NULL",
      tosAcknowledgedAt: "INTEGER",
      createdAt: "INTEGER NOT NULL",
      revokedAt: "INTEGER",
    },
    constraints: ["CHECK ((workspaceId IS NULL) <> (userId IS NULL))"],
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_cg_conn ON connectionGrants(connectionId)",
      "CREATE INDEX IF NOT EXISTS idx_cg_ws ON connectionGrants(workspaceId)",
      "CREATE INDEX IF NOT EXISTS idx_cg_user ON connectionGrants(userId)",
      // One active grant per (connection, grantee): no ambiguous limits.
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_cg_active_ws ON connectionGrants(connectionId, workspaceId) WHERE revokedAt IS NULL AND workspaceId IS NOT NULL",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_cg_active_user ON connectionGrants(connectionId, userId) WHERE revokedAt IS NULL AND userId IS NOT NULL",
    ],
  },
};

// YAN-363: the final hashed apiKeys shape, INERT here. Nothing reads it at
// runtime yet — the (later) switch-on migration rebuilds apiKeys into this
// definition and stamps _meta.apiKeysHashedVersion/apiKeysHashKid; until then
// TABLES.apiKeys above stays the legacy raw-key table, byte-identical.
// Hash-only (no raw `key`, no budgetId); user/workspace keys cascade,
// creator provenance SET NULL only, and usage attribution lives in
// usageHistory with no FK back to apiKeys (rows are tombstoned, not deleted).
export const HASHED_API_KEYS_TABLE = {
  columns: {
    id: "TEXT PRIMARY KEY",
    workspaceId: "TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE",
    userId: "TEXT REFERENCES users(id) ON DELETE CASCADE",
    createdByUserId: "TEXT REFERENCES users(id) ON DELETE SET NULL",
    keyHash: "TEXT UNIQUE NOT NULL",
    hashKid: "TEXT NOT NULL",
    prefix: "TEXT NOT NULL",
    name: "TEXT",
    machineId: "TEXT",
    legacy: "INTEGER NOT NULL DEFAULT 0",
    isActive: "INTEGER NOT NULL DEFAULT 1",
    revokedAt: "TEXT",
    allowedModels: "TEXT NOT NULL DEFAULT '[]'",
    allowedCombos: "TEXT NOT NULL DEFAULT '[]'",
    expiresAt: "TEXT",
    lastUsedAt: "TEXT",
    createdAt: "TEXT NOT NULL",
  },
  indexes: [
    "CREATE INDEX IF NOT EXISTS idx_ak_ws ON apiKeys(workspaceId)",
    "CREATE INDEX IF NOT EXISTS idx_ak_ws_user ON apiKeys(workspaceId, userId)",
    "CREATE INDEX IF NOT EXISTS idx_ak_kid ON apiKeys(hashKid)",
  ],
};

export function buildCreateTableSql(name, def) {
  const cols = Object.entries(def.columns).map(([k, v]) => `${k} ${v}`);
  if (def.primaryKey) cols.push(def.primaryKey);
  // Table-level constraints, e.g. "UNIQUE (workspaceId, name)" or a FOREIGN KEY.
  for (const c of def.constraints || []) cols.push(c);
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols.join(", ")})`;
}
