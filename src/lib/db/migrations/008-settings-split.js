// Settings split (YAN-362, ADR-0001): per-workspace overrides and per-user
// preferences. Additive and inert while the switch is off. The `settings`
// blob stays the instance row (and default). Frozen: literal DDL.
export default {
  version: 8,
  name: "settings-split",
  up(db) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS workspaceSettings (workspaceId TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE, data TEXT NOT NULL DEFAULT '{}', updatedAt TEXT)`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS userPreferences (userId TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL DEFAULT '{}', updatedAt TEXT)`,
    );
  },
};
