// SQLite's schema cookie returns to its old value when a DDL transaction rolls
// back, so unrelated later DDL can land on the exact number a stale memo
// remembers. Tests drive that for real instead of mocking the probe.
export const schemaCookie = (db) => db.get("PRAGMA main.schema_version").schema_version;

export const hasKeyHashColumn = (db) =>
  db.all("PRAGMA main.table_info(apiKeys)").some((c) => c.name === "keyHash");

let pad = 0;

/** Real ADD COLUMNs on a scratch table (+1 cookie each) until the cookie equals target. */
export function reachSchemaCookie(db, target) {
  db.exec("CREATE TABLE IF NOT EXISTS cookieScratch(x)");
  while (schemaCookie(db) < target)
    db.exec(`ALTER TABLE cookieScratch ADD COLUMN pad${pad++} TEXT`);
  if (schemaCookie(db) !== target) throw new Error(`cannot reach schema cookie ${target}`);
}
