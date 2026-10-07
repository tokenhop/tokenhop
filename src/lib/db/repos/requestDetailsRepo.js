import { getAdapter, getAdapterSync } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { registerShutdownFlusher } from "../shutdownFlushers.js";
import { scopeSql, whereAll } from "./usageRollupRepo.js";

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_JSON_SIZE = 5 * 1024;
const CONFIG_CACHE_TTL_MS = 5000;

let cachedConfig = null;
let cachedConfigTs = 0;

async function getObservabilityConfig() {
  if (cachedConfig && Date.now() - cachedConfigTs < CONFIG_CACHE_TTL_MS) return cachedConfig;
  try {
    const { getSettings } = await import("./settingsRepo.js");
    const settings = await getSettings();
    // YAN-312: env var set → env value; else stored requestLogsEnabled; else
    // the legacy OBSERVABILITY_ENABLED fallback (default on).
    const envRequestLogs = process.env.ENABLE_REQUEST_LOGS;
    if (envRequestLogs !== undefined) {
      const enabled = envRequestLogs.toLowerCase() === "true";
      cachedConfig = {
        enabled,
        maxRecords:
          settings.observabilityMaxRecords ||
          parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
        batchSize:
          settings.observabilityBatchSize ||
          parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
        flushIntervalMs:
          settings.observabilityFlushIntervalMs ||
          parseInt(
            process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS),
            10,
          ),
        maxJsonSize:
          (settings.observabilityMaxJsonSize ||
            parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "5", 10)) * 1024,
      };
      cachedConfigTs = Date.now();
      return cachedConfig;
    }
    const envFallback = process.env.OBSERVABILITY_ENABLED !== "false";
    const storedFlag =
      typeof settings.requestLogsEnabled === "boolean" ? settings.requestLogsEnabled : null;
    const obsFlag =
      typeof settings.enableObservability === "boolean" ? settings.enableObservability : null;
    // YAN-312: the requestLogsEnabled setting is the primary switch; the
    // legacy enableObservability toggle stays as a fallback so old rows keep
    // working. Either one being explicitly true enables recording.
    const enabled =
      storedFlag === true ||
      obsFlag === true ||
      (storedFlag === null && obsFlag === null && envFallback);

    cachedConfig = {
      enabled,
      maxRecords:
        settings.observabilityMaxRecords ||
        parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
      batchSize:
        settings.observabilityBatchSize ||
        parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
      flushIntervalMs:
        settings.observabilityFlushIntervalMs ||
        parseInt(
          process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS),
          10,
        ),
      maxJsonSize:
        (settings.observabilityMaxJsonSize ||
          parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "5", 10)) * 1024,
    };
  } catch {
    cachedConfig = {
      enabled: false,
      maxRecords: DEFAULT_MAX_RECORDS,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      maxJsonSize: DEFAULT_MAX_JSON_SIZE,
    };
  }
  cachedConfigTs = Date.now();
  return cachedConfig;
}

const writeBuffer = [];
let flushTimer = null;
let isFlushing = false;

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  // HEAD semantics preserved: substring matching removes ANY credential
  // carrier — custom token-bearing headers included — never an exact-name
  // allowlist a renamed header could slip past. Gateway carriers
  // (x-9r-peer-token, x-9r-cli-token, x-goog-api-key, cookie) are matched by
  // the same substrings and removed, never kept or renamed.
  const sensitiveKeys = [
    "authorization",
    "x-api-key",
    "x-goog-api-key",
    "x-9r-cli-token",
    "x-9r-peer-token",
    "cookie",
    "token",
    "api-key",
  ];
  const sanitized = { ...headers };
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) delete sanitized[key];
  }
  return sanitized;
}

function sanitizeUrl(value) {
  if (typeof value !== "string" || !value) return value;
  try {
    const parsed = new URL(value);
    if (parsed.searchParams.has("key")) parsed.searchParams.set("key", "[REDACTED]");
    return parsed.toString();
  } catch {
    return value;
  }
}

export const __test__ = { sanitizeHeaders, sanitizeUrl };

function generateDetailId(model) {
  const timestamp = new Date().toISOString();
  const random = Math.random().toString(36).substring(2, 8);
  const modelPart = model ? model.replace(/[^a-zA-Z0-9-]/g, "-") : "unknown";
  return `${timestamp}-${random}-${modelPart}`;
}

function truncateField(obj, maxSize) {
  const str = JSON.stringify(obj || {});
  if (str.length > maxSize) {
    return { _truncated: true, _originalSize: str.length, _preview: str.substring(0, 200) };
  }
  return obj || {};
}

async function flushToDatabase() {
  if (isFlushing) return;
  if (writeBuffer.length === 0) return;
  isFlushing = true;
  try {
    // Drain entire buffer (loop in case more pushed during await)
    while (writeBuffer.length > 0) {
      // Adapter/config BEFORE the splice — if SIGTERM lands mid-await, the
      // buffer is still intact for the sync shutdown flush.
      const [db, config] = await Promise.all([getAdapter(), getObservabilityConfig()]);
      // Detach the batch, then write without yielding: the adapters' sync
      // signal handlers close the DB during any await here, losing the batch.
      const items = writeBuffer.splice(0, writeBuffer.length);
      writeBatch(db, items, config);
    }
  } catch (e) {
    console.error("[requestDetailsRepo] Batch write failed:", e);
  } finally {
    isFlushing = false;
  }
}

function writeBatch(db, items, config) {
  db.transaction(() => {
    for (const item of items) {
      if (!item.id) item.id = generateDetailId(item.model);
      if (!item.timestamp) item.timestamp = new Date().toISOString();
      if (item.request?.headers) item.request.headers = sanitizeHeaders(item.request.headers);
      if (item.request?.url) item.request.url = sanitizeUrl(item.request.url);

      const record = {
        id: item.id,
        provider: item.provider || null,
        model: item.model || null,
        connectionId: item.connectionId || null,
        // Trusted ID-only attribution (keyContext spread): validated
        // string-or-null, never raw credentials or arbitrary objects.
        apiKeyId: typeof item.apiKeyId === "string" ? item.apiKeyId : null,
        workspaceId: typeof item.workspaceId === "string" ? item.workspaceId : null,
        userId: typeof item.userId === "string" ? item.userId : null,
        grantId: typeof item.grantId === "string" ? item.grantId : null,
        timestamp: item.timestamp,
        status: item.status || null,
        latency: item.latency || {},
        tokens: item.tokens || {},
        request: truncateField(item.request, config.maxJsonSize),
        providerRequest: truncateField(item.providerRequest, config.maxJsonSize),
        providerResponse: truncateField(item.providerResponse, config.maxJsonSize),
        response: truncateField(item.response, config.maxJsonSize),
        pxpipe: item.pxpipe || undefined,
      };

      db.run(
        `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data, workspaceId, userId, apiKeyId, grantId)
         VALUES(?, ?, ?, ?, ?, ?, ?, (SELECT id FROM workspaces WHERE id = ?), (SELECT id FROM users WHERE id = ?), ?, ?)
         ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, provider = excluded.provider, model = excluded.model, connectionId = excluded.connectionId, status = excluded.status, data = excluded.data, workspaceId = excluded.workspaceId, userId = excluded.userId, apiKeyId = excluded.apiKeyId, grantId = excluded.grantId`,
        [
          record.id,
          record.timestamp,
          record.provider,
          record.model,
          record.connectionId,
          record.status,
          stringifyJson(record),
          record.workspaceId,
          record.userId,
          record.apiKeyId ?? "local-no-key",
          record.grantId,
        ],
      );
    }

    // Cap per workspace (YAN-370, plan D7): one busy workspace must not
    // evict every other workspace's details. NULL workspace is its own group.
    for (const g of db.all(
      `SELECT workspaceId, COUNT(*) AS c FROM requestDetails GROUP BY workspaceId HAVING c > ?`,
      [config.maxRecords],
    )) {
      const ws = g.workspaceId == null ? "workspaceId IS NULL" : "workspaceId = ?";
      db.run(
        `DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails WHERE ${ws} ORDER BY timestamp ASC LIMIT ?)`,
        g.workspaceId == null
          ? [g.c - config.maxRecords]
          : [g.workspaceId, g.c - config.maxRecords],
      );
    }
  });
}

export async function saveRequestDetailUnscoped(detail) {
  const config = await getObservabilityConfig();
  if (!config.enabled) {
    return;
  }

  writeBuffer.push(detail);

  // Trigger immediate flush if batch threshold reached.
  // flushToDatabase() drains entire buffer in a loop, so all pushes during await are persisted.
  if (writeBuffer.length >= config.batchSize) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flushToDatabase().catch((e) => console.error("[requestDetailsRepo] flush err:", e));
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushToDatabase().catch(() => {});
    }, config.flushIntervalMs);
  }
}

/**
 * Paged request details within the usage scope `ctx` (null: unscoped). Each
 * row carries its `workspaceId`/`userId` columns so the route can decide body
 * visibility per row (plan D10).
 */
export async function getRequestDetails(ctx, filter = {}) {
  const db = await getAdapter();
  const scope = scopeSql(ctx);
  const conds = scope.sql ? [scope.sql] : [];
  const params = [...scope.params];

  if (filter.provider) {
    conds.push("provider = ?");
    params.push(filter.provider);
  }
  if (filter.model) {
    conds.push("model = ?");
    params.push(filter.model);
  }
  if (filter.connectionId) {
    conds.push("connectionId = ?");
    params.push(filter.connectionId);
  }
  if (filter.status) {
    conds.push("status = ?");
    params.push(filter.status);
  }
  if (filter.startDate) {
    conds.push("timestamp >= ?");
    params.push(new Date(filter.startDate).toISOString());
  }
  if (filter.endDate) {
    conds.push("timestamp <= ?");
    params.push(new Date(filter.endDate).toISOString());
  }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const cntRow = db.get(`SELECT COUNT(*) as c FROM requestDetails ${where}`, params);
  const totalItems = cntRow ? cntRow.c : 0;

  const page = filter.page || 1;
  const pageSize = filter.pageSize || 50;
  const totalPages = Math.ceil(totalItems / pageSize);
  const offset = (page - 1) * pageSize;

  const rows = db.all(
    `SELECT data, workspaceId, userId FROM requestDetails ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  // Columns win over the data JSON: owner bootstrap adopts NULL rows later.
  const details = rows.map((r) => ({
    ...parseJson(r.data, {}),
    ...(r.workspaceId ? { workspaceId: r.workspaceId } : {}),
    ...(r.userId ? { userId: r.userId } : {}),
  }));

  return {
    details,
    pagination: {
      page,
      pageSize,
      totalItems,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
}

export async function getDistinctProviders(ctx) {
  const db = await getAdapter();
  const scope = scopeSql(ctx);
  const rows = db.all(
    `SELECT DISTINCT provider FROM requestDetails ${whereAll(scope.sql, "provider IS NOT NULL")} ORDER BY provider ASC`,
    scope.params,
  );
  return rows.map((r) => r.provider);
}

export async function getRequestDetailById(ctx, id) {
  const db = await getAdapter();
  const scope = scopeSql(ctx);
  const row = db.get(`SELECT data FROM requestDetails ${whereAll(scope.sql, "id = ?")}`, [
    ...scope.params,
    id,
  ]);
  return row ? parseJson(row.data, null) : null;
}

// Sync flush for the DB adapters' SIGTERM/SIGINT handlers: they close the DB
// synchronously before process.exit, so an async flushToDatabase() would lose
// whatever is still buffered.
function flushSync() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (writeBuffer.length === 0) return;
  const items = writeBuffer.splice(0, writeBuffer.length);
  try {
    writeBatch(
      getAdapterSync(),
      items,
      cachedConfig ?? {
        maxRecords: DEFAULT_MAX_RECORDS,
        batchSize: DEFAULT_BATCH_SIZE,
        flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
        maxJsonSize: DEFAULT_MAX_JSON_SIZE,
      },
    );
  } catch (e) {
    try {
      console.error("[requestDetailsRepo] Shutdown flush failed:", e);
    } catch {}
  }
}

function ensureShutdownFlusher() {
  // Slot on a global registry — adapters and the app's signal cleanup call it
  // before closing the DB. Plain object slot so dev hot-reload replaces it.
  registerShutdownFlusher("requestDetails", flushSync);
  // Own listeners still cover sql.js (its handler only persists) and any
  // process.exit() path. Stash the handler globally so hot reload swaps it
  // instead of stacking listeners.
  const events = ["beforeExit", "SIGINT", "SIGTERM", "exit"];
  const prev = globalThis.__requestDetailsFlushSync;
  if (prev) for (const event of events) process.off(event, prev);
  globalThis.__requestDetailsFlushSync = flushSync;
  for (const event of events) process.on(event, flushSync);
}

ensureShutdownFlusher();
