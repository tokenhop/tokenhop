// usageHistory retention (YAN-424). Opt-in pruning of raw history rows whose
// totals already live in usageRollup, keeping budgets exact via usageBudgetCarry.
//
// Safety rules (the rollup is the source of truth for long windows):
// - Only rows with a canonical ISO timestamp (what the write path emits) are
//   ever deleted. Anything else stays and is counted in `nonCanonicalRows`.
// - Only WHOLE server-local days older than the cutoff are pruned, so the
//   effective retention is at least N days.
// - A day is pruned only when its history row count does not exceed the
//   rollup's request count for that dateKey. The write path rolls up EVERY
//   row (any status) in the same transaction as the insert, so any excess is
//   legacy history that was never rolled up: that day is skipped, never lost.
// - The rollup is never rebuilt or touched here.
// - The newest canonical row per workspaceId group (NULL included) and per
//   non-null apiKeyId always survives, so scoped last-activity and API-key
//   lastUsed keep working.
// - Planning walks populated days with indexed range queries (no full-table
//   GROUP BY) and yields between days; each delete batch (select + carry
//   upsert + delete) is one transaction that rolls back if the delete count
//   differs from the selected rows.
import { getAdapter } from "../driver.js";
import { NO_KEY, localDateKey } from "./usageRollupRepo.js";
import { upsertBudgetCarryUnscoped } from "./usageBudgetCarryRepo.js";

export { upsertBudgetCarryUnscoped };

const DAY_MS = 86400000;
export const PRUNE_BATCH_SIZE = 1000;

// toISOString() shape: YYYY-MM-DDTHH:MM:SS.mmmZ
const CANONICAL =
  "timestamp GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'";

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

const SETTLED = new Set(["ok", "success"]);
const isSettled = (status) => status == null || SETTLED.has(status);

/** [ISO start, ISO end) of a server-local day key, plus the end as epoch ms. */
function localDayRange(key) {
  const [y, m, d] = key.split("-").map(Number);
  const start = new Date(y, m - 1, d);
  const end = new Date(y, m - 1, d + 1);
  return { startIso: start.toISOString(), endIso: end.toISOString(), endMs: end.getTime() };
}

/**
 * Newest canonical row per workspace group (NULL included) and per non-null
 * apiKeyId, as id -> timestamp. Groups come from the small `workspaces` and
 * `usageRollup` tables, never a GROUP BY over usageHistory.
 */
function keepNewestRows(db) {
  const keep = new Map();
  const newest = (cond, params) => {
    const row = db.get(
      `SELECT id, timestamp FROM usageHistory WHERE ${cond} AND ${CANONICAL} ORDER BY timestamp DESC, id DESC LIMIT 1`,
      params,
    );
    if (row && Number.isInteger(row.id)) keep.set(row.id, row.timestamp);
  };
  newest("workspaceId IS NULL", []);
  for (const w of db.all(`SELECT id FROM workspaces`)) newest("workspaceId = ?", [w.id]);
  for (const k of db.all(`SELECT DISTINCT apiKeyId FROM usageRollup WHERE apiKeyId != ?`, [
    NO_KEY,
  ])) {
    newest("apiKeyId = ?", [k.apiKeyId]);
  }
  return keep;
}

function notionalOf(meta) {
  if (!meta) return false;
  try {
    const n = JSON.parse(meta)?.notional;
    return n === true || n === 1;
  } catch {
    return false;
  }
}

/** Fold settled rows into carry buckets keyed like spentFor's scope columns. */
function foldCarry(rows) {
  const buckets = new Map();
  for (const r of rows) {
    if (!isSettled(r.status)) continue;
    const t = Date.parse(r.timestamp);
    if (!Number.isFinite(t)) continue;
    const dims = [
      new Date(t).toISOString().slice(0, 10),
      r.workspaceId || "",
      r.userId || "",
      r.apiKeyId || "",
      r.grantId || "",
    ];
    const key = JSON.stringify(dims);
    const b = buckets.get(key) || { dims, usd: 0, tokens: 0, requests: 0, notionalUsd: 0 };
    const cost = Number(r.cost) || 0;
    b.usd += cost;
    // NULL token columns count as 0 (spentFor uses COALESCE the same way).
    b.tokens += (Number(r.promptTokens) || 0) + (Number(r.completionTokens) || 0);
    b.requests += 1;
    if (notionalOf(r.meta)) b.notionalUsd += cost;
    buckets.set(key, b);
  }
  return [...buckets.values()];
}

/** Prune one local day; returns rows deleted. */
async function pruneDay(db, range, keep, batchSize, result) {
  const keepIds = [...keep]
    .filter(([, ts]) => ts >= range.startIso && ts < range.endIso)
    .map(([id]) => id);
  const keepSql = keepIds.length ? `AND id NOT IN (${keepIds.join(",")})` : "";
  for (;;) {
    const deleted = db.transaction(() => {
      const rows = db.all(
        `SELECT id, timestamp, workspaceId, userId, apiKeyId, grantId, cost, promptTokens, completionTokens, status, meta
         FROM usageHistory WHERE timestamp >= ? AND timestamp < ? AND ${CANONICAL} ${keepSql} ORDER BY timestamp LIMIT ?`,
        [range.startIso, range.endIso, batchSize],
      );
      if (!rows.length) return 0;
      for (const b of foldCarry(rows)) upsertBudgetCarryUnscoped(db, b);
      const { changes } = db.run(
        `DELETE FROM usageHistory WHERE id IN (${rows.map((r) => Number(r.id)).join(",")})`,
      );
      // Roll the carry back too if the delete didn't hit exactly these rows.
      if (changes !== rows.length) {
        throw new Error(`[UsageRetention] deleted ${changes} of ${rows.length} selected rows`);
      }
      return rows.length;
    });
    if (!deleted) return;
    result.deleted += deleted;
    result.batches += 1;
    await yieldToLoop(); // let request handlers run between batches
  }
}

/**
 * Delete usageHistory rows older than `retentionDays` (see header for rules).
 * @param {number} retentionDays integer >= 2; anything else is a no-op
 * @param {{now?: number, batchSize?: number}} [opts]
 * @returns {Promise<{deleted: number, batches: number, skippedDays: number, nonCanonicalRows: number}>}
 */
export async function pruneUsageHistoryUnscoped(retentionDays, opts = {}) {
  const result = { deleted: 0, batches: 0, skippedDays: 0, nonCanonicalRows: 0 };
  const days = Number(retentionDays);
  if (!Number.isInteger(days) || days < 2) return result;
  const batchSize = opts.batchSize ?? PRUNE_BATCH_SIZE;
  const db = await getAdapter();

  const cutoff = new Date((opts.now ?? Date.now()) - days * DAY_MS);
  const eligibleEnd = new Date(cutoff.getFullYear(), cutoff.getMonth(), cutoff.getDate());
  const eligibleEndIso = eligibleEnd.toISOString();
  const keep = keepNewestRows(db);

  // Non-canonical timestamps are never deleted; report them. The GLOB only
  // reads `timestamp`, so idx_uh_ts covers this count (no table access).
  result.nonCanonicalRows = Number(
    db.get(`SELECT COUNT(*) AS n FROM usageHistory WHERE timestamp < ? AND NOT (${CANONICAL})`, [
      eligibleEndIso,
    ]).n,
  );
  await yieldToLoop();

  // Jump from populated day to populated day via the timestamp index.
  let from = "0000-01-01T00:00:00.000Z";
  for (;;) {
    const first = db.get(
      `SELECT MIN(timestamp) AS ts FROM usageHistory WHERE timestamp >= ? AND timestamp < ? AND ${CANONICAL}`,
      [from, eligibleEndIso],
    );
    if (!first?.ts) break;
    const range = localDayRange(localDateKey(first.ts));
    if (range.endMs > eligibleEnd.getTime()) break;
    from = range.endIso;

    const total = db.get(
      `SELECT COUNT(*) AS n FROM usageHistory WHERE timestamp >= ? AND timestamp < ?`,
      [range.startIso, range.endIso],
    );
    const rolled = db.get(
      `SELECT COALESCE(SUM(requests), 0) AS n FROM usageRollup WHERE dateKey = ?`,
      [localDateKey(first.ts)],
    ).n;
    if (total.n > rolled) result.skippedDays += 1;
    else await pruneDay(db, range, keep, batchSize, result);
    await yieldToLoop(); // planning is per-day, never one long synchronous scan
  }
  return result;
}

/** Dashboard readout: row count + oldest timestamp (ISO) of usageHistory. */
export async function getUsageHistoryStatsUnscoped() {
  const db = await getAdapter();
  const row = db.get(`SELECT COUNT(*) AS n, MIN(timestamp) AS oldest FROM usageHistory`);
  return { rows: Number(row?.n) || 0, oldest: row?.oldest || null };
}
