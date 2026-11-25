// Persisted quota snapshot history (YAN-422).
// Stores rate-limited, on-change samples of quota window utilization (zero
// secrets: numeric metrics + canonical window kinds only) so snapshots and
// runway forecasts survive restarts and the Quota page can show 7d sparklines.
import { getAdapter } from "../driver.js";
import { QUOTA_SNAPSHOT } from "../../../../open-sse/config/quotaSnapshot.js";
import {
  normalizeUsedFraction,
  parseResetMs,
  sanitizedWindowKind,
  sanitizePlanTier,
} from "../../../../open-sse/services/quotaSnapshot.js";

const H = QUOTA_SNAPSHOT.history;
const DAY_MS = 86_400_000;
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CACHE_KEY = "__tokenhopQuotaHistoryWriteCache";

function writeCache() {
  if (!(globalThis[CACHE_KEY] instanceof Map)) globalThis[CACHE_KEY] = new Map();
  return globalThis[CACHE_KEY];
}

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

function validNow(now) {
  return Number.isFinite(now) ? Math.floor(now) : Date.now();
}

function sanitizeQuotaKey(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128) return "";
  if (BLOCKED_KEYS.has(trimmed.toLowerCase())) return "";
  return trimmed;
}

function sanitizeProvider(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > 64 || BLOCKED_KEYS.has(trimmed)) return null;
  return trimmed;
}

function sanitizeConnectionId(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128) return null;
  return trimmed;
}

function cacheKeyOf(connectionId, windowKind, quotaKey) {
  return `${connectionId}\u0000${windowKind}\u0000${quotaKey}`;
}

function setWriteCacheEntry(key, value) {
  const cache = writeCache();
  if (!cache.has(key) && cache.size >= H.maxWriteCacheKeys) {
    let oldestKey;
    let oldestTs = Infinity;
    for (const [k, v] of cache) {
      if (v.ts < oldestTs) {
        oldestTs = v.ts;
        oldestKey = k;
      }
    }
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, value);
}

function shouldPersistSample(prev, next, opts = {}) {
  if (!prev) return true;
  if (next.ts < prev.ts) return false;

  const minInterval = Number.isFinite(opts.minSampleIntervalMs)
    ? opts.minSampleIntervalMs
    : H.minSampleIntervalMs;
  if (next.ts - prev.ts < minInterval) return false;

  const heartbeat = Number.isFinite(opts.heartbeatIntervalMs)
    ? opts.heartbeatIntervalMs
    : H.heartbeatIntervalMs;
  if (next.ts - prev.ts >= heartbeat) return true;

  const minDelta = Number.isFinite(opts.minChangeDelta) ? opts.minChangeDelta : H.minChangeDelta;
  if (Math.abs(next.usedFraction - prev.usedFraction) >= minDelta) return true;

  const resetShift = Number.isFinite(opts.resetShiftMs) ? opts.resetShiftMs : H.resetShiftMs;
  if (next.resetsAt !== prev.resetsAt && Math.abs(next.resetsAt - prev.resetsAt) >= resetShift) {
    return true;
  }

  return false;
}

/**
 * Downsample an ascending `{ ts, usedPct }` series to at most `maxPoints`,
 * always keeping the first and last point and selecting the peak `usedPct`
 * within each intermediate slice so quota spikes are never smoothed away.
 */
export function downsampleHistoryPoints(points, maxPoints = H.maxSparklinePoints) {
  if (!Array.isArray(points) || points.length === 0) return [];
  const cap = Number.isInteger(maxPoints) && maxPoints >= 2 ? maxPoints : H.maxSparklinePoints;
  if (points.length <= cap) return points.slice();

  const out = [points[0]];
  const innerCount = cap - 2;
  const inner = points.slice(1, points.length - 1);
  for (let i = 0; i < innerCount; i++) {
    const start = Math.floor((i * inner.length) / innerCount);
    const end = Math.max(start + 1, Math.floor(((i + 1) * inner.length) / innerCount));
    let peak = inner[start];
    for (let j = start + 1; j < end; j++) {
      if (inner[j].usedPct >= peak.usedPct) peak = inner[j];
    }
    out.push(peak);
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Persist rate-limited, on-change quota history samples for one connection.
 * Stores strictly non-secret fields (connectionId, provider, windowKind,
 * quotaKey, usedFraction, resetsAt, source, ts). Fail-open on FK or DB error.
 *
 * @param {string} connectionId
 * @param {string} provider
 * @param {Array<{ windowKind?: string, kind?: string, quotaKey?: string, usedFraction: number, resetsAt?: number|string|null, source?: string, ts?: number }>} samples
 * @param {{ now?: number, minSampleIntervalMs?: number, minChangeDelta?: number, resetShiftMs?: number, heartbeatIntervalMs?: number }} [opts]
 * @returns {Promise<{ inserted: number, skipped: number }>}
 */
export async function recordQuotaHistorySamplesUnscoped(
  connectionId,
  provider,
  samples,
  opts = {},
) {
  const connId = sanitizeConnectionId(connectionId);
  const prov = sanitizeProvider(provider);
  if (!connId || !prov || !Array.isArray(samples) || samples.length === 0) {
    return { inserted: 0, skipped: 0 };
  }

  const now = validNow(opts.now);
  const cache = writeCache();
  let skipped = 0;

  // Dedupe within the same batch by (windowKind, quotaKey), keeping highest usedFraction.
  const batchByKey = new Map();
  for (const raw of samples) {
    if (!raw || typeof raw !== "object") {
      skipped += 1;
      continue;
    }
    const windowKind = sanitizedWindowKind(raw.windowKind ?? raw.kind);
    const usedFraction = normalizeUsedFraction(raw.usedFraction, "used01");
    if (!windowKind || usedFraction === null) {
      skipped += 1;
      continue;
    }
    const quotaKey = sanitizeQuotaKey(raw.quotaKey);
    const ts = Number.isFinite(raw.ts) ? Math.floor(raw.ts) : now;
    const resetsAt = parseResetMs(raw.resetsAt, ts) || 0;
    const planTier = sanitizePlanTier(raw.planTier);
    const source = raw.source === "header" ? "header" : "probe";
    const key = cacheKeyOf(connId, windowKind, quotaKey);
    const prevInBatch = batchByKey.get(key);
    if (!prevInBatch || usedFraction >= prevInBatch.usedFraction) {
      batchByKey.set(key, {
        key,
        windowKind,
        quotaKey,
        usedFraction,
        resetsAt,
        planTier,
        source,
        ts,
      });
    }
  }

  if (batchByKey.size === 0) return { inserted: 0, skipped };
  const entries = [...batchByKey.values()];

  try {
    const db = await getAdapter();
    // Gate + insert in ONE synchronous transaction: no await sits between reading the
    // previous sample and writing the next, so concurrent callers (or a cache eviction /
    // restart) cannot both pass the rate limiter for the same series.
    const written = db.transaction(() => {
      const inserted = [];
      for (const row of entries) {
        const prev =
          cache.get(row.key) ??
          db.get(
            `SELECT usedFraction, resetsAt, ts FROM quotaHistory
             WHERE connectionId = ? AND windowKind = ? AND quotaKey = ?
             ORDER BY ts DESC, id DESC LIMIT 1`,
            [connId, row.windowKind, row.quotaKey],
          );
        if (!shouldPersistSample(prev, row, opts)) continue;
        db.run(
          `INSERT INTO quotaHistory (connectionId, provider, windowKind, quotaKey, usedFraction, resetsAt, planTier, source, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            connId,
            prov,
            row.windowKind,
            row.quotaKey,
            row.usedFraction,
            row.resetsAt,
            row.planTier,
            row.source,
            row.ts,
          ],
        );
        inserted.push(row);
      }
      return inserted;
    });
    // No await between commit and publishing the cache; a rollback publishes nothing.
    for (const row of written) setWriteCacheEntry(row.key, row);
    return { inserted: written.length, skipped: skipped + entries.length - written.length };
  } catch (error) {
    // FK failures happen when a connection was concurrently deleted or in unit
    // tests with mocked connections — degrade silently without polluting cache.
    if (!/FOREIGN KEY/i.test(error?.message || "")) {
      console.warn(`[QuotaHistory] write failed for ${prov}: ${error?.message}`);
    }
    return { inserted: 0, skipped: skipped + entries.length };
  }
}

/**
 * Seed the write rate-limiter cache from persisted rows (called during startup
 * hydration so a restart does not bypass rate limiting on unchanged windows).
 */
export function seedQuotaHistoryWriteCacheUnscoped(rows) {
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const connId = sanitizeConnectionId(row.connectionId);
    const windowKind = sanitizedWindowKind(row.windowKind);
    if (!connId || !windowKind || !Number.isFinite(row.ts) || !Number.isFinite(row.usedFraction)) {
      continue;
    }
    const key = cacheKeyOf(connId, windowKind, sanitizeQuotaKey(row.quotaKey));
    const prev = writeCache().get(key);
    if (!prev || row.ts > prev.ts) {
      setWriteCacheEntry(key, {
        ts: Math.floor(row.ts),
        usedFraction: row.usedFraction,
        resetsAt: Number.isFinite(row.resetsAt) ? Math.floor(row.resetsAt) : 0,
      });
    }
  }
}

function queryScopedHistoryRows(db, ctx, connId, since, cols) {
  if (ctx === null) {
    return db.all(
      `SELECT ${cols.replaceAll("qh.", "")}
       FROM quotaHistory
       WHERE connectionId = ? AND ts >= ?
       ORDER BY ts ASC, id ASC`,
      [connId, since],
    );
  }
  if (typeof ctx === "object" && typeof ctx.userId === "string" && ctx.userId) {
    return db.all(
      `SELECT ${cols}
       FROM quotaHistory qh
       JOIN providerConnections pc ON pc.id = qh.connectionId
       JOIN memberships m ON m.workspaceId = pc.workspaceId
       WHERE qh.connectionId = ? AND m.userId = ? AND qh.ts >= ?
       ORDER BY qh.ts ASC, qh.id ASC`,
      [connId, ctx.userId, since],
    );
  }
  // Fail closed on unrecognized/malformed ctx objects.
  return [];
}

/**
 * Scoped 7-day quota history for one connection, grouped by `quotaKey || windowKind`
 * for Quota page sparklines. Multi-user mode enforces live membership in SQL.
 *
 * @param {{ userId?: string }|null} ctx Principal/scope context (null in single-user mode)
 * @param {string} connectionId
 * @param {{ now?: number, windowMs?: number, maxPoints?: number }} [opts]
 * @returns {Promise<Record<string, Array<{ ts: number, usedPct: number }>>>}
 */
export async function getConnectionQuotaHistory(ctx, connectionId, opts = {}) {
  const connId = sanitizeConnectionId(connectionId);
  if (!connId) return {};

  const now = validNow(opts.now);
  const windowMs =
    Number.isFinite(opts.windowMs) && opts.windowMs > 0 ? opts.windowMs : H.sparklineWindowMs;
  const maxPoints =
    Number.isInteger(opts.maxPoints) && opts.maxPoints >= 2 ? opts.maxPoints : H.maxSparklinePoints;
  const since = now - windowMs;

  const db = await getAdapter();
  const rows = queryScopedHistoryRows(
    db,
    ctx,
    connId,
    since,
    "qh.windowKind, qh.quotaKey, qh.usedFraction, qh.ts",
  );

  const grouped = new Map();
  for (const row of rows) {
    const key = row.quotaKey || row.windowKind;
    if (!key || BLOCKED_KEYS.has(key.toLowerCase())) continue;
    const usedFraction = normalizeUsedFraction(row.usedFraction, "used01");
    if (usedFraction === null || !Number.isFinite(row.ts)) continue;
    let list = grouped.get(key);
    if (!list) {
      list = [];
      grouped.set(key, list);
    }
    list.push({
      ts: Math.floor(row.ts),
      usedPct: Math.round(usedFraction * 1000) / 10,
    });
  }

  const out = {};
  for (const [key, points] of grouped) {
    out[key] = downsampleHistoryPoints(points, maxPoints);
  }
  return out;
}

/**
 * Load raw history rows for one connection (for runway/burn-rate queries and
 * tests). Enforces live membership in SQL when multi-user `ctx` is present.
 */
export async function listConnectionQuotaHistoryRows(ctx, connectionId, opts = {}) {
  const connId = sanitizeConnectionId(connectionId);
  if (!connId) return [];

  const now = validNow(opts.now);
  const windowMs =
    Number.isFinite(opts.windowMs) && opts.windowMs > 0 ? opts.windowMs : H.sparklineWindowMs;
  const since = now - windowMs;
  const db = await getAdapter();

  return queryScopedHistoryRows(
    db,
    ctx,
    connId,
    since,
    "qh.connectionId, qh.provider, qh.windowKind, qh.quotaKey, qh.usedFraction, qh.resetsAt, qh.source, qh.ts",
  );
}

/**
 * Load the latest live snapshot windows per connection for startup restoration
 * (YAN-422). Reads strictly from `quotaHistory` (never touches `providerConnections`
 * or credential columns; FK cascade guarantees rows match live connections).
 */
export async function loadLatestSnapshotsUnscoped({ now = Date.now() } = {}) {
  const t = validNow(now);
  const ttlCutoff = t - QUOTA_SNAPSHOT.snapshotTtlMs;
  const db = await getAdapter();

  // Newest observation per (connection, canonical kind) is chosen BEFORE the liveness
  // filter, so an expired newest reading can never resurrect a superseded live one.
  // The result is bounded to one row per connection x kind.
  // Stored kinds are already canonical (sanitizedWindowKind). The DISTINCT pair scan and
  // the per-pair latest lookup both use idx_qh_conn_window_ts.
  const rows = db.all(
    `SELECT q.connectionId, q.provider, q.windowKind, q.quotaKey, q.usedFraction,
            q.resetsAt, q.planTier, q.source, q.ts
     FROM (SELECT DISTINCT connectionId, windowKind FROM quotaHistory) k
     JOIN quotaHistory q ON q.id = (
       SELECT id FROM quotaHistory
       WHERE connectionId = k.connectionId AND windowKind = k.windowKind AND ts <= ?
       ORDER BY ts DESC, usedFraction DESC, id DESC LIMIT 1
     )
     WHERE q.resetsAt > ? OR (q.resetsAt = 0 AND q.ts > ?)`,
    [t, t, ttlCutoff],
  );

  const byConn = new Map();
  for (const row of rows) {
    let entry = byConn.get(row.connectionId);
    if (!entry) {
      entry = {
        connectionId: row.connectionId,
        provider: row.provider,
        planTier: sanitizePlanTier(row.planTier),
        updatedAt: row.ts,
        windowsByKind: new Map(),
      };
      byConn.set(row.connectionId, entry);
    }
    if (!entry.planTier && row.planTier) entry.planTier = sanitizePlanTier(row.planTier);
    if (row.ts > entry.updatedAt) entry.updatedAt = row.ts;
    entry.windowsByKind.set(String(row.windowKind || "").toLowerCase(), {
      kind: row.windowKind,
      usedFraction: row.usedFraction,
      resetsAt: row.resetsAt,
      observedAt: row.ts,
      source: row.source === "header" ? "header" : "probe",
      ...(row.quotaKey ? { quotaKey: row.quotaKey } : {}),
    });
  }

  return {
    snapshots: [...byConn.values()].map((entry) => ({
      connectionId: entry.connectionId,
      provider: entry.provider,
      planTier: entry.planTier,
      updatedAt: entry.updatedAt,
      windows: [...entry.windowsByKind.values()],
    })),
    latestSeriesRows: rows,
  };
}

/**
 * Load recent probe samples (within `lookbackMs`) in chronological order so
 * startup hydration can restore in-memory runway forecasts (YAN-401/YAN-422).
 */
export async function loadRecentForecastSamplesUnscoped({
  now = Date.now(),
  lookbackMs = 120 * 60_000,
} = {}) {
  const t = validNow(now);
  const since = t - (Number.isFinite(lookbackMs) && lookbackMs > 0 ? lookbackMs : 120 * 60_000);
  const db = await getAdapter();

  return db.all(
    `SELECT connectionId, quotaKey, usedFraction, resetsAt, ts
     FROM quotaHistory
     WHERE source = 'probe'
       AND quotaKey <> ''
       AND ts >= ?
       AND ts <= ?
     ORDER BY ts ASC, id ASC`,
    [since, t],
  );
}

/**
 * Delete quotaHistory rows older than `retentionDays` in bounded batches,
 * yielding to the event loop between batches so pruning never stalls requests.
 *
 * @param {number} [retentionDays=60] Integer in 1..3650 (scheduler enforces 30..90).
 * @param {{ now?: number, batchSize?: number }} [opts]
 * @returns {Promise<{ deleted: number, batches: number }>}
 */
export async function pruneQuotaHistoryUnscoped(retentionDays = H.defaultRetentionDays, opts = {}) {
  const result = { deleted: 0, batches: 0 };
  const days = Number(retentionDays);
  if (!Number.isInteger(days) || days < 1) return result;

  const batchSize =
    Number.isInteger(opts.batchSize) && opts.batchSize > 0 ? opts.batchSize : H.pruneBatchSize;
  const cutoffMs = validNow(opts.now) - days * DAY_MS;
  const db = await getAdapter();

  for (;;) {
    const deleted = db.transaction(() => {
      const rows = db.all(
        `SELECT id FROM quotaHistory WHERE ts < ? ORDER BY ts ASC, id ASC LIMIT ?`,
        [cutoffMs, batchSize],
      );
      if (rows.length === 0) return 0;
      const ids = rows.map((r) => Number(r.id));
      const { changes } = db.run(`DELETE FROM quotaHistory WHERE id IN (${ids.join(",")})`);
      return changes;
    });
    if (!deleted) break;
    result.deleted += deleted;
    result.batches += 1;
    await yieldToLoop();
  }

  return result;
}

/** Test helper: clear the in-memory write rate-limiter cache. */
export function _resetQuotaHistoryWriteCache() {
  writeCache().clear();
}
