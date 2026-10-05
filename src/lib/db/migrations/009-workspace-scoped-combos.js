// Workspace-scoped combos (YAN-364, ADR-0001): rebuild `combos` so names are
// unique per workspace instead of instance-wide, and add the owning workspace
// and creator columns. Additive and inert while the switch is off: NULL
// workspaceId until the owner bootstrap adopts rows into the Default
// workspace — no backfill here (no Default workspace exists at DDL time).
// SQLite treats NULLs as distinct in the table-level UNIQUE, so the partial
// unique index keeps names unique among pre-bootstrap (NULL) rows, matching
// today's name UNIQUE NOT NULL. The rebuild drops `idx_combo_name` with the
// old table. Frozen: literal DDL.
import { rebuildTable, tableHasColumn } from "./helpers.js";

const COMBOS = {
  columns: {
    id: "TEXT PRIMARY KEY",
    name: "TEXT NOT NULL",
    kind: "TEXT",
    models: "TEXT NOT NULL",
    createdAt: "TEXT NOT NULL",
    updatedAt: "TEXT NOT NULL",
    sortOrder: "INTEGER",
    workspaceId: "TEXT REFERENCES workspaces(id) ON DELETE CASCADE",
    createdByUserId: "TEXT REFERENCES users(id) ON DELETE SET NULL",
  },
  constraints: ["UNIQUE (workspaceId, name)"],
  indexes: [
    "CREATE INDEX IF NOT EXISTS idx_combo_ws ON combos(workspaceId)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_combo_name_legacy ON combos(name) WHERE workspaceId IS NULL",
  ],
};

export default {
  version: 9,
  name: "workspace-scoped-combos",
  up(db) {
    if (tableHasColumn(db, "combos", "workspaceId")) return;
    rebuildTable(db, "combos", COMBOS);
  },
};
