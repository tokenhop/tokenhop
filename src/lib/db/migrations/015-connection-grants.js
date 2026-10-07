// Connection grants (YAN-369, ADR-0006). Additive and inert while the multi-user
// switch is off: nothing writes the table until grant routes run.
// Frozen: literal DDL, kept identical to TABLES.connectionGrants in ../schema.js.
import { tableExists } from "./helpers.js";

export default {
  version: 15,
  name: "connection-grants",
  up(db) {
    if (!tableExists(db, "connectionGrants")) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS connectionGrants (id TEXT PRIMARY KEY, connectionId TEXT NOT NULL REFERENCES providerConnections(id) ON DELETE CASCADE, workspaceId TEXT REFERENCES workspaces(id) ON DELETE CASCADE, userId TEXT REFERENCES users(id) ON DELETE CASCADE, allowedModels TEXT, rpm INTEGER, tpm INTEGER, budgetId TEXT, createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL, tosAcknowledgedAt INTEGER, createdAt INTEGER NOT NULL, revokedAt INTEGER, CHECK ((workspaceId IS NULL) <> (userId IS NULL)))`,
      );
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cg_conn ON connectionGrants(connectionId)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cg_ws ON connectionGrants(workspaceId)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cg_user ON connectionGrants(userId)`);
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_cg_active_ws ON connectionGrants(connectionId, workspaceId) WHERE revokedAt IS NULL AND workspaceId IS NOT NULL`,
    );
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_cg_active_user ON connectionGrants(connectionId, userId) WHERE revokedAt IS NULL AND userId IS NOT NULL`,
    );
  },
};
