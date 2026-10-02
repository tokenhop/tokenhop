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
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider)",
      "CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority)",
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
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_pn_type ON providerNodes(type)"],
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
      name: "TEXT UNIQUE NOT NULL",
      kind: "TEXT",
      models: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_combo_name ON combos(name)"],
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
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_uh_ts ON usageHistory(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_uh_provider ON usageHistory(provider)",
      "CREATE INDEX IF NOT EXISTS idx_uh_model ON usageHistory(model)",
      "CREATE INDEX IF NOT EXISTS idx_uh_conn ON usageHistory(connectionId)",
    ],
  },
  usageDaily: {
    columns: {
      dateKey: "TEXT PRIMARY KEY",
      data: "TEXT NOT NULL",
    },
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
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rd_ts ON requestDetails(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rd_provider ON requestDetails(provider)",
      "CREATE INDEX IF NOT EXISTS idx_rd_model ON requestDetails(model)",
      "CREATE INDEX IF NOT EXISTS idx_rd_conn ON requestDetails(connectionId)",
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
};

export function buildCreateTableSql(name, def) {
  const cols = Object.entries(def.columns).map(([k, v]) => `${k} ${v}`);
  if (def.primaryKey) cols.push(def.primaryKey);
  // Table-level constraints, e.g. "UNIQUE (workspaceId, name)" or a FOREIGN KEY.
  for (const c of def.constraints || []) cols.push(c);
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols.join(", ")})`;
}
