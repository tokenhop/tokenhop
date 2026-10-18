// Device sessions (YAN-751). Unconditional and inert while the multi-user
// switch is off: nothing writes or reads the table until the switch is on.
// Skipping the DDL would still stamp v18, so a later switch-on would never
// re-run it; every mint, validation, route and sweep is gated instead.
// Frozen: literal DDL, kept identical to TABLES.sessions in ../schema.js.
import { tableExists } from "./helpers.js";

export default {
  version: 18,
  name: "device-sessions",
  up(db) {
    if (!tableExists(db, "sessions")) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, sv INTEGER NOT NULL, amr TEXT, userAgent TEXT, ip TEXT, createdAt TEXT NOT NULL, lastSeenAt TEXT, expiresAt TEXT NOT NULL, revokedAt TEXT)`,
      );
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_user_exp ON sessions(userId, expiresAt)`);
  },
};
