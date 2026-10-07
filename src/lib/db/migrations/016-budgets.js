// Budgets (YAN-372, ADR-0007). Additive and inert while the multi-user switch
// is off: nothing writes the table until the budget routes run.
// Frozen: literal DDL, kept identical to TABLES.budgets in ../schema.js.
import { tableExists } from "./helpers.js";

export default {
  version: 16,
  name: "budgets",
  up(db) {
    if (!tableExists(db, "budgets")) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS budgets (id TEXT PRIMARY KEY, workspaceId TEXT REFERENCES workspaces(id) ON DELETE CASCADE, scopeType TEXT NOT NULL CHECK (scopeType IN ('key', 'user', 'membership', 'workspace', 'grant')), scopeId TEXT NOT NULL, window TEXT NOT NULL CHECK (window IN ('day', 'week', 'month', 'total')), limitUsd REAL CHECK (limitUsd IS NULL OR limitUsd >= 0), limitTokens INTEGER CHECK (limitTokens IS NULL OR limitTokens >= 0), limitRequests INTEGER CHECK (limitRequests IS NULL OR limitRequests >= 0), softLimitPct INTEGER CHECK (softLimitPct IS NULL OR (softLimitPct BETWEEN 1 AND 100)), resetAt TEXT, createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL, createdAt TEXT NOT NULL, CHECK (limitUsd IS NOT NULL OR limitTokens IS NOT NULL OR limitRequests IS NOT NULL), CHECK ((scopeType = 'user') = (workspaceId IS NULL)))`,
      );
    }
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_scope_window ON budgets(scopeType, scopeId, window)`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS idx_budgets_ws ON budgets(workspaceId)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_uh_grant_ts ON usageHistory(grantId, timestamp DESC)`);
  },
};
