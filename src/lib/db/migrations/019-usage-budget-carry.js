// Usage-history retention carry (YAN-424). Additive and inert until the
// retention job (opt-in, usageHistoryRetentionDays > 0) prunes history.
// Frozen: literal DDL, kept identical to TABLES.usageBudgetCarry in ../schema.js.
import { tableExists } from "./helpers.js";

export default {
  version: 19,
  name: "usage-budget-carry",
  up(db) {
    if (!tableExists(db, "usageBudgetCarry")) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS usageBudgetCarry (day TEXT NOT NULL, workspaceId TEXT NOT NULL DEFAULT '', userId TEXT NOT NULL DEFAULT '', apiKeyId TEXT NOT NULL DEFAULT '', grantId TEXT NOT NULL DEFAULT '', usd REAL NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, notionalUsd REAL NOT NULL DEFAULT 0, PRIMARY KEY (day, workspaceId, userId, apiKeyId, grantId))`,
      );
    }
    // spentFor filters one scope column + day range (membership: workspaceId + userId).
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ubc_ws_day ON usageBudgetCarry(workspaceId, day)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ubc_user_day ON usageBudgetCarry(userId, day)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ubc_key_day ON usageBudgetCarry(apiKeyId, day)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ubc_grant_day ON usageBudgetCarry(grantId, day)`);
  },
};
