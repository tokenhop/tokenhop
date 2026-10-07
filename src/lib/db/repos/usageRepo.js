import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { getMetaSync, setMetaSync } from "../helpers/metaStore.js";
import { isPeriod, periodStart, previousPeriodRange } from "@/shared/utils/period";
import { readApiKeyStorageState } from "../apiKeyState.js";
import { normalizeUsageKeyEntry } from "../helpers/usageKeyIdentity.js";
import { tableHasColumn } from "../migrations/helpers.js";
import { getApiKeyHashKey } from "../../security/apiKeyHashKey.js";
import { pushToRing, scheduleStatsEvent } from "./usageLiveFeed.js";
import { apiKeyNames } from "./usageStatsRepo.js";
import {
  NO_KEY,
  legacyKeyId,
  localDateKey,
  scopeSql,
  upsertRollupRowUnscoped,
  whereAll,
} from "./usageRollupRepo.js";

/** _meta keys for the YAN-408 lifetime savings counter. */
export const SAVINGS_LIFETIME_KEY = "savingsTokensLifetime";

/**
 * Sum the saved tokens of every usageHistory row (YAN-408). One SQL aggregate
 * using JSON1 (`json_each`/`json_extract` ship with every supported driver —
 * `getUsageTotals` already relies on them), so JS never sees the rows. Sums
 * only positive per-method `tokensSavedEst`, matching rowSavedFromSavings.
 * Runs at most once per install, before any incremental counter write.
 * @param {object} adapter sync DB adapter (inside a transaction)
 * @returns {number} lifetime saved tokens across all recorded rows
 */
export function backfillSavingsLifetimeUnscoped(adapter) {
  const row = adapter.get(
    `SELECT COALESCE(SUM(CAST(json_extract(j.value, '$.tokensSavedEst') AS REAL)), 0) AS lifetime
     FROM usageHistory u, json_each(u.meta, '$.savings.byMethod') j
     WHERE u.meta IS NOT NULL AND json_valid(u.meta)
       AND CAST(json_extract(j.value, '$.tokensSavedEst') AS REAL) > 0`,
  );
  return Number(row?.lifetime) || 0;
}

/**
 * Total tokens saved by the token savers across all recorded requests (YAN-408
 * milestone toast). On first read the counter is backfilled from history
 * exactly once; after that it is a point lookup.
 * @returns {Promise<number>}
 */
export async function getSavingsLifetime(ctx) {
  const db = await getAdapter();
  // Scoped (YAN-370): the caller's own rows, summed on read. The _meta
  // counter is the instance-wide (single-user) total.
  if (ctx) return scopedSavedTokens(db, ctx);
  const stored = getMetaSync(db, SAVINGS_LIFETIME_KEY, null);
  if (stored !== null) return Number(stored) || 0;
  let lifetime = 0;
  db.transaction(() => {
    lifetime = backfillSavingsLifetimeUnscoped(db);
    setMetaSync(db, SAVINGS_LIFETIME_KEY, lifetime);
  });
  return lifetime;
}

function scopedSavedTokens(db, ctx) {
  const scope = scopeSql(ctx, "u.");
  const row = db.get(
    `SELECT COALESCE(SUM(CAST(json_extract(j.value, '$.tokensSavedEst') AS REAL)), 0) AS saved
     FROM usageHistory u, json_each(u.meta, '$.savings.byMethod') j
     WHERE ${scope.sql} AND u.meta IS NOT NULL AND json_valid(u.meta)
       AND CAST(json_extract(j.value, '$.tokensSavedEst') AS REAL) > 0`,
    scope.params,
  );
  return Number(row?.saved) || 0;
}

/**
 * Requests per minute over the last 15 minutes as 15 integer buckets (YAN-408
 * heartbeat). One indexed timestamp query plus a JS bucketing pass; no
 * aggregation of the full table, so it stays cheap on large histories.
 * @returns {Promise<number[]>} 15 request counts, oldest first
 */
export async function getRequestRateSeries(ctx) {
  const db = await getAdapter();
  const { buildMinuteBuckets } = await import("@/lib/gatewayStatus.js");
  const now = Date.now();
  const scope = scopeSql(ctx);
  const rows = db.all(
    `SELECT timestamp FROM usageHistory ${whereAll(scope.sql, "timestamp >= ?")}`,
    [...scope.params, new Date(now - 15 * 60_000).toISOString()],
  );
  return buildMinuteBuckets(
    (rows || []).map((row) => row?.timestamp),
    now,
  );
}

async function calculateCost(provider, model, tokens) {
  if (!tokens || !provider || !model) return 0;
  try {
    const { getPricingForModel } = await import("./pricingRepo.js");
    const pricing = await getPricingForModel(provider, model);
    if (!pricing) return 0;

    // Delegate the actual math to the single source of truth (avoids the two
    // copies drifting apart — see open-sse/providers/pricing.js for the
    // cache-inclusive prompt_tokens convention this assumes).
    const { calculateCostFromTokens } = await import("open-sse/providers/pricing.js");
    return calculateCostFromTokens(tokens, pricing);
  } catch (e) {
    console.error("Error calculating cost:", e);
    return 0;
  }
}

/**
 * Saved tokens in one recorded request row. Sums only positive per-method
 * deltas (a method entry is never negative by construction, but legacy rows
 * can't be trusted), so a phantom/partial row can't inflate the lifetime
 * counter or push savings over a milestone.
 * @param {{ byMethod?: Record<string, { tokensSavedEst?: number }> }|null|undefined} savings
 * @returns {number}
 */
export function rowSavedFromSavings(savings) {
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
 * Carrier contract for the gateway writer (open-sse / handlers layer).
 *
 * Legacy storage: `{ apiKey: <raw> }` — today's behavior, byte-identical.
 *
 * Hashed storage: pass `{ apiKeyId, workspaceId, userId }` (from
 * resolveGatewayAuth's principal) or nothing. A late raw from a request that
 * started before migration is HMAC-resolved here into the key id / a
 * `historical:` pseudonym and never persisted raw. Explicit identity is
 * internal trust (resolved principal, never the request body); a raw/explicit
 * mismatch fails closed.
 */
export async function resolveUsageKeyIdentity(
  db,
  { apiKey = null, apiKeyId = null, workspaceId = null, userId = null } = {},
) {
  const state = readApiKeyStorageState(db);
  if (state.storage === "legacy") {
    // Hashed mode is decided by the actual apiKeys schema, never by whether
    // key rows exist. A table carrying keyHash is hashed no matter what the
    // marker says: storing a raw into it would persist a raw key.
    if (tableHasColumn(db, "apiKeys", "keyHash")) {
      const err = new Error("[usage] hashed apiKeys schema without hashed marker");
      err.code = "API_KEY_STATE_INVALID";
      throw err;
    }
    if (apiKeyId != null && apiKeyId !== "" && apiKeyId !== apiKey) {
      throw new Error("[usage] apiKey/apiKeyId mismatch");
    }
    return { storage: "legacy", credential: apiKey ?? null, workspaceId, userId };
  }
  const { hashKey } = await getApiKeyHashKey(db);
  // Schema inspected directly (PRAGMA table_info), never inferred from
  // returned rows: an empty but validly-migrated hashed table must still
  // accept keyless and explicit-id writes; only a missing keyHash column
  // (migration never ran) fails closed.
  if (!tableHasColumn(db, "apiKeys", "keyHash")) {
    const err = new Error("[usage] hashed storage without hashed apiKeys schema");
    err.code = "API_KEY_STATE_INVALID";
    throw err;
  }
  const keyIdByHash = new Map();
  for (const row of db.all(`SELECT id, keyHash FROM apiKeys`)) {
    if (row?.keyHash && row?.id) keyIdByHash.set(row.keyHash, row.id);
  }
  const normalized = normalizeUsageKeyEntry(
    { apiKey, apiKeyId },
    { storage: "hashed", keyIdByHash, hashKey },
  );
  return { storage: "hashed", credential: normalized.apiKeyId, workspaceId, userId };
}

const idOrNull = (v) => (typeof v === "string" && v !== "" ? v : null);

/**
 * Record one request's usage (any endpoint type). `entry.cost` is kept when the
 * caller supplies it (search/fetch report their own), else priced from tokens.
 * `entry.units` (characters, seconds, images, …) lands in `meta.units`.
 * Attribution comes from the resolved principal, never the request body.
 */
export async function saveRequestUsageUnscoped(entry) {
  try {
    const db = await getAdapter();

    if (!entry.timestamp) entry.timestamp = new Date().toISOString();
    entry.cost =
      typeof entry.cost === "number" && Number.isFinite(entry.cost) && entry.cost >= 0
        ? entry.cost
        : await calculateCost(entry.provider, entry.model, entry.tokens);

    const tokens = entry.tokens || {};
    const promptTokens = tokens.prompt_tokens || tokens.input_tokens || 0;
    const completionTokens = tokens.completion_tokens || tokens.output_tokens || 0;
    const cachedTokens = tokens.cached_tokens || tokens.cache_read_input_tokens || 0;

    const identity = await resolveUsageKeyIdentity(db, {
      apiKey: entry.apiKey,
      apiKeyId: entry.apiKeyId,
    });
    const apiKeyId =
      identity.storage === "legacy"
        ? legacyKeyId(db, identity.credential)
        : identity.credential || NO_KEY;
    const workspaceId = idOrNull(entry.workspaceId);
    const userId = idOrNull(entry.userId);
    const metaObj = entry.meta && typeof entry.meta === "object" ? { ...entry.meta } : {};
    delete metaObj.apiKey;
    if (entry.savings) metaObj.savings = entry.savings;
    if (entry.comboName && typeof entry.comboName === "string")
      metaObj.comboName = entry.comboName.slice(0, 128);
    if (entry.userAgent && typeof entry.userAgent === "string")
      metaObj.userAgent = entry.userAgent.slice(0, 256);
    if (entry.units && typeof entry.units === "object") metaObj.units = entry.units;

    // YAN-408: lifetime saved-tokens counter feeds the savings milestone toast.
    const savedTokens = rowSavedFromSavings(metaObj.savings);

    // History insert, rollup upsert and lifetime counters in ONE transaction.
    db.transaction(() => {
      db.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, workspaceId, userId, apiKeyId, grantId) VALUES(?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM workspaces WHERE id = ?), (SELECT id FROM users WHERE id = ?), ?, NULL)`,
        [
          entry.timestamp,
          entry.provider || null,
          entry.model || null,
          entry.connectionId || null,
          entry.endpoint || null,
          promptTokens,
          completionTokens,
          entry.cost || 0,
          entry.status || "ok",
          stringifyJson(tokens),
          stringifyJson(metaObj),
          workspaceId,
          userId,
          apiKeyId,
        ],
      );
      // Rollup dims follow the stored row (FK-checked ids, never dangling).
      const stored = db.get(
        `SELECT workspaceId, userId FROM usageHistory WHERE id = last_insert_rowid()`,
      );
      upsertRollupRowUnscoped(
        db,
        {
          dateKey: localDateKey(entry.timestamp),
          workspaceId: stored?.workspaceId,
          userId: stored?.userId,
          apiKeyId,
          provider: entry.provider,
          model: entry.model,
          connectionId: entry.connectionId,
          endpoint: entry.endpoint,
        },
        {
          tokensIn: promptTokens,
          tokensOut: completionTokens,
          tokensCached: cachedTokens,
          cost: entry.cost || 0,
        },
      );

      const cur = db.get(`SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`);
      const next = (cur ? parseInt(cur.value, 10) : 0) + 1;
      db.run(
        `INSERT INTO _meta(key, value) VALUES('totalRequestsLifetime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [String(next)],
      );

      // YAN-408: increment the lifetime saved-tokens counter in the same
      // transaction as the history row. The one-time backfill lives on the
      // background summary path (getSavingsLifetime), never on the request
      // path: before the counter exists this row is simply skipped and the
      // later backfill scan counts it too, so nothing is lost either way.
      if (savedTokens > 0) {
        const baseline = getMetaSync(db, SAVINGS_LIFETIME_KEY, null);
        if (baseline !== null) {
          setMetaSync(db, SAVINGS_LIFETIME_KEY, Number(baseline) + savedTokens);
        }
      }
    });

    pushToRing({
      timestamp: entry.timestamp,
      provider: entry.provider,
      model: entry.model,
      connectionId: entry.connectionId,
      apiKeyId,
      endpoint: entry.endpoint,
      cost: entry.cost,
      status: entry.status,
      tokens,
      workspaceId,
      userId,
    });
    scheduleStatsEvent("update", 250);
  } catch (e) {
    // Hashed-storage identity failures (marker/schema/master/mismatch) fail
    // closed: the caller sees them and nothing is persisted. Historical
    // non-identity errors keep today's log-only posture.
    if (e?.code === "API_KEY_STATE_INVALID" || /^\[usage|^\[master-key\]/.test(String(e?.message)))
      throw e;
    console.error("Failed to save usage stats:", e);
  }
}

export async function getUsageHistory(ctx, filter = {}) {
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
  if (filter.startDate) {
    conds.push("timestamp >= ?");
    params.push(new Date(filter.startDate).toISOString());
  }
  if (filter.endDate) {
    conds.push("timestamp <= ?");
    params.push(new Date(filter.endDate).toISOString());
  }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = db.all(
    `SELECT timestamp, provider, model, connectionId, apiKeyId, endpoint, cost, status, tokens, meta FROM usageHistory ${where} ORDER BY id ASC`,
    params,
  );
  const names = await apiKeyNames(db);

  return rows.map((r) => ({
    timestamp: r.timestamp,
    provider: r.provider,
    model: r.model,
    connectionId: r.connectionId,
    apiKeyMasked: names[r.apiKeyId]?.masked ?? null,
    endpoint: r.endpoint,
    cost: r.cost,
    status: r.status,
    tokens: parseJson(r.tokens, {}),
    savings: parseJson(r.meta, {})?.savings || null,
    comboName: parseJson(r.meta, {})?.comboName || null,
  }));
}

export async function getLastActivity(ctx) {
  const db = await getAdapter();
  const scope = scopeSql(ctx);
  const row = db.get(
    `SELECT timestamp FROM usageHistory ${whereAll(scope.sql)} ORDER BY timestamp DESC LIMIT 1`,
    scope.params,
  );
  return row?.timestamp ?? null;
}

/**
 * Per-request usage totals for a [start, end) window of usageHistory.
 *
 * A single indexed timestamp range aggregate: requests are the row count,
 * prompt/completion tokens and cost come from the columns, and cached
 * tokens from the tokens JSON (both cache aliases). promptTokens
 * falls back to the JSON prompt/input aliases, matching the
 * saveRequestUsage column conventions (legacy rows wrote 0 there).
 * Both sides of a comparison use the same source (route contract).
 * @param {{ start?: unknown, end?: unknown }} input
 * @param {number} input.start start timestamp (ms, inclusive)
 * @param {number} input.end end timestamp (ms, exclusive)
 * @returns {Promise<{ requests: number, promptTokens: number, completionTokens: number, cachedTokens: number, cost: number }>}
 */
export async function getUsageTotals(ctx, { start, end } = {}) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    throw new Error("getUsageTotals requires finite ms start ≤ end");
  }
  const db = await getAdapter();
  const scope = scopeSql(ctx);
  // Aggregated in SQLite (JSON1 ships with every supported driver) so long
  // windows don't parse each row's tokens JSON in JS.
  const row = db.get(
    `SELECT COUNT(*) AS requests,
       COALESCE(SUM(COALESCE(NULLIF(promptTokens, 0), NULLIF(json_extract(tokens, '$.prompt_tokens'), 0), json_extract(tokens, '$.input_tokens'), 0)), 0) AS promptTokens,
       COALESCE(SUM(completionTokens), 0) AS completionTokens,
       COALESCE(SUM(COALESCE(NULLIF(json_extract(tokens, '$.cached_tokens'), 0), json_extract(tokens, '$.cache_read_input_tokens'), 0)), 0) AS cachedTokens,
       COALESCE(SUM(cost), 0) AS cost
     FROM usageHistory ${whereAll(scope.sql, "timestamp >= ?", "timestamp < ?")}`,
    [...scope.params, new Date(start).toISOString(), new Date(end).toISOString()],
  );
  return {
    requests: Number(row?.requests) || 0,
    promptTokens: Number(row?.promptTokens) || 0,
    completionTokens: Number(row?.completionTokens) || 0,
    cachedTokens: Number(row?.cachedTokens) || 0,
    cost: Number(row?.cost) || 0,
  };
}

function formatLogDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// No-op: request log is now derived from usageHistory table on read.
export async function appendRequestLog() {}

export async function getRecentLogs(ctx, limit = 200) {
  try {
    const db = await getAdapter();
    const scope = scopeSql(ctx);
    const rows = db.all(
      `SELECT timestamp, provider, model, connectionId, promptTokens, completionTokens, status, tokens FROM usageHistory ${whereAll(scope.sql)} ORDER BY id DESC LIMIT ?`,
      [...scope.params, limit],
    );
    if (!rows.length) return [];

    const connMap = {};
    try {
      const { getProviderConnectionsUnscoped } = await import("./connectionsRepo.js");
      const connections = await getProviderConnectionsUnscoped();
      for (const c of connections) connMap[c.id] = c.name || c.email || "";
    } catch {}

    return rows.map((r) => {
      const ts = formatLogDate(new Date(r.timestamp));
      const p = r.provider?.toUpperCase() || "-";
      const m = r.model || "-";
      const account =
        connMap[r.connectionId] || (r.connectionId ? r.connectionId.slice(0, 8) : "-");
      const tk = r.tokens ? parseJson(r.tokens, {}) : {};
      const sent = r.promptTokens ?? tk.prompt_tokens ?? "-";
      const received = r.completionTokens ?? tk.completion_tokens ?? "-";
      return `${ts} | ${m} | ${p} | ${account} | ${sent} | ${received} | ${r.status || "-"}`;
    });
  } catch (e) {
    console.error("[usageRepo] getRecentLogs failed:", e.message);
    return [];
  }
}

/**
 * Period savings from recorded per-request meta (usageHistory.meta.savings).
 * Estimated only — RTK bytes/4, real Headroom tokens, PXPIPE estimates.
 * PXPIPE uses the same meta source (recorded once per successful request),
 * never the JSONL events file, so there is no double counting.
 */
export async function getUsageSavings(ctx, period = "7d", now = Date.now()) {
  if (!isPeriod(period)) throw new Error(`Invalid period: ${period}`);
  const db = await getAdapter();
  const scope = scopeSql(ctx);

  const rows = db.all(
    `SELECT timestamp, provider, model, meta FROM usageHistory ${whereAll(scope.sql, "timestamp >= ?", "timestamp <= ?")}`,
    [
      ...scope.params,
      new Date(periodStart(period, now)).toISOString(),
      new Date(now).toISOString(),
    ],
  );

  const byMethod = {};
  let tokensSavedEst = 0;
  let tokensBeforeEst = 0;
  let requestsWithSavings = 0;
  let costSavedEst = 0;
  let pricedRequests = 0;
  const pricingCache = new Map();

  for (const row of rows) {
    const meta = parseJson(row.meta, {});
    const savings = meta?.savings;
    if (!savings || typeof savings !== "object") continue;
    // Guard against partially-shaped legacy rows
    const methods =
      savings.byMethod && typeof savings.byMethod === "object" ? savings.byMethod : {};
    if (Object.keys(methods).length === 0) continue;

    let rowSaved = 0;
    for (const [method, m] of Object.entries(methods)) {
      if (typeof m !== "object" || !m) continue;
      const saved = Number(m.tokensSavedEst) || 0;
      const before = Number(m.tokensBeforeEst) || 0;
      if (saved <= 0) continue;
      if (!byMethod[method])
        byMethod[method] = { tokensSavedEst: 0, tokensBeforeEst: 0, requests: 0 };
      byMethod[method].tokensSavedEst += saved;
      byMethod[method].tokensBeforeEst += before;
      byMethod[method].requests += 1;
      rowSaved += saved;
    }
    if (rowSaved <= 0) continue;
    tokensSavedEst += rowSaved;
    tokensBeforeEst += Number(savings.tokensBeforeEst) || 0;
    requestsWithSavings += 1;

    const rowCost = await savedTokensCost(row.provider, row.model, rowSaved, pricingCache);
    if (rowCost > 0) {
      costSavedEst += rowCost;
      pricedRequests += 1;
    }
  }

  const methods = Object.keys(byMethod);
  const percentage =
    tokensBeforeEst > 0 ? +((tokensSavedEst / tokensBeforeEst) * 100).toFixed(2) : 0;

  return {
    period,
    estimated: true,
    tokensSavedEst,
    tokensBeforeEst,
    percentage,
    requestsWithSavings,
    // $ at list prices: each request's saved tokens priced with its own model.
    // null when no request in the period had resolvable pricing.
    costSavedEst: pricedRequests > 0 ? +costSavedEst.toFixed(6) : null,
    pricedRequests,
    methods,
    byMethod,
  };
}

/**
 * List-price value of a request's saved tokens. Every counted saver (RTK,
 * Headroom, PXPIPE) shrinks the prompt, so saved tokens are priced as
 * uncached input for the request's own provider/model — the same pricing
 * tables and math as usage cost. Unknown pricing returns 0 (never a guess).
 * @param {string|null} provider
 * @param {string|null} model
 * @param {number} savedTokens
 * @param {Map<string, Promise<object|null>>} [cache] per-call pricing lookups by provider/model
 * @returns {Promise<number>} dollars
 */
async function savedTokensCost(provider, model, savedTokens, cache = new Map()) {
  if (!model || !(savedTokens > 0)) return 0;
  try {
    const key = `${provider}\u0000${model}`;
    if (!cache.has(key)) {
      const { getPricingForModel } = await import("./pricingRepo.js");
      cache.set(key, getPricingForModel(provider, model));
    }
    const pricing = await cache.get(key);
    if (!pricing || !(Number(pricing.input) > 0)) return 0;
    const { calculateCostFromTokens } = await import("open-sse/providers/pricing.js");
    return calculateCostFromTokens({ prompt_tokens: savedTokens }, pricing);
  } catch (e) {
    console.error("[usageRepo] savings pricing failed:", e.message);
    return 0;
  }
}

/**
 * Previous-period request counts + period buckets + top combo usage for the
 * Home command center. Combos come from meta.comboName recorded at save time.
 */
// ponytail: fallback hops live in an in-memory ring (lost on restart, capped at
// 200). Enough for the 5-minute live-routes window; persist to usageHistory
// meta if a longer fallback history is ever needed.
if (!global._fallbackHops) global._fallbackHops = [];
const FALLBACK_RING_CAP = 200;

/**
 * Record one combo fallback hop (a step failed, the combo moved on).
 * @param {{ comboName: string, provider: string, model: string, status: number|null }} hop
 */
export function recordFallbackHop(hop) {
  if (!hop?.comboName || !hop?.provider) return;
  global._fallbackHops.push({
    timestamp: new Date().toISOString(),
    comboName: String(hop.comboName).slice(0, 128),
    provider: String(hop.provider).slice(0, 128),
    model: hop.model ? String(hop.model).slice(0, 256) : null,
    status: Number(hop.status) || null,
    workspaceId: typeof hop.workspaceId === "string" ? hop.workspaceId : null,
  });
  if (global._fallbackHops.length > FALLBACK_RING_CAP) {
    global._fallbackHops.splice(0, global._fallbackHops.length - FALLBACK_RING_CAP);
  }
}

/**
 * Windowed live-routes feed for the Home map: successful requests from
 * usageHistory, failed attempts from requestDetails, and recorded combo
 * fallback hops, all inside the rolling window. Key names are resolved server-side (raw keys never leave);
 * rows are capped so the response stays small.
 * @param {object} [options]
 * @param {number} [options.windowMs] rolling window, default 5 minutes
 * @param {number} [options.limit] max rows per source, default 500
 * @returns {Promise<{ usageRows: Array<object>, errorRows: Array<object>, fallbackHops: Array<object> }>}
 */
export async function getLiveRoutesFeed(ctx, { windowMs = 5 * 60 * 1000, limit = 500 } = {}) {
  const db = await getAdapter();
  const scope = scopeSql(ctx);
  const since = new Date(Date.now() - windowMs).toISOString();

  const { getApiKeys } = await import("./apiKeysRepo.js");
  const keyNames = {};
  try {
    const keys = await getApiKeys();
    for (const key of keys || []) {
      // Hashed metadata rows have no raw; legacy rows do. Index both by id
      // and by raw so live-row and retained (pseudonym) history both name up.
      if (key?.id) keyNames[key.id] = key.name || "Unnamed key";
      if (key?.key) keyNames[key.key] = key.name || "Unnamed key";
    }
  } catch {}

  const capped = Math.max(1, Math.min(Number(limit) || 500, 2000));
  const usage = db.all(
    `SELECT timestamp, provider, model, apiKeyId, meta FROM usageHistory ${whereAll(scope.sql, "timestamp > ?")} ORDER BY id DESC LIMIT ?`,
    [...scope.params, since, capped],
  );
  // Failed attempts only reach requestDetails (usageHistory records successes);
  // the upstream status code sits in the detail JSON (response.status).
  const errors = db.all(
    `SELECT timestamp, provider, model, data FROM requestDetails ${whereAll(scope.sql, "timestamp > ?", "status = 'error'")} ORDER BY timestamp DESC LIMIT ?`,
    [...scope.params, since, capped],
  );

  const parseMeta = (raw) => parseJson(raw, {}) || {};
  return {
    usageRows: usage
      .map((row) => {
        const meta = parseMeta(row.meta);
        return {
          timestamp: row.timestamp,
          provider: row.provider,
          model: row.model,
          keyName: keyNames[row.apiKeyId] || null,
          userAgent: typeof meta.userAgent === "string" && meta.userAgent ? meta.userAgent : null,
          comboName: typeof meta.comboName === "string" && meta.comboName ? meta.comboName : null,
        };
      })
      .filter((row) => row.provider),
    errorRows: errors
      .map((row) => ({
        timestamp: row.timestamp,
        provider: row.provider,
        model: row.model,
        status: parseJson(row.data, {})?.response?.status ?? null,
      }))
      .filter((row) => row.provider),
    fallbackHops: global._fallbackHops.filter(
      (hop) => hop.timestamp > since && (!ctx || hop.workspaceId === ctx.workspaceId),
    ),
  };
}

export async function getHomeSummary(ctx, period = "7d", now = Date.now()) {
  if (!isPeriod(period)) throw new Error(`Invalid period: ${period}`);
  const db = await getAdapter();
  const scope = scopeSql(ctx);

  const current = { start: periodStart(period, now), end: now };
  const prev = previousPeriodRange(period, now);

  const countIn = (start, end, endOp) => {
    const row = db.get(
      `SELECT COUNT(*) AS n FROM usageHistory ${whereAll(scope.sql, "timestamp >= ?", `timestamp ${endOp} ?`)}`,
      [...scope.params, new Date(start).toISOString(), new Date(end).toISOString()],
    );
    return row?.n || 0;
  };

  const requests = countIn(current.start, current.end, "<=");
  // Half-open like /api/usage/stats?compare=previous, so a row at the current start counts once.
  const previousRequests = countIn(prev.start, prev.end, "<");

  const rows = db.all(
    `SELECT timestamp, meta FROM usageHistory ${whereAll(scope.sql, "timestamp >= ?", "timestamp <= ?")}`,
    [...scope.params, new Date(current.start).toISOString(), new Date(current.end).toISOString()],
  );
  const comboCounts = {};
  for (const row of rows) {
    const meta = parseJson(row.meta, {});
    const name = typeof meta?.comboName === "string" && meta.comboName ? meta.comboName : null;
    if (name) comboCounts[name] = (comboCounts[name] || 0) + 1;
  }
  const topCombos = Object.entries(comboCounts)
    .map(([name, count]) => ({ name, requests: count }))
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 5);

  return {
    period,
    requests,
    previousRequests,
    topCombos,
  };
}
