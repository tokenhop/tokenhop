import { matchesFlaggedDuplicate } from "./connectionIdentity.js";
import { foldUsageRollupSql } from "./usageRollupFold.js";
import { recordAbsorbedConnection } from "./absorbedConnections.js";

// YAN-1941: after the commit, so a rolled-back merge never redirects writes.
// A write already queued in the microtask before this runs keeps the old id;
// that gap is accepted (the row was dead, see the issue).
export function recordAbsorbed(removed, keeper) {
  for (const { conn } of removed) recordAbsorbedConnection(conn.id, keeper.id);
}

// YAN-1623: repoint one removed duplicate's references onto the kept row,
// then delete it (inside the caller's transaction; the caller reorders).
// Grant ids survive so budget/usage grantId links stay valid. When the keeper
// holds, for the same grantee, an active grant or any of its ORIGINAL grants
// (`keeperGrantIds`, snapshotted before any loser was absorbed — active or
// revoked), the keeper's state wins: the duplicate's active grant is revoked
// (this also keeps the one-active-grant-per-grantee indexes). Revoked grants
// moved over from an earlier loser never suppress a later loser's active
// grant, so the outcome does not depend on loser order. Returns the revoked
// and moved grants so the scoped caller can audit them.
function absorbDuplicateInTx(db, loserId, keeperId, nowMs, keeperGrantIds) {
  const ids = keeperGrantIds.length ? keeperGrantIds : [""];
  const marks = ids.map(() => "?").join(",");
  const revoked = db.all(
    `SELECT l.id FROM connectionGrants l WHERE l.connectionId = ? AND l.revokedAt IS NULL AND EXISTS (
       SELECT 1 FROM connectionGrants k WHERE k.connectionId = ?
         AND (k.revokedAt IS NULL OR k.id IN (${marks}))
         AND ((l.workspaceId IS NOT NULL AND k.workspaceId = l.workspaceId)
           OR (l.userId IS NOT NULL AND k.userId = l.userId)))`,
    [loserId, keeperId, ...ids],
  );
  for (const g of revoked) {
    db.run(`UPDATE connectionGrants SET revokedAt = ? WHERE id = ?`, [nowMs, g.id]);
  }
  const moved = db.all(`SELECT id, revokedAt FROM connectionGrants WHERE connectionId = ?`, [
    loserId,
  ]);
  db.run(`UPDATE connectionGrants SET connectionId = ? WHERE connectionId = ?`, [
    keeperId,
    loserId,
  ]);
  db.run(`UPDATE usageHistory SET connectionId = ? WHERE connectionId = ?`, [keeperId, loserId]);
  // connectionId is part of the rollup key: rows sum into a keeper row of the same key.
  db.run(foldUsageRollupSql("connectionId = ?", { connectionId: "?" }), [keeperId, loserId]);
  db.run(`DELETE FROM usageRollup WHERE connectionId = ?`, [loserId]);
  // Nested CASE: json_extract must never see an invalid (truncated) data blob.
  db.run(
    `UPDATE requestDetails SET connectionId = ?,
       data = CASE WHEN json_valid(data) THEN
         CASE WHEN json_extract(data, '$.connectionId') = ? THEN json_set(data, '$.connectionId', ?) ELSE data END
       ELSE data END
     WHERE connectionId = ?`,
    [keeperId, loserId, keeperId, loserId],
  );
  // Installed only by hashed-key activation (gatewayVideoJobsRepo.js).
  if (db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gatewayVideoJobs'`)) {
    db.run(`UPDATE gatewayVideoJobs SET connectionId = ? WHERE connectionId = ?`, [
      keeperId,
      loserId,
    ]);
  }
  db.run(`DELETE FROM providerConnections WHERE id = ?`, [loserId]);
  return {
    revokedGrants: revoked.map((g) => ({ id: g.id, connectionId: loserId, revokedAt: nowMs })),
    movedGrants: moved.map((g) => ({
      id: g.id,
      from: loserId,
      to: keeperId,
      revokedAt: g.revokedAt ?? null,
    })),
  };
}

// Absorb flagged duplicates from the caller's transaction and report whether to reorder.
export function absorbCodexDuplicatesInTx(
  db,
  { all, data, existing, nowMs, sameCreator, removed },
) {
  // Only dead rows with a proven matching account id qualify
  // (matchesFlaggedDuplicate), from the caller's and the keeper's creator.
  const keeperCreator = (c) =>
    !existing.createdByUserId ||
    !c.createdByUserId ||
    c.createdByUserId === existing.createdByUserId;
  const losers = all.filter(
    (c) =>
      c.id !== existing.id &&
      sameCreator(c) &&
      keeperCreator(c) &&
      matchesFlaggedDuplicate(c, data, nowMs),
  );
  const keeperGrantIds = losers.length
    ? db
        .all(`SELECT id FROM connectionGrants WHERE connectionId = ?`, [existing.id])
        .map((g) => g.id)
    : [];
  for (const loser of losers) {
    const grants = absorbDuplicateInTx(db, loser.id, existing.id, nowMs, keeperGrantIds);
    removed?.push({ conn: loser, ...grants });
  }
  return losers.length > 0;
}
