// Daily usage rollup (YAN-370): one row per local day × attribution dims,
// replacing the per-day `usageDaily` JSON blob. Null dims are stored as ''
// (apiKeyId: 'local-no-key') because SQLite treats NULLs as distinct in a
// composite primary key, so the increment upsert would duplicate rows.
// Sync helpers taking `db`: callers own the transaction (the fail-closed usage
// sink, legacy JSON import) or pass a usage scope (`ctx`).

export const NO_KEY = "local-no-key";
const DIMS = ["workspaceId", "userId", "apiKeyId", "provider", "model", "connectionId", "endpoint"];

/** Server-local YYYY-MM-DD: the day key charts and stats have always used. */
export function localDateKey(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Local date key of the first day of an inclusive `days`-day window ending today. */
export function cutoffDateKey(days) {
  const t = new Date();
  return localDateKey(new Date(t.getFullYear(), t.getMonth(), t.getDate() - days + 1));
}

/**
 * Usage scope → SQL condition. `ctx` null is the unscoped view (switch off or
 * a single user). Otherwise `{ workspaceId, userId? }`: the workspace, narrowed
 * to one user's rows when `userId` is set (members/viewers, plan D1).
 * @returns {{ sql: string, params: string[] }} empty condition when unscoped
 */
export function scopeSql(ctx, alias = "") {
  if (!ctx) return { sql: "", params: [] };
  if (typeof ctx.workspaceId !== "string" || !ctx.workspaceId) {
    throw new Error("[usage] scoped read without workspaceId");
  }
  if (ctx.userId) {
    return {
      sql: `${alias}workspaceId = ? AND ${alias}userId = ?`,
      params: [ctx.workspaceId, ctx.userId],
    };
  }
  return { sql: `${alias}workspaceId = ?`, params: [ctx.workspaceId] };
}

/** "WHERE a AND b" from the non-empty conditions, or "". */
export function whereAll(...conds) {
  const c = conds.filter(Boolean);
  return c.length ? `WHERE ${c.join(" AND ")}` : "";
}

function dimValues(dims) {
  return DIMS.map((k) => {
    const v = dims[k];
    if (typeof v !== "string" || v === "") return k === "apiKeyId" ? NO_KEY : "";
    return v;
  });
}

/**
 * Add `deltas` to the (dateKey, dims) row, creating it if needed.
 * @param {object} db sync adapter
 * @param {{dateKey: string, workspaceId?, userId?, apiKeyId?, provider?, model?, connectionId?, endpoint?}} dims
 * @param {{requests?: number, tokensIn?: number, tokensOut?: number, tokensCached?: number, cost?: number}} deltas
 */
export function upsertRollupRowUnscoped(db, dims, deltas = {}) {
  const { requests = 1, tokensIn = 0, tokensOut = 0, tokensCached = 0, cost = 0 } = deltas;
  db.run(
    `INSERT INTO usageRollup (dateKey, ${DIMS.join(", ")}, requests, tokensIn, tokensOut, tokensCached, cost)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (dateKey, ${DIMS.join(", ")}) DO UPDATE SET
       requests = requests + excluded.requests,
       tokensIn = tokensIn + excluded.tokensIn,
       tokensOut = tokensOut + excluded.tokensOut,
       tokensCached = tokensCached + excluded.tokensCached,
       cost = cost + excluded.cost`,
    [dims.dateKey, ...dimValues(dims), requests, tokensIn, tokensOut, tokensCached, cost],
  );
}

/**
 * Rollup rows from `startDateKey` (inclusive; null = all time) within the
 * usage scope `ctx`. Empty dims come back as null; apiKeyId keeps its
 * 'local-no-key' sentinel.
 */
export function readRollup(ctx, db, startDateKey = null) {
  const scope = scopeSql(ctx);
  const params = [...scope.params];
  if (startDateKey) params.push(startDateKey);
  const proj = DIMS.map((k) => (k === "apiKeyId" ? k : `NULLIF(${k}, '') AS ${k}`)).join(", ");
  return db.all(
    `SELECT dateKey, ${proj}, requests, tokensIn, tokensOut, tokensCached, cost FROM usageRollup
     ${whereAll(scope.sql, startDateKey ? "dateKey >= ?" : "")} ORDER BY dateKey`,
    params,
  );
}

/** Rebuild every rollup row from usageHistory (legacy JSON import; 014 inlines its own copy). */
export function rebuildRollupFromHistoryUnscoped(db) {
  db.run(`DELETE FROM usageRollup`);
  for (const r of db.all(
    `SELECT timestamp, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint,
            promptTokens, completionTokens, cost, tokens FROM usageHistory`,
  )) {
    let cached = 0;
    try {
      const t = r.tokens ? JSON.parse(r.tokens) : null;
      cached = t?.cached_tokens || t?.cache_read_input_tokens || 0;
    } catch {}
    upsertRollupRowUnscoped(
      db,
      { ...r, dateKey: localDateKey(r.timestamp) },
      {
        tokensIn: r.promptTokens || 0,
        tokensOut: r.completionTokens || 0,
        tokensCached: cached,
        cost: r.cost || 0,
      },
    );
  }
}
