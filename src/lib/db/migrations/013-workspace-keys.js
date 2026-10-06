// Workspace DEK table (YAN-365). Additive and inert while the multi-user
// switch is off: the schema exists but no encryption activates, no DEKs are
// generated and no rows are written — activation owns row creation later.
// Frozen: literal DDL, kept identical to TABLES.workspaceKeys in ../schema.js.
import { tableExists } from "./helpers.js";

export default {
  version: 13,
  name: "workspace-keys",
  up(db) {
    if (!tableExists(db, "workspaceKeys")) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS workspaceKeys (workspaceId TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE, kid TEXT NOT NULL, wrappedDek TEXT NOT NULL, createdAt TEXT NOT NULL)`,
      );
    }
  },
};
