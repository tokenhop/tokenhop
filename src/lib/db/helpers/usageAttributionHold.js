// YAN-1981: a hashed instance restore deletes and re-inserts every workspace
// and user. usageHistory/requestDetails attribution FKs are ON DELETE SET NULL,
// so live usage the snapshot does not replace would lose its workspace/user
// even when the snapshot restores the same id. Hold the attribution of rows
// pointing at an id the snapshot restores, and put it back once the parents
// exist again. Rows for dropped workspaces/users stay detached, and rows that
// were already ownerless are never held (so never adopted). Identity is id
// equality, the same rule readInstanceTableSections/importStage.retain apply
// to retained sections. Sync + adapter-passed, inside the import transaction.

const TABLES = Object.freeze([
  { table: "usageHistory", hold: "_usageHoldHistory", idType: "INTEGER" },
  { table: "requestDetails", hold: "_usageHoldDetails", idType: "TEXT" },
]);

const idsOf = (rows) =>
  JSON.stringify((rows || []).map((r) => r?.id).filter((id) => typeof id === "string"));

/**
 * Copy the attribution of live usage rows that name a restored workspace or
 * user into temp tables. Call after any usage section clear and BEFORE
 * deleting workspaces/users.
 * @param {object} db adapter
 * @param {{ workspaces?: object[], users?: object[] }} payload snapshot rows
 */
export function holdUsageAttribution(db, payload) {
  const params = [idsOf(payload.workspaces), idsOf(payload.users)];
  for (const { table, hold, idType } of TABLES) {
    db.exec(`DROP TABLE IF EXISTS temp.${hold}`);
    db.exec(
      `CREATE TEMP TABLE ${hold} (id ${idType} PRIMARY KEY, workspaceId TEXT, userId TEXT) WITHOUT ROWID`,
    );
    db.run(
      `INSERT INTO temp.${hold}(id, workspaceId, userId)
       SELECT id,
         CASE WHEN workspaceId IN (SELECT value FROM json_each(?1)) THEN workspaceId END,
         CASE WHEN userId IN (SELECT value FROM json_each(?2)) THEN userId END
       FROM main.${table}
       WHERE workspaceId IN (SELECT value FROM json_each(?1))
          OR userId IN (SELECT value FROM json_each(?2))`,
      params,
    );
  }
}

/**
 * Restore held attribution whose workspace/user exists again, then drop the
 * temp tables. Call after the snapshot's workspaces and users are inserted
 * and before ownerless adoption or section inserts.
 * @returns {number} usage rows updated
 */
export function restoreUsageAttribution(db) {
  let n = 0;
  for (const { table, hold } of TABLES) {
    n += db.run(
      `UPDATE main.${table} AS t SET
         workspaceId = COALESCE(t.workspaceId, (SELECT w.id FROM temp.${hold} h
           JOIN main.workspaces w ON w.id = h.workspaceId WHERE h.id = t.id)),
         userId = COALESCE(t.userId, (SELECT u.id FROM temp.${hold} h
           JOIN main.users u ON u.id = h.userId WHERE h.id = t.id))
       WHERE t.id IN (SELECT id FROM temp.${hold})`,
    ).changes;
    db.exec(`DROP TABLE IF EXISTS temp.${hold}`);
  }
  return n;
}
