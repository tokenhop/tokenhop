// usageBudgetCarry writers (YAN-424): settled spend of usageHistory rows pruned
// by the retention job, keyed by UTC day + attribution dims ('' = unknown), so
// budget windows (spentFor) stay exact. Sync helpers; callers own the transaction.

/** Add `b` ({dims: [day, workspaceId, userId, apiKeyId, grantId], usd, tokens, requests, notionalUsd}). */
export function upsertBudgetCarryUnscoped(db, b) {
  db.run(
    `INSERT INTO usageBudgetCarry(day, workspaceId, userId, apiKeyId, grantId, usd, tokens, requests, notionalUsd)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day, workspaceId, userId, apiKeyId, grantId) DO UPDATE SET
       usd = usd + excluded.usd, tokens = tokens + excluded.tokens,
       requests = requests + excluded.requests, notionalUsd = notionalUsd + excluded.notionalUsd`,
    [...b.dims, b.usd, b.tokens, b.requests, b.notionalUsd],
  );
}

const DETACH_DIMS = {
  workspaceId: ["userId", "apiKeyId", "grantId"],
  userId: ["workspaceId", "apiKeyId", "grantId"],
};

/**
 * A workspace or user was deleted: usageHistory FKs go ON DELETE SET NULL, so
 * their carry rows move to the unknown ('') attribution, merging into any
 * existing row instead of violating the primary key. Same transaction as the
 * delete. `column` is 'workspaceId' or 'userId'.
 */
export function detachBudgetCarryUnscoped(db, column, id) {
  const rest = DETACH_DIMS[column];
  if (!rest || typeof id !== "string" || !id) return 0;
  const dims = ["day", "workspaceId", "userId", "apiKeyId", "grantId"];
  const select = dims.map((d) => (d === column ? "''" : d)).join(", ");
  const n = db.run(
    `INSERT INTO usageBudgetCarry(${dims.join(", ")}, usd, tokens, requests, notionalUsd)
     SELECT ${select}, SUM(usd), SUM(tokens), SUM(requests), SUM(notionalUsd)
     FROM usageBudgetCarry WHERE ${column} = ? GROUP BY day, ${rest.join(", ")}
     ON CONFLICT(${dims.join(", ")}) DO UPDATE SET
       usd = usd + excluded.usd, tokens = tokens + excluded.tokens,
       requests = requests + excluded.requests, notionalUsd = notionalUsd + excluded.notionalUsd`,
    [id],
  ).changes;
  db.run(`DELETE FROM usageBudgetCarry WHERE ${column} = ?`, [id]);
  return n;
}
