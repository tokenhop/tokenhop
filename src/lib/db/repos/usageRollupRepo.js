// Daily usage rollup (YAN-370): one row per local day × attribution dims,
// replacing the per-day `usageDaily` JSON blob. Null dims are stored as ''
// (apiKeyId: 'local-no-key') because SQLite treats NULLs as distinct in a
// composite primary key, so the increment upsert would duplicate rows.
// Sync helpers taking `db`: callers own the transaction (the fail-closed usage
// sink, legacy JSON import) or pass a usage scope (`ctx`).

import { createHash } from "node:crypto";
import {
  LATENCY_COLUMNS,
  LATENCY_DEFAULTS,
  LATENCY_MERGE_SQL,
  latencyDeltas,
} from "../helpers/usageLatencyRollup.js";

export const NO_KEY = "local-no-key";
const DIMS = ["workspaceId", "userId", "apiKeyId", "provider", "model", "connectionId", "endpoint"];

/**
 * Legacy storage: raw → keys-table id; a raw that matches no key becomes a
 * `historical:` pseudonym (truncated sha256: gateway keys are high-entropy
 * secrets, and this must not depend on master-key availability). Same scheme
 * as migration 014. The raw is never persisted (YAN-370, ADR-0005).
 */
export function legacyKeyId(db, raw) {
  if (typeof raw !== "string" || raw === "") return NO_KEY;
  if (raw === NO_KEY) return NO_KEY;
  const row = db.get(`SELECT id FROM apiKeys WHERE key = ?`, [raw]);
  if (row?.id) return row.id;
  return `historical:${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`;
}

/** Server-local YYYY-MM-DD: the day key charts and stats have always used. */
export function localDateKey(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Local date key of the first day of an inclusive `days`-day window ending today. */
export function cutoffDateKey(days, now) {
  const t = now == null ? new Date() : new Date(now);
  return localDateKey(new Date(t.getFullYear(), t.getMonth(), t.getDate() - days + 1));
}

/**
 * Usage scope → SQL condition. `ctx` null is the unscoped view (switch off or
 * a single user). Otherwise `{ workspaceId, userId?, apiKeyId? }`: the
 * workspace, narrowed to one user's rows when `userId` is set (members/viewers,
 * plan D1) and to one gateway key's rows when `apiKeyId` is set (YAN-376).
 * @returns {{ sql: string, params: string[] }} empty condition when unscoped
 */
export function scopeSql(ctx, alias = "") {
  if (!ctx) return { sql: "", params: [] };
  if (typeof ctx.workspaceId !== "string" || !ctx.workspaceId) {
    throw new Error("[usage] scoped read without workspaceId");
  }
  const conds = [`${alias}workspaceId = ?`];
  const params = [ctx.workspaceId];
  if (ctx.userId) {
    conds.push(`${alias}userId = ?`);
    params.push(ctx.userId);
  }
  if (ctx.apiKeyId) {
    conds.push(`${alias}apiKeyId = ?`);
    params.push(ctx.apiKeyId);
  }
  return { sql: conds.join(" AND "), params };
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
  const { requests = 1, tokensIn = 0, tokensOut = 0, tokensCached = 0, cost = 0, ...lat } = deltas;
  const latency = { ...LATENCY_DEFAULTS, ...lat };
  db.run(
    `INSERT INTO usageRollup (dateKey, ${DIMS.join(", ")}, requests, tokensIn, tokensOut, tokensCached, cost, ${LATENCY_COLUMNS.join(", ")})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${LATENCY_COLUMNS.map(() => ", ?").join("")})
     ON CONFLICT (dateKey, ${DIMS.join(", ")}) DO UPDATE SET
       requests = requests + excluded.requests,
       tokensIn = tokensIn + excluded.tokensIn,
       tokensOut = tokensOut + excluded.tokensOut,
       tokensCached = tokensCached + excluded.tokensCached,
       cost = cost + excluded.cost,
       ${LATENCY_MERGE_SQL}`,
    [
      dims.dateKey,
      ...dimValues(dims),
      requests,
      tokensIn,
      tokensOut,
      tokensCached,
      cost,
      ...LATENCY_COLUMNS.map((c) => latency[c]),
    ],
  );
}

/**
 * Rollup rows from `startDateKey` (inclusive; null = all time) through the
 * optional `endDateKey` (inclusive; null = open) within the usage scope `ctx`.
 * Empty dims come back as null; apiKeyId keeps its 'local-no-key' sentinel.
 */
export function readRollup(ctx, db, startDateKey = null, endDateKey = null) {
  const scope = scopeSql(ctx);
  const params = [...scope.params];
  if (startDateKey) params.push(startDateKey);
  if (endDateKey) params.push(endDateKey);
  const proj = DIMS.map((k) => (k === "apiKeyId" ? k : `NULLIF(${k}, '') AS ${k}`)).join(", ");
  return db.all(
    `SELECT dateKey, ${proj}, requests, tokensIn, tokensOut, tokensCached, cost FROM usageRollup
     ${whereAll(scope.sql, startDateKey ? "dateKey >= ?" : "", endDateKey ? "dateKey <= ?" : "")} ORDER BY dateKey`,
    params,
  );
}

/**
 * Summed rollup totals for dateKeys in `[startDateKey, endDateKeyExclusive)`
 * (either bound null = open) within the usage scope `ctx`. Read from the
 * rollup only, so long windows never touch usageHistory.
 */
export function readRollupTotals(ctx, db, startDateKey = null, endDateKeyExclusive = null) {
  const scope = scopeSql(ctx);
  const params = [...scope.params];
  if (startDateKey) params.push(startDateKey);
  if (endDateKeyExclusive) params.push(endDateKeyExclusive);
  const row = db.get(
    `SELECT COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(tokensIn), 0) AS promptTokens,
       COALESCE(SUM(tokensOut), 0) AS completionTokens, COALESCE(SUM(tokensCached), 0) AS cachedTokens,
       COALESCE(SUM(cost), 0) AS cost FROM usageRollup
     ${whereAll(scope.sql, startDateKey ? "dateKey >= ?" : "", endDateKeyExclusive ? "dateKey < ?" : "")}`,
    params,
  );
  return {
    requests: Number(row?.requests) || 0,
    promptTokens: Number(row?.promptTokens) || 0,
    completionTokens: Number(row?.completionTokens) || 0,
    cachedTokens: Number(row?.cachedTokens) || 0,
    cost: Number(row?.cost) || 0,
  };
}

/**
 * One row per dateKey (summed over every dimension) from `startDateKey`
 * (inclusive; null = all time) through the optional `endDateKey` (inclusive),
 * grouped in SQL so the result is bounded by days, not by days x dims.
 */
export function readRollupDaily(ctx, db, startDateKey = null, endDateKey = null) {
  const scope = scopeSql(ctx);
  const params = [...scope.params];
  if (startDateKey) params.push(startDateKey);
  if (endDateKey) params.push(endDateKey);
  return db.all(
    `SELECT dateKey, SUM(requests) AS requests, SUM(tokensIn) AS tokensIn,
       SUM(tokensOut) AS tokensOut, SUM(tokensCached) AS tokensCached, SUM(cost) AS cost
     FROM usageRollup ${whereAll(scope.sql, startDateKey ? "dateKey >= ?" : "", endDateKey ? "dateKey <= ?" : "")}
     GROUP BY dateKey ORDER BY dateKey`,
    params,
  );
}

/**
 * Edit-prediction latency rollup rows (YAN-771) for `endpoint`, from
 * `startDateKey` (inclusive; null = all time) through the optional
 * `endDateKey` (inclusive), within the usage scope `ctx`.
 */
export function readLatencyRollup(ctx, db, endpoint, startDateKey = null, endDateKey = null) {
  const scope = scopeSql(ctx);
  const params = [...scope.params, endpoint];
  if (startDateKey) params.push(startDateKey);
  if (endDateKey) params.push(endDateKey);
  return db.all(
    `SELECT NULLIF(provider, '') AS provider, model, endpoint, ${LATENCY_COLUMNS.join(", ")} FROM usageRollup
     ${whereAll(scope.sql, "endpoint = ?", startDateKey ? "dateKey >= ?" : "", endDateKey ? "dateKey <= ?" : "", "latencyRequests > 0")}`,
    params,
  );
}

/** Rebuild every rollup row from usageHistory (legacy JSON import; 014 inlines its own copy). */
export function rebuildRollupFromHistoryUnscoped(db) {
  db.run(`DELETE FROM usageRollup`);
  for (const r of db.all(
    `SELECT timestamp, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint,
            promptTokens, completionTokens, cost, tokens, meta FROM usageHistory`,
  )) {
    let cached = 0;
    try {
      const t = r.tokens ? JSON.parse(r.tokens) : null;
      cached = t?.cached_tokens || t?.cache_read_input_tokens || 0;
    } catch {}
    let meta = null;
    try {
      meta = r.meta ? JSON.parse(r.meta) : null;
    } catch {}
    upsertRollupRowUnscoped(
      db,
      { ...r, dateKey: localDateKey(r.timestamp) },
      {
        tokensIn: r.promptTokens || 0,
        tokensOut: r.completionTokens || 0,
        tokensCached: cached,
        cost: r.cost || 0,
        ...latencyDeltas(r.endpoint, meta),
      },
    );
  }
}
