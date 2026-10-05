// Audit log of security and administrative events (YAN-367, ADR-0002).
// Additive and inert: no backfill, no FK on workspaceId (it is an optional
// filter, not ownership — login/host events have none, and rows must survive
// workspace deletion). Frozen: literal DDL, kept identical to
// TABLES.auditEvents in ../schema.js.
import { tableExists } from "./helpers.js";

export default {
  version: 10,
  name: "audit-events",
  up(db) {
    if (!tableExists(db, "auditEvents")) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS auditEvents (id TEXT PRIMARY KEY, ts TEXT NOT NULL, actorUserId TEXT, actorApiKeyId TEXT, via TEXT, ip TEXT, workspaceId TEXT, action TEXT NOT NULL, targetType TEXT, targetId TEXT, before TEXT, after TEXT, result TEXT)`,
      );
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_ws_ts ON auditEvents(workspaceId, ts)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_actor_ts ON auditEvents(actorUserId, ts)`);
  },
};
