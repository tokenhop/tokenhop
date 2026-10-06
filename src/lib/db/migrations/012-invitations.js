// Workspace invitations (YAN-360). Additive and inert while the multi-user
// switch is off: nothing writes the table until invite routes run. Only the
// SHA-256 of the token is stored; state is derived from the timestamps.
// Frozen: literal DDL, kept identical to TABLES.invitations in ../schema.js.
import { tableExists } from "./helpers.js";

export default {
  version: 12,
  name: "invitations",
  up(db) {
    if (!tableExists(db, "invitations")) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('manager', 'member', 'viewer')), email TEXT, tokenHash TEXT NOT NULL UNIQUE, createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL, createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL, consumedAt TEXT, consumedByUserId TEXT REFERENCES users(id) ON DELETE SET NULL, revokedAt TEXT)`,
      );
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_invitations_ws ON invitations(workspaceId, createdAt, id)`,
    );
  },
};
