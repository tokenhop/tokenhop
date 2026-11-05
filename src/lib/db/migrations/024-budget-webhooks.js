// Budget webhooks (YAN-1831). Additive: one optional webhook per workspace; `data` holds the
// signing secret as a D10 credential leaf ({"secret": <plaintext|envelope>}). Deleted with the
// workspace (FK). Not exported; a snapshot restore removes it (cascade from workspaces).
// Frozen: literal DDL, kept identical to TABLES.budgetWebhooks in ../schema.js.
import { tableExists } from "./helpers.js";

export default {
  version: 24,
  name: "budget-webhooks",
  up(db) {
    if (!tableExists(db, "budgetWebhooks")) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS budgetWebhooks (id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE, url TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL, createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
      );
    }
  },
};
