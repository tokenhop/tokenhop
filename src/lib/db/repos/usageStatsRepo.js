// Usage stats and chart readers (YAN-370). Day-grain periods read the
// usageRollup table, sub-day periods read usageHistory; both feed one
// aggregator so the response shape is identical either way. `ctx` is a usage
// scope: null is the unscoped view (switch off / one user), otherwise
// `{ workspaceId, userId? }` (see usageRollupRepo.scopeSql).
import { createHash } from "node:crypto";
import { getAdapter } from "../driver.js";
import { parseJson } from "../helpers/jsonCol.js";
import {
  PERIOD_DAYS,
  isCustomPeriod,
  isRollupOnlyPeriod,
  periodStart,
} from "@/shared/utils/period";
import { readApiKeyStorageState } from "../apiKeyState.js";
import { apiKeysHasKeyHash } from "../helpers/apiKeysSchema.js";
import { lastErrorFor, pendingView } from "./usageLiveFeed.js";
import { buildAllTimeBuckets } from "@/lib/usage/allTimeBuckets.js";
import { customChartBuckets } from "@/lib/usage/customRange.js";
import { rollupLatencySummary } from "../helpers/usageLatencyRollup.js";
import {
  NO_KEY,
  cutoffDateKey,
  localDateKey,
  readRollup,
  readRollupDaily,
  readLatencyRollup,
  scopeSql,
  whereAll,
} from "./usageRollupRepo.js";

function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  if (key.length <= 8) return `${key.charAt(0)}***`;
  return `${key.slice(0, 8)}***`;
}

/**
 * Key id → display metadata. Usage rows hold an id, a `historical:` pseudonym
 * or 'local-no-key' (migration 014), never a raw key. Legacy storage still has
 * the raw in apiKeys, so its masked prefix is shown as before; hashed storage
 * never shows one.
 */
export async function apiKeyNames(db) {
  let hashed = false;
  try {
    hashed = readApiKeyStorageState(db).storage === "hashed";
  } catch {}
  if (!hashed) {
    try {
      hashed = apiKeysHasKeyHash(db);
    } catch {}
  }
  const map = {};
  try {
    const cols = hashed ? "id, name" : "id, name, key";
    for (const r of db.all(`SELECT ${cols} FROM apiKeys`)) {
      const masked = hashed ? null : maskApiKey(r.key);
      map[r.id] = { name: r.name || masked || r.id, masked };
    }
  } catch {}
  return map;
}

function apiKeyIdentity(apiKeyId, names) {
  if (!apiKeyId || apiKeyId === NO_KEY) {
    return { id: NO_KEY, keyName: "Local (no API key)", apiKeyMasked: null };
  }
  const info = names[apiKeyId];
  if (info) return { id: apiKeyId, keyName: info.name, apiKeyMasked: info.masked };
  const tag = createHash("sha256").update(apiKeyId).digest("hex").slice(0, 6);
  return { id: apiKeyId, keyName: `Unknown key (${tag})`, apiKeyMasked: null };
}

async function nameMaps() {
  const [{ getProviderConnectionsUnscoped }, { getProviderNodesUnscoped }] = await Promise.all([
    import("./connectionsRepo.js"),
    import("./nodesRepo.js"),
  ]);
  const connections = {};
  const nodes = {};
  try {
    for (const c of await getProviderConnectionsUnscoped())
      connections[c.id] = c.name || c.email || c.id;
  } catch {}
  try {
    for (const n of await getProviderNodesUnscoped()) if (n.id && n.name) nodes[n.id] = n.name;
  } catch {}
  return { connections, nodes };
}

const zero = () => ({
  requests: 0,
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  cost: 0,
});

function bump(target, key, init, row, lastUsed) {
  target[key] ||= { ...zero(), ...init, lastUsed };
  const t = target[key];
  t.requests += row.requests;
  t.promptTokens += row.tokensIn;
  t.completionTokens += row.tokensOut;
  t.cachedTokens += row.tokensCached;
  t.cost += row.cost;
  if (lastUsed > (t.lastUsed || "")) t.lastUsed = lastUsed;
}

/** Fold rollup-shaped rows (`lastUsed` = dateKey or timestamp) into the stats buckets. */
function aggregate(stats, rows, { connections, nodes }, keyNames) {
  for (const r of rows) {
    const model = r.model || "";
    const provider = r.provider || "";
    const display = nodes[provider] || provider;
    stats.totalPromptTokens += r.tokensIn;
    stats.totalCompletionTokens += r.tokensOut;
    stats.totalCachedTokens += r.tokensCached;
    stats.totalCost += r.cost;
    if (r.provider) bump(stats.byProvider, provider, {}, r);
    bump(
      stats.byModel,
      provider ? `${model} (${provider})` : model,
      { rawModel: model, provider: display },
      r,
      r.lastUsed,
    );
    if (r.connectionId) {
      const accountName = connections[r.connectionId] || `Account ${r.connectionId.slice(0, 8)}...`;
      bump(
        stats.byAccount,
        `${model} (${provider} - ${accountName})`,
        { rawModel: model, provider: display, connectionId: r.connectionId, accountName },
        r,
        r.lastUsed,
      );
    }
    const key = apiKeyIdentity(r.apiKeyId, keyNames);
    bump(
      stats.byApiKey,
      `${key.id}|${model}|${provider || "unknown"}`,
      {
        rawModel: model,
        provider: display,
        apiKeyMasked: key.apiKeyMasked,
        keyName: key.keyName,
        apiKeyKey: key.id,
      },
      r,
      r.lastUsed,
    );
    const endpoint = r.endpoint || "Unknown";
    bump(
      stats.byEndpoint,
      `${endpoint}|${model}|${provider || "unknown"}`,
      { endpoint, rawModel: model, provider: display },
      r,
      r.lastUsed,
    );
  }
  for (const b of Object.values(stats.byProvider)) delete b.lastUsed;
}

// Endpoints whose rows carry meta.latencyMs / meta.empty (edit predictions, YAN-736).
const LATENCY_ENDPOINTS = ["completions"];
const LATENCY_SAMPLE_CAP = 20000;

function latencySummary(samples) {
  const ms = samples.filter((s) => s.ms !== null).map((s) => s.ms);
  ms.sort((a, b) => a - b);
  const mid = ms.length >> 1;
  return {
    latencyAvgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null,
    latencyP50Ms: ms.length
      ? Math.round(ms.length % 2 ? ms[mid] : (ms[mid - 1] + ms[mid]) / 2)
      : null,
    emptyRate: samples.length ? samples.filter((s) => s.empty).length / samples.length : null,
    samples: samples.length,
  };
}

/**
 * Avg/p50 latency and empty-result rate for LATENCY_ENDPOINTS (YAN-743).
 * Day periods and `all` use rollups (YAN-771, full window, coarse p50);
 * sub-day periods keep the capped-history semantics.
 * ponytail: sub-day periods load up to LATENCY_SAMPLE_CAP rows; move them to
 * finer rollups if full-window coverage is needed there too.
 */
function addCompletionsLatency(stats, db, scope, period, ctx, range = null) {
  if (range || PERIOD_DAYS[period] || period === "all") {
    const byKey = {};
    const byEndpoint = {};
    const startKey = range
      ? range.from
      : period === "all"
        ? null
        : cutoffDateKey(PERIOD_DAYS[period]);
    const endKey = range ? range.to : null;
    for (const endpoint of LATENCY_ENDPOINTS) {
      const rows = readLatencyRollup(ctx, db, endpoint, startKey, endKey);
      if (!rows.length) continue;
      byEndpoint[endpoint] = rollupLatencySummary(rows);
      for (const r of rows) {
        const key = `${r.endpoint}|${r.model || ""}|${r.provider || "unknown"}`;
        byKey[key] ||= [];
        byKey[key].push(r);
      }
    }
    for (const [key, rows] of Object.entries(byKey)) {
      const { samples: _n, ...summary } = rollupLatencySummary(rows);
      if (stats.byEndpoint[key]) Object.assign(stats.byEndpoint[key], summary);
    }
    stats.endpointLatency = byEndpoint;
    return;
  }
  // Same window as the history rows above.
  const cutoff = periodStart(period, Date.now());
  const rows = db.all(
    `SELECT endpoint, model, provider,
       CASE WHEN json_valid(meta) THEN json_extract(meta, '$.latencyMs') END AS ms,
       CASE WHEN json_valid(meta) THEN json_extract(meta, '$.empty') END AS empty
     FROM usageHistory ${whereAll(scope.sql, `endpoint IN (${LATENCY_ENDPOINTS.map(() => "?").join(",")})`, "timestamp >= ?")}
     ORDER BY timestamp DESC, id DESC LIMIT ${LATENCY_SAMPLE_CAP}`,
    [...scope.params, ...LATENCY_ENDPOINTS, new Date(cutoff).toISOString()],
  );
  const byKey = {};
  const byEndpoint = {};
  for (const r of rows) {
    const ms = Number(r.ms);
    const sample = {
      ms: r.ms !== null && Number.isFinite(ms) ? ms : null,
      empty: Boolean(r.empty),
    };
    const key = `${r.endpoint}|${r.model || ""}|${r.provider || "unknown"}`;
    byKey[key] ||= [];
    byKey[key].push(sample);
    byEndpoint[r.endpoint] ||= [];
    byEndpoint[r.endpoint].push(sample);
  }
  for (const [key, samples] of Object.entries(byKey)) {
    const { samples: _n, ...summary } = latencySummary(samples);
    if (stats.byEndpoint[key]) Object.assign(stats.byEndpoint[key], summary);
  }
  stats.endpointLatency = Object.fromEntries(
    Object.entries(byEndpoint).map(([ep, samples]) => [ep, latencySummary(samples)]),
  );
}

/** Token counts for one usageHistory row: prompt/completion from the
 * columns only, cached from the tokens JSON (both cache aliases). Shared by
 * the stats aggregator and the usage export so their totals always match. */
export function historyTokens(r) {
  const t = parseJson(r.tokens, {}) || {};
  return {
    tokensIn: r.promptTokens || 0,
    tokensOut: r.completionTokens || 0,
    tokensCached: t.cached_tokens || t.cache_read_input_tokens || 0,
  };
}

const historyRow = (r) => ({
  ...r,
  requests: 1,
  ...historyTokens(r),
  cost: r.cost || 0,
  lastUsed: r.timestamp,
});

/**
 * Custom ranges (YAN-426) arrive pre-validated by the route as inclusive local
 * day keys; anything else here is a programming error.
 */
function requireRange(period, range) {
  if (!isCustomPeriod(period)) return null;
  if (!range?.from || !range?.to) throw new Error("custom period requires a {from, to} range");
  return range;
}

/**
 * @param {object|null} ctx usage scope
 * @param {string} [period] a named period, or "custom" with `range`
 * @param {{from: string, to: string}|null} [range] inclusive local day keys (custom only)
 */
export async function getUsageStats(ctx, period = "all", range = null) {
  const customRange = requireRange(period, range);
  const db = await getAdapter();
  const scope = scopeSql(ctx);
  const [maps, keyNames] = [await nameMaps(), await apiKeyNames(db)];
  const pending = pendingView(ctx);

  const seen = new Set();
  const recentRequests = db
    .all(
      `SELECT timestamp, provider, model, tokens, status FROM usageHistory ${whereAll(scope.sql)} ORDER BY id DESC LIMIT 100`,
      scope.params,
    )
    .map((r) => {
      const t = parseJson(r.tokens, {}) || {};
      return {
        timestamp: r.timestamp,
        model: r.model,
        provider: r.provider || "",
        promptTokens: t.prompt_tokens || t.input_tokens || 0,
        completionTokens: t.completion_tokens || t.output_tokens || 0,
        cachedTokens: t.cached_tokens || t.cache_read_input_tokens || 0,
        status: r.status || "ok",
      };
    })
    .filter((e) => {
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const key = `${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${e.timestamp?.slice(0, 16) || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);

  const stats = {
    totalRequests: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCachedTokens: 0,
    totalCost: 0,
    byProvider: {},
    byModel: {},
    byAccount: {},
    byApiKey: {},
    byEndpoint: {},
    last10Minutes: [],
    pending,
    activeRequests: [],
    recentRequests,
    errorProvider: lastErrorFor(ctx),
  };

  for (const [connectionId, models] of Object.entries(pending.byAccount)) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (!(count > 0)) continue;
      const match = modelKey.match(/^(.*) \((.*)\)$/);
      stats.activeRequests.push({
        model: match ? match[1] : modelKey,
        provider: match ? match[2] : "unknown",
        account: maps.connections[connectionId] || `Account ${connectionId.slice(0, 8)}...`,
        count,
      });
    }
  }

  const now = new Date();
  const minuteStart = Math.floor(now.getTime() / 60000) * 60000;
  const buckets = {};
  for (let i = 0; i < 10; i++) {
    buckets[minuteStart - (9 - i) * 60000] = {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
    };
    stats.last10Minutes.push(buckets[minuteStart - (9 - i) * 60000]);
  }
  for (const r of db.all(
    `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory ${whereAll(scope.sql, "timestamp >= ?", "timestamp <= ?")}`,
    [...scope.params, new Date(minuteStart - 9 * 60000).toISOString(), now.toISOString()],
  )) {
    const b = buckets[Math.floor(new Date(r.timestamp).getTime() / 60000) * 60000];
    if (!b) continue;
    b.requests++;
    b.promptTokens += r.promptTokens || 0;
    b.completionTokens += r.completionTokens || 0;
    b.cost += r.cost || 0;
  }

  const HIST_COLS = `timestamp, provider, model, connectionId, apiKeyId, endpoint, promptTokens, completionTokens, cost, tokens`;
  if (customRange) {
    // Rollup only, never usageHistory: lastUsed is the rollup dateKey (like 90d/all).
    const rows = readRollup(ctx, db, customRange.from, customRange.to);
    aggregate(
      stats,
      rows.map((r) => ({ ...r, lastUsed: r.dateKey })),
      maps,
      keyNames,
    );
  } else if (period === "24h" || period === "today") {
    const rows = db.all(
      `SELECT ${HIST_COLS} FROM usageHistory ${whereAll(scope.sql, "timestamp >= ?")}`,
      [...scope.params, new Date(periodStart(period, Date.now())).toISOString()],
    );
    aggregate(stats, rows.map(historyRow), maps, keyNames);
  } else {
    const maxDays = PERIOD_DAYS[period] || null;
    const rows = readRollup(ctx, db, maxDays ? cutoffDateKey(maxDays) : null);
    aggregate(
      stats,
      rows.map((r) => ({ ...r, lastUsed: r.dateKey })),
      maps,
      keyNames,
    );
    // Overlay precise lastUsed timestamps for 7d/30d/60d, grouped in SQL so
    // full windows don't load per-request rows. 90d and all stay rollup-only
    // (lastUsed = rollup dateKey) so they never scan usageHistory.
    if (maxDays && !isRollupOnlyPeriod(period)) {
      const lastUsedSql = `SELECT MAX(timestamp) AS timestamp, provider, model, connectionId, apiKeyId, endpoint
         FROM usageHistory ${whereAll(scope.sql, "timestamp >= ?")}
         GROUP BY provider, model, connectionId, apiKeyId, endpoint`;
      const cutoff = Date.now() - maxDays * 86400000;
      for (const e of db.all(lastUsedSql, [...scope.params, new Date(cutoff).toISOString()])) {
        const model = e.model || "";
        const provider = e.provider || "";
        const keys = [
          [stats.byModel, provider ? `${model} (${provider})` : model],
          [
            stats.byApiKey,
            `${apiKeyIdentity(e.apiKeyId, keyNames).id}|${model}|${provider || "unknown"}`,
          ],
          [stats.byEndpoint, `${e.endpoint || "Unknown"}|${model}|${provider || "unknown"}`],
        ];
        if (e.connectionId) {
          const name =
            maps.connections[e.connectionId] || `Account ${e.connectionId.slice(0, 8)}...`;
          keys.push([stats.byAccount, `${model} (${provider} - ${name})`]);
        }
        for (const [bucket, key] of keys) {
          if (bucket[key] && new Date(e.timestamp) > new Date(bucket[key].lastUsed))
            bucket[key].lastUsed = e.timestamp;
        }
      }
    }
  }

  addCompletionsLatency(stats, db, scope, period, ctx, customRange);
  stats.totalRequests = Object.values(stats.byProvider).reduce((s, p) => s + (p.requests || 0), 0);
  return stats;
}

const hourLabel = (ts) =>
  new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

export async function getChartData(ctx, period = "7d", range = null) {
  const customRange = requireRange(period, range);
  const db = await getAdapter();
  if (customRange)
    return customChartBuckets(
      readRollupDaily(ctx, db, customRange.from, customRange.to),
      customRange,
    );
  const scope = scopeSql(ctx);
  const now = Date.now();

  if (period === "today" || period === "24h") {
    const bucketMs = 3600000;
    const startTime = periodStart(period, now);
    const endTime = period === "today" ? startTime + 24 * bucketMs : now;
    const buckets = Array.from({ length: 24 }, (_, i) => ({
      label: hourLabel(startTime + i * bucketMs),
      input: 0,
      cached: 0,
      output: 0,
      tokens: 0,
      cost: 0,
      requests: 0,
    }));
    for (const r of db.all(
      `SELECT timestamp, promptTokens, completionTokens, cost, tokens FROM usageHistory ${whereAll(scope.sql, "timestamp >= ?")}`,
      [...scope.params, new Date(startTime).toISOString()],
    )) {
      const t = new Date(r.timestamp).getTime();
      if (t < startTime || (period === "today" ? t >= endTime : t > endTime)) continue;
      const idx = Math.min(Math.floor((t - startTime) / bucketMs), 23);
      const tk = parseJson(r.tokens, {}) || {};
      const cached = tk.cached_tokens || tk.cache_read_input_tokens || 0;
      const input = Math.max(tk.prompt_tokens || tk.input_tokens || r.promptTokens || 0, cached);
      const output = tk.completion_tokens || tk.output_tokens || r.completionTokens || 0;
      const b = buckets[idx];
      b.input += input;
      b.cached += cached;
      b.output += output;
      b.tokens += input + output;
      b.cost += r.cost || 0;
      b.requests += 1;
    }
    return buckets;
  }

  if (period === "all") return buildAllTimeBuckets(readRollupDaily(ctx, db, null));

  const bucketCount = PERIOD_DAYS[period];
  const days = {};
  for (const r of readRollupDaily(ctx, db, cutoffDateKey(bucketCount))) {
    days[r.dateKey] ||= { requests: 0, prompt: 0, cached: 0, output: 0, cost: 0 };
    const d = days[r.dateKey];
    d.requests += r.requests;
    d.prompt += r.tokensIn;
    d.cached += r.tokensCached;
    d.output += r.tokensOut;
    d.cost += r.cost;
  }
  const today = new Date();
  return Array.from({ length: bucketCount }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (bucketCount - 1 - i));
    const day = days[localDateKey(d)];
    const input = day ? Math.max(day.prompt, day.cached) : 0;
    const output = day ? day.output : 0;
    return {
      label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      input,
      cached: day ? day.cached : 0,
      output,
      tokens: input + output,
      cost: day ? day.cost : 0,
      requests: day ? day.requests : 0,
    };
  });
}

// --- Usage export (YAN-425) -------------------------------------------------
// Streaming readers for GET /api/usage/export. Daily rows follow the
// on-screen totals: sub-day periods (today, 24h) fold usageHistory from
// periodStart; day-grain periods (7d..90d), `all` and custom ranges read
// usageRollup by local day key. Request rows always read usageHistory:
// named periods use the same local-day cutoff converted to ms (periodStart
// for day-grain periods is local midnight of the first rollup day; today/24h
// use their exact periodStart), custom ranges use the local-day bounds of
// from..to inclusive, and `all` has no lower bound. History retention is
// opt-in (default keeps forever), so pruned days simply have no request
// rows; daily rollup rows are unaffected by pruning.

const EXPORT_PAGE_SIZE = 500;

/**
 * Page through usageHistory rows in `[window.startMs, window.nowMs]` within
 * scope (startMs null = no lower bound), oldest first, keyset-paginated on
 * the row id. Each yielded row is shaped for the export: connection id
 * resolved to its display name, apiKeyId to the key's display name + masked
 * prefix (never a raw key), token counts via historyTokens (the same
 * normalization getUsageStats uses), and `saved_tokens_est` summed from
 * meta.savings (0 when the row has none). `api_key_id` rides along for the
 * daily fold's group key; it is not an export column.
 * @param {object|null} ctx usage scope
 * @param {{startMs: number|null, nowMs: number}} window
 */
export async function* streamRequestRows(ctx, { startMs, nowMs }) {
  const db = await getAdapter();
  const scope = scopeSql(ctx);
  const [maps, keyNames] = [await nameMaps(), await apiKeyNames(db)];
  const startIso = startMs == null ? null : new Date(startMs).toISOString();
  const endIso = new Date(nowMs).toISOString();
  // Keyset on (timestamp, id) over the existing `(.., timestamp DESC)`
  // indexes: SQLite scans those indexes backward, yielding rows in
  // `timestamp ASC, rowid(id) DESC` order with no temp B-tree, so a scoped
  // page seeks to the cursor instead of temp-sorting by id. The lower bound
  // stays a separate `timestamp >= startIso` term. Row-value
  // `(timestamp, id)` comparison is avoided for adapter safety
  // (sql.js/node:sqlite); the expanded OR form plans identically.
  let lastTs = null;
  let lastId = 0;
  for (;;) {
    const rows = db.all(
      `SELECT id, timestamp, provider, model, connectionId, apiKeyId, endpoint, promptTokens, completionTokens, cost, status, tokens, meta
       FROM usageHistory ${whereAll(
         scope.sql,
         startIso ? "timestamp >= ?" : "",
         "timestamp <= ?",
         lastTs ? "(timestamp > ? OR (timestamp = ? AND id < ?))" : "",
       )}
       ORDER BY timestamp ASC, id DESC LIMIT ?`,
      [
        ...scope.params,
        ...(startIso ? [startIso] : []),
        endIso,
        ...(lastTs ? [lastTs, lastTs, lastId] : []),
        EXPORT_PAGE_SIZE,
      ],
    );
    if (!rows.length) return;
    for (const r of rows) {
      const key = apiKeyIdentity(r.apiKeyId, keyNames);
      const tokens = historyTokens(r);
      yield {
        timestamp: r.timestamp,
        provider: r.provider || "",
        model: r.model || "",
        account: r.connectionId
          ? maps.connections[r.connectionId] || `Account ${r.connectionId.slice(0, 8)}...`
          : "",
        account_id: r.connectionId || "",
        api_key: key.keyName,
        api_key_id: r.apiKeyId || "",
        api_key_masked: key.apiKeyMasked || "",
        endpoint: r.endpoint || "",
        prompt_tokens: tokens.tokensIn,
        completion_tokens: tokens.tokensOut,
        cached_tokens: tokens.tokensCached,
        cost: r.cost || 0,
        status: r.status || "",
        saved_tokens_est: savedTokensOf(r.meta),
      };
    }
    lastTs = rows[rows.length - 1].timestamp;
    lastId = rows[rows.length - 1].id;
  }
}

function savedTokensOf(meta) {
  const savings = parseJson(meta, {})?.savings;
  if (!savings || typeof savings !== "object") return 0;
  const methods = savings.byMethod;
  if (!methods || typeof methods !== "object") return 0;
  let saved = 0;
  for (const method of Object.values(methods)) {
    const value = Number(method?.tokensSavedEst) || 0;
    if (value > 0) saved += value;
  }
  return saved;
}

/**
 * Page through usageRollup rows in `[fromKey, toKey]` (either bound null =
 * open) within scope, keyset-paginated on the rollup's dimension key. Rows
 * are export-shaped; `saved_tokens_est` is 0 because the rollup carries no
 * per-request savings (that estimate only exists on usageHistory meta).
 * @param {object|null} ctx usage scope
 * @param {{fromKey: string|null, toKey: string|null}} window inclusive day keys
 */
export async function* streamDailyRows(ctx, { fromKey, toKey }) {
  const db = await getAdapter();
  const scope = scopeSql(ctx);
  const [maps, keyNames] = [await nameMaps(), await apiKeyNames(db)];
  const cursorCols = ["dateKey", ...DIMS_EXPORT];
  let cursor = null;
  for (;;) {
    const params = [...scope.params];
    if (fromKey) params.push(fromKey);
    if (toKey) params.push(toKey);
    if (cursor) params.push(cursor[0], ...cursor);
    const proj = DIMS_EXPORT.map((k) => (k === "apiKeyId" ? k : `NULLIF(${k}, '') AS ${k}`)).join(
      ", ",
    );
    // ORDER BY the table columns (usageRollup.<col>), not the NULLIF output
    // aliases — alias ordering forces a temp sort. The extra
    // `dateKey >= cursorDate` term lets the PK seek to the cursor's day.
    const orderBy = cursorCols.map((c) => `usageRollup.${c}`).join(", ");
    const rows = db.all(
      `SELECT dateKey, ${proj}, requests, tokensIn, tokensOut, tokensCached, cost FROM usageRollup
       ${whereAll(
         scope.sql,
         fromKey ? "dateKey >= ?" : "",
         toKey ? "dateKey <= ?" : "",
         cursor ? "dateKey >= ?" : "",
         cursor ? `(${cursorCols.join(", ")}) > (${cursorCols.map(() => "?").join(", ")})` : "",
       )}
       ORDER BY ${orderBy} LIMIT ?`,
      [...params, EXPORT_PAGE_SIZE],
    );
    if (!rows.length) return;
    for (const r of rows) {
      const key = apiKeyIdentity(r.apiKeyId, keyNames);
      yield {
        date: r.dateKey,
        provider: r.provider || "",
        model: r.model || "",
        account: r.connectionId
          ? maps.connections[r.connectionId] || `Account ${r.connectionId.slice(0, 8)}...`
          : "",
        account_id: r.connectionId || "",
        api_key: key.keyName,
        api_key_id: r.apiKeyId || "",
        api_key_masked: key.apiKeyMasked || "",
        endpoint: r.endpoint || "",
        requests: r.requests || 0,
        prompt_tokens: r.tokensIn || 0,
        completion_tokens: r.tokensOut || 0,
        cached_tokens: r.tokensCached || 0,
        cost: Number((r.cost || 0).toFixed(9)),
        saved_tokens_est: 0,
      };
    }
    const last = rows[rows.length - 1];
    cursor = cursorCols.map((c) => last[c] ?? "");
  }
}

const DIMS_EXPORT = [
  "workspaceId",
  "userId",
  "apiKeyId",
  "provider",
  "model",
  "connectionId",
  "endpoint",
];
