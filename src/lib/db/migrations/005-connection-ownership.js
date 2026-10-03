// Users & teams (YAN-361, ADR-0001): workspace ownership of provider connections
// and nodes. Additive and inert while the switch is off: nullable columns,
// indexes leading with workspaceId. The owner bootstrap adopts ownerless rows
// into the Default workspace (adoptOwnerlessUnscoped), so NULL only exists
// before the switch is first turned on. Frozen: literal DDL.
import { indexExists, tableHasColumn } from "./helpers.js";

const COLUMNS = [
  ["workspaceId", "TEXT REFERENCES workspaces(id) ON DELETE CASCADE"],
  ["createdByUserId", "TEXT REFERENCES users(id) ON DELETE SET NULL"],
];
const INDEXES = {
  idx_pc_ws_provider:
    "CREATE INDEX idx_pc_ws_provider ON providerConnections(workspaceId, provider)",
  idx_pn_ws_type: "CREATE INDEX idx_pn_ws_type ON providerNodes(workspaceId, type)",
};

export default {
  version: 5,
  name: "connection-ownership",
  up(db) {
    for (const table of ["providerConnections", "providerNodes"]) {
      for (const [col, def] of COLUMNS) {
        if (!tableHasColumn(db, table, col))
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      }
    }
    for (const [name, sql] of Object.entries(INDEXES)) if (!indexExists(db, name)) db.exec(sql);
  },
};
