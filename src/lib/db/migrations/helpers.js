// Helpers for 002+ migrations. Every migration must be idempotent: a fresh DB
// runs the whole chain, and a crash between `up()` and the version stamp can't
// happen (same transaction), but re-runs after a restore can.
import { buildCreateTableSql } from "../schema.js";

export function tableExists(db, table) {
  return !!db.get(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]);
}

export function tableHasColumn(db, table, column) {
  return db.all(`PRAGMA table_info(${table})`).some((c) => c.name === column);
}

export function indexExists(db, index) {
  return !!db.get(`SELECT 1 AS x FROM sqlite_master WHERE type = 'index' AND name = ?`, [index]);
}

// Run an UPDATE/INSERT/DELETE and log how many rows it touched.
export function backfill(db, sql, params = []) {
  const { changes } = db.run(sql, params);
  console.log(
    `[DB][migrate] backfill: ${changes} row(s) — ${sql.replace(/\s+/g, " ").slice(0, 80)}`,
  );
  return changes;
}

// SQLite's 12-step table rebuild (https://sqlite.org/lang_altertable.html#otheralter),
// for changes ADD COLUMN can't make (UNIQUE, PRIMARY KEY, CHECK, FK, type, drop).
// `newDef` has the TABLES shape ({ columns, primaryKey?, indexes? }). `copySql`
// is an optional SELECT over the old table returning the new columns in order;
// without it, the columns both shapes share are copied and the row count must
// match. The runner turns foreign keys off around the migration and runs
// `PRAGMA foreign_key_check` before commit, so call this only inside `up()`.
export function rebuildTable(db, name, newDef, copySql = null) {
  const tmp = `${name}_new`;
  const newCols = Object.keys(newDef.columns);
  db.exec(`DROP TABLE IF EXISTS ${tmp}`);
  db.exec(buildCreateTableSql(tmp, newDef));

  if (copySql) {
    db.exec(`INSERT INTO ${tmp} (${newCols.join(", ")}) ${copySql}`);
  } else {
    const oldCols = new Set(db.all(`PRAGMA table_info(${name})`).map((c) => c.name));
    const shared = newCols.filter((c) => oldCols.has(c)).join(", ");
    db.exec(`INSERT INTO ${tmp} (${shared}) SELECT ${shared} FROM ${name}`);
    const before = db.get(`SELECT COUNT(*) AS c FROM ${name}`).c;
    const after = db.get(`SELECT COUNT(*) AS c FROM ${tmp}`).c;
    if (before !== after) {
      throw new Error(`rebuild ${name}: copied ${after} of ${before} rows`);
    }
  }

  db.exec(`DROP TABLE ${name}`);
  db.exec(`ALTER TABLE ${tmp} RENAME TO ${name}`);
  for (const idx of newDef.indexes || []) db.exec(idx);

  const violations = db.all(`PRAGMA foreign_key_check(${name})`);
  if (violations.length) {
    throw new Error(`rebuild ${name}: ${violations.length} foreign key violation(s)`);
  }
}
