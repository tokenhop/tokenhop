// Persisted quota snapshot history (YAN-422). Additive: stores sampled
// quota window utilization (no secrets) so snapshots survive restarts, runway
// forecasts stay warm, and the Quota page can render 7-day sparklines.
// Deleted with the connection (FK cascade). Not exported in backups.
// Frozen: literal DDL, kept identical to TABLES.quotaHistory in ../schema.js.
import { tableExists } from "./helpers.js";

export default {
  version: 25,
  name: "quota-history",
  up(db) {
    if (!tableExists(db, "quotaHistory")) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS quotaHistory (id INTEGER PRIMARY KEY AUTOINCREMENT, connectionId TEXT NOT NULL REFERENCES providerConnections(id) ON DELETE CASCADE, provider TEXT NOT NULL, windowKind TEXT NOT NULL, quotaKey TEXT NOT NULL DEFAULT '', usedFraction REAL NOT NULL CHECK (usedFraction >= 0 AND usedFraction <= 1), resetsAt INTEGER NOT NULL DEFAULT 0, planTier TEXT, source TEXT NOT NULL DEFAULT 'probe', ts INTEGER NOT NULL)`,
      );
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_qh_conn_ts ON quotaHistory(connectionId, ts DESC)`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_qh_conn_window_ts ON quotaHistory(connectionId, windowKind, ts DESC)`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS idx_qh_ts ON quotaHistory(ts)`);
  },
};
