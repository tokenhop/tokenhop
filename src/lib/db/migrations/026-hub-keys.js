// Usage hub management keys (YAN-2019). Additive: read-only keys T3 Code sends
// to the CLIProxyAPI-compatible hub routes. Only a SHA-256 hash of the key is
// stored, plus a display prefix. Instance-level (owner/admin managed); no FK
// on the creator beyond SET NULL so keys outlive a removed admin.
// Frozen: literal DDL, kept identical to TABLES.hubKeys in ../schema.js.
import { tableExists } from "./helpers.js";

export default {
  version: 26,
  name: "hub-keys",
  up(db) {
    if (!tableExists(db, "hubKeys")) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS hubKeys (id TEXT PRIMARY KEY, keyHash TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL, name TEXT, createdByUserId TEXT REFERENCES users(id) ON DELETE SET NULL, createdAt TEXT NOT NULL, lastUsedAt TEXT, revokedAt TEXT)`,
      );
    }
  },
};
