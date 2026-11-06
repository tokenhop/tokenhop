// YAN-1832: durable once-per-window budget notice claims. One row per budget
// and kind (soft | hard) holds the last window it was sent for and the limit
// signature it was sent against; rows cascade with their budget. Synchronous
// (the gateway guard claims inside its no-await check path). Trusted callers
// only: the guard, and the budget GET routes for rows listBudgets already
// authorized. Never expose rows directly through a route.

const CHUNK = 500; // well under SQLite's bound-parameter limit

/** Claim rows of `budgetIds`: [{ budgetId, kind, windowStart, signature }]. */
export function listBudgetNoticesUnscoped(db, budgetIds) {
  const out = [];
  for (let i = 0; i < budgetIds.length; i += CHUNK) {
    const ids = budgetIds.slice(i, i + CHUNK);
    out.push(
      ...db.all(
        `SELECT budgetId, kind, windowStart, signature FROM budgetNotices WHERE budgetId IN (${ids.map(() => "?").join(", ")})`,
        ids,
      ),
    );
  }
  return out;
}

/**
 * Compare-and-set claim: true only when this call recorded the notice for
 * this window and signature (no row yet, an older window, or a different
 * signature). One statement, so concurrent claimers can't both win.
 * Throws on DB errors (the guard fails open).
 */
export function claimBudgetNoticeUnscoped(
  db,
  { budgetId, kind, windowStart, signature, notifiedAt },
) {
  const { changes } = db.run(
    `INSERT INTO budgetNotices(budgetId, kind, windowStart, signature, notifiedAt) VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(budgetId, kind) DO UPDATE SET windowStart = excluded.windowStart, signature = excluded.signature, notifiedAt = excluded.notifiedAt
     WHERE budgetNotices.windowStart <> excluded.windowStart OR budgetNotices.signature <> excluded.signature`,
    [budgetId, kind, windowStart, signature, notifiedAt],
  );
  return Number(changes) === 1;
}

/**
 * YAN-1929: every claim row with its budget's scope and window, captured
 * before a snapshot restore deletes or replaces the budgets (claims never
 * travel in a snapshot). Bounded: at most two rows per budget.
 */
export function snapshotBudgetNoticesUnscoped(db) {
  return db.all(
    `SELECT n.budgetId, n.kind, n.windowStart, n.signature, n.notifiedAt, b.scopeType, b.scopeId, b.window
     FROM budgetNotices n JOIN budgets b ON b.id = n.budgetId`,
  );
}

/**
 * YAN-1929: put captured claims back after a restore, only for budgets that
 * still exist under the same id, scope and window (a dropped budget, or one
 * the backup moved to another scope or window, starts clean). A claim from
 * an older window or for other limits simply loses the next compare-and-set,
 * so it never blocks a due notice.
 * @returns {number} Claims restored.
 */
export function restoreBudgetNoticesUnscoped(db, rows) {
  let restored = 0;
  for (const r of rows) {
    restored += Number(
      db.run(
        `INSERT OR IGNORE INTO budgetNotices(budgetId, kind, windowStart, signature, notifiedAt)
         SELECT ?, ?, ?, ?, ? WHERE EXISTS (
           SELECT 1 FROM budgets WHERE id = ? AND scopeType = ? AND scopeId = ? AND window = ?)`,
        [
          r.budgetId,
          r.kind,
          r.windowStart,
          r.signature,
          r.notifiedAt,
          r.budgetId,
          r.scopeType,
          r.scopeId,
          r.window,
        ],
      ).changes,
    );
  }
  return restored;
}
