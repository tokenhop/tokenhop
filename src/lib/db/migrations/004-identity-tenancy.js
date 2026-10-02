// Users & teams (YAN-353, ADR-0001/0003): identity and tenancy tables. Frozen:
// literal DDL, never derived from TABLES. IF NOT EXISTS keeps reruns and
// restored DBs a no-op. Nothing reads these tables while the switch is off.
const SQL = [
  "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE COLLATE NOCASE, username TEXT UNIQUE COLLATE NOCASE, displayName TEXT, instanceRole TEXT NOT NULL CHECK (instanceRole IN ('owner', 'admin', 'user', 'pending')), status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')), passwordHash TEXT, sessionVersion INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, lastLoginAt TEXT)",
  // At most one owner, enforced by SQLite as well as the repo.
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_owner ON users(instanceRole) WHERE instanceRole = 'owner'",
  // issuer is NOT NULL: SQLite treats NULLs as distinct inside UNIQUE.
  "CREATE TABLE IF NOT EXISTS identities (id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, provider TEXT NOT NULL CHECK (provider IN ('password', 'oidc', 'saml', 'header')), issuer TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL, emailAtLink TEXT, createdAt TEXT NOT NULL, lastLoginAt TEXT, UNIQUE (provider, issuer, subject))",
  "CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(userId)",
  "CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('personal', 'shared')), createdBy TEXT REFERENCES users(id) ON DELETE SET NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)",
  // One personal workspace per user.
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_personal ON workspaces(createdBy) WHERE kind = 'personal'",
  "CREATE TABLE IF NOT EXISTS memberships (workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'member', 'viewer')), source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'invite', 'idp')), createdAt TEXT NOT NULL, PRIMARY KEY (workspaceId, userId))",
  "CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(userId)",
];

export default {
  version: 4,
  name: "identity-tenancy",
  up(db) {
    for (const sql of SQL) db.exec(sql);
  },
};
