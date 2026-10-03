// Migration registry. Each migration: { version, name, up(db) }, versions
// unique and increasing. `_meta.schemaVersion` holds the last one applied.
//
// Pattern for a schema change:
// - 001 is the frozen v1.0.0 baseline. Never edit it or any shipped migration.
// - Add `NNN-<slug>.js`, register it below, and update TABLES in ../schema.js
//   to the new shape (a test checks the chain produces exactly TABLES).
// - Make `up()` idempotent with ./helpers.js (tableHasColumn, indexExists,
//   rebuildTable, backfill): a restored or hand-edited DB may already have it.
// - The runner backs the DB up before any pending migration, runs each one in a
//   transaction with its version stamp and foreign keys off, and requires
//   `PRAGMA foreign_key_check` to pass, so a throw leaves the DB untouched.
// - Use rebuildTable for what ADD COLUMN can't do (UNIQUE, PRIMARY KEY, CHECK,
//   foreign keys, type changes, dropped columns).
import m001 from "./001-initial.js";
import m002 from "./002-cursor-refresh-backfill.js";
import m003 from "./003-pin-saml-issuer.js";
import m004 from "./004-identity-tenancy.js";
import m005 from "./005-connection-ownership.js";

export const MIGRATIONS = [m001, m002, m003, m004, m005].sort((a, b) => a.version - b.version);

for (let i = 1; i < MIGRATIONS.length; i++) {
  if (MIGRATIONS[i].version === MIGRATIONS[i - 1].version) {
    throw new Error(`[DB] duplicate migration version ${MIGRATIONS[i].version}`);
  }
}

export function latestVersion() {
  return MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;
}
