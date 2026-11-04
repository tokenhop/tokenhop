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
