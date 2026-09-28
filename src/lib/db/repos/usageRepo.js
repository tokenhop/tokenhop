import { createHash } from "node:crypto";
import { EventEmitter } from "events";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { getMeta, setMeta } from "../helpers/metaStore.js";

function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  if (key.length <= 8) return key.charAt(0) + "***";
  return key.slice(0, 8) + "***";
}

/**
 * Non-secret identity for a client API key in usage stats. Row ids use the
 * keys-table id (or a short hash for deleted keys), never the key or its masked
 * prefix: every key on a machine shares the same `sk-{machineId}` prefix.
 */
function apiKeyIdentity(rawKey, apiKeyMap) {
  if (!rawKey || typeof rawKey !== "string") {
    return { id: "local-no-key", keyName: "Local (No API Key)", apiKeyMasked: null };
  }
  const apiKeyMasked = maskApiKey(rawKey);
  const info = apiKeyMap[rawKey];
  if (info?.id) return { id: info.id, keyName: info.name || apiKeyMasked, apiKeyMasked };
  const hash = createHash("sha256").update(rawKey).digest("hex").slice(0, 12);
  return { id: `key-${hash}`, keyName: `${apiKeyMasked} (${hash.slice(0, 6)})`, apiKeyMasked };
}

const PENDING_TIMEOUT_MS = 60 * 1000;
const RING_CAP = 50;
const CONN_CACHE_TTL_MS = 30 * 1000;
const PERIOD_MS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "60d": 5184000000 };

// In-memory state shared across Next.js modules
if (!global._pendingRequests) global._pendingRequests = { byModel: {}, byAccount: {} };
if (!global._lastErrorProvider) global._lastErrorProvider = { provider: "", ts: 0 };
if (!global._statsEmitter) {
  global._statsEmitter = new EventEmitter();
  global._statsEmitter.setMaxListeners(50);
}
if (!global._pendingTimers) global._pendingTimers = {};
if (!global._recentRing) global._recentRing = { items: [], initialized: false };
if (!global._connectionMapCache) global._connectionMapCache = { map: {}, ts: 0 };
if (!global._statsEmitTimers) global._statsEmitTimers = { pending: null, update: null };

const pendingRequests = global._pendingRequests;
const lastErrorProvider = global._lastErrorProvider;
const pendingTimers = global._pendingTimers;
const recentRing = global._recentRing;
const connCache = global._connectionMapCache;
const statsEmitTimers = global._statsEmitTimers;

export const statsEmitter = global._statsEmitter;

function scheduleStatsEvent(event, delayMs = 150) {
  const key = event === "update" ? "update" : "pending";
  if (statsEmitTimers[key]) return;
  statsEmitTimers[key] = setTimeout(() => {
    statsEmitTimers[key] = null;
    statsEmitter.emit(event);
  }, delayMs);
  statsEmitTimers[key]?.unref?.();
}

function getLocalDateKey(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addToCounter(target, key, values) {
  if (!target[key])
    target[key] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
  target[key].requests += values.requests || 1;
  target[key].promptTokens += values.promptTokens || 0;
  target[key].completionTokens += values.completionTokens || 0;
  target[key].cachedTokens += values.cachedTokens || 0;
  target[key].cost += values.cost || 0;
  if (values.meta) Object.assign(target[key], values.meta);
}

function aggregateEntryToDay(day, entry) {
  const promptTokens = entry.tokens?.prompt_tokens || entry.tokens?.input_tokens || 0;
  const completionTokens = entry.tokens?.completion_tokens || entry.tokens?.output_tokens || 0;
  const cachedTokens = entry.tokens?.cached_tokens || entry.tokens?.cache_read_input_tokens || 0;
  const cost = entry.cost || 0;
  const vals = { promptTokens, completionTokens, cachedTokens, cost };

  day.requests = (day.requests || 0) + 1;
  day.promptTokens = (day.promptTokens || 0) + promptTokens;
  day.completionTokens = (day.completionTokens || 0) + completionTokens;
  day.cachedTokens = (day.cachedTokens || 0) + cachedTokens;
  day.cost = (day.cost || 0) + cost;

  day.byProvider ||= {};
  day.byModel ||= {};
  day.byAccount ||= {};
  day.byApiKey ||= {};
  day.byEndpoint ||= {};

  if (entry.provider) addToCounter(day.byProvider, entry.provider, vals);

  const modelKey = entry.provider ? `${entry.model}|${entry.provider}` : entry.model;
  addToCounter(day.byModel, modelKey, {
    ...vals,
    meta: { rawModel: entry.model, provider: entry.provider },
  });

  if (entry.connectionId) {
    addToCounter(day.byAccount, entry.connectionId, {
      ...vals,
      meta: { rawModel: entry.model, provider: entry.provider },
    });
  }

  const apiKeyVal =
    entry.apiKey && typeof entry.apiKey === "string" ? entry.apiKey : "local-no-key";
  const akModelKey = `${apiKeyVal}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byApiKey, akModelKey, {
    ...vals,
    meta: { rawModel: entry.model, provider: entry.provider, apiKey: entry.apiKey || null },
  });

  const endpoint = entry.endpoint || "Unknown";
  const epKey = `${endpoint}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byEndpoint, epKey, {
    ...vals,
    meta: { endpoint, rawModel: entry.model, provider: entry.provider },
  });
}

function pushToRing(entry) {
  recentRing.items.push(entry);
  if (recentRing.items.length > RING_CAP) {
    recentRing.items = recentRing.items.slice(-RING_CAP);
  }
}

async function getConnectionMapCached() {
  if (Date.now() - connCache.ts < CONN_CACHE_TTL_MS) return connCache.map;
  try {
    const { getProviderConnections } = await import("./connectionsRepo.js");
    const all = await getProviderConnections();
    const map = {};
    for (const c of all) map[c.id] = c.name || c.email || c.id;
    connCache.map = map;
    connCache.ts = Date.now();
  } catch {}
  return connCache.map;
}

async function ensureRingInitialized() {
  if (recentRing.initialized) return;
  recentRing.initialized = true;
  try {
    const db = await getAdapter();
    const rows = db.all(
      `SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost, status, tokens FROM usageHistory ORDER BY id DESC LIMIT ?`,
      [RING_CAP],
    );
    recentRing.items = rows.reverse().map((r) => ({
      timestamp: r.timestamp,
      provider: r.provider,
      model: r.model,
      connectionId: r.connectionId,
      apiKey: r.apiKey,
      endpoint: r.endpoint,
      cost: r.cost,
      status: r.status,
      tokens: parseJson(r.tokens, {}),
    }));
  } catch {}
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

export function trackPendingRequest(model, provider, connectionId, started, error = false) {
  const modelKey = provider ? `${model} (${provider})` : model;
  const timerKey = `${connectionId}|${modelKey}`;

  if (!pendingRequests.byModel[modelKey]) pendingRequests.byModel[modelKey] = 0;
  pendingRequests.byModel[modelKey] = Math.max(
    0,
    pendingRequests.byModel[modelKey] + (started ? 1 : -1),
  );
  if (pendingRequests.byModel[modelKey] === 0) delete pendingRequests.byModel[modelKey];

  if (connectionId) {
    if (!pendingRequests.byAccount[connectionId]) pendingRequests.byAccount[connectionId] = {};
    if (!pendingRequests.byAccount[connectionId][modelKey])
      pendingRequests.byAccount[connectionId][modelKey] = 0;
    pendingRequests.byAccount[connectionId][modelKey] = Math.max(
      0,
      pendingRequests.byAccount[connectionId][modelKey] + (started ? 1 : -1),
    );
    if (pendingRequests.byAccount[connectionId][modelKey] === 0) {
      delete pendingRequests.byAccount[connectionId][modelKey];
      if (Object.keys(pendingRequests.byAccount[connectionId]).length === 0) {
        delete pendingRequests.byAccount[connectionId];
      }
    }
  }

  if (started) {
    clearTimeout(pendingTimers[timerKey]);
    pendingTimers[timerKey] = setTimeout(() => {
      delete pendingTimers[timerKey];
      if (pendingRequests.byModel[modelKey] > 0) pendingRequests.byModel[modelKey] = 0;
      if (connectionId && pendingRequests.byAccount[connectionId]?.[modelKey] > 0) {
        pendingRequests.byAccount[connectionId][modelKey] = 0;
      }
      scheduleStatsEvent("pending");
    }, PENDING_TIMEOUT_MS);
  } else {
    clearTimeout(pendingTimers[timerKey]);
    delete pendingTimers[timerKey];
  }

  if (!started && error && provider) {
    lastErrorProvider.provider = provider.toLowerCase();
    lastErrorProvider.ts = Date.now();
  }

  // [PENDING] console line removed; lifecycle is visible via "▶" and "📊 done" lines
  scheduleStatsEvent("pending");
}

export async function getActiveRequests() {
  const activeRequests = [];
  const connectionMap = await getConnectionMapCached();

  for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (count > 0) {
        const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
        const match = modelKey.match(/^(.*) \((.*)\)$/);
        activeRequests.push({
          model: match ? match[1] : modelKey,
          provider: match ? match[2] : "unknown",
          account: accountName,
          count,
        });
      }
    }
  }

  await ensureRingInitialized();
  const seen = new Set();
  const recentRequests = [...recentRing.items]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .map((e) => {
      const t = e.tokens || {};
      return {
        timestamp: e.timestamp,
        model: e.model,
        provider: e.provider || "",
        promptTokens: t.prompt_tokens || t.input_tokens || 0,
        completionTokens: t.completion_tokens || t.output_tokens || 0,
        status: e.status || "ok",
      };
    })
    .filter((e) => {
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);

  const errorProvider = Date.now() - lastErrorProvider.ts < 10000 ? lastErrorProvider.provider : "";
  return { activeRequests, recentRequests, errorProvider };
}

export async function saveRequestUsage(entry) {
  try {
    const db = await getAdapter();

    if (!entry.timestamp) entry.timestamp = new Date().toISOString();
    entry.cost = await calculateCost(entry.provider, entry.model, entry.tokens);

    const tokens = entry.tokens || {};
    const promptTokens = tokens.prompt_tokens || tokens.input_tokens || 0;
    const completionTokens = tokens.completion_tokens || tokens.output_tokens || 0;

    // All 3 writes (history insert, daily upsert, lifetime counter) in ONE transaction.
    // better-sqlite3 is sync → no JS yield mid-transaction → no race in same process.
    const metaObj = entry.meta && typeof entry.meta === "object" ? { ...entry.meta } : {};
    if (entry.savings) metaObj.savings = entry.savings;
    if (entry.comboName && typeof entry.comboName === "string")
      metaObj.comboName = entry.comboName.slice(0, 128);
    if (entry.userAgent && typeof entry.userAgent === "string")
      metaObj.userAgent = entry.userAgent.slice(0, 256);

    db.transaction(() => {
      db.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.timestamp,
          entry.provider || null,
          entry.model || null,
          entry.connectionId || null,
          entry.apiKey || null,
          entry.endpoint || null,
          promptTokens,
          completionTokens,
          entry.cost || 0,
          entry.status || "ok",
          stringifyJson(tokens),
          stringifyJson(metaObj),
        ],
      );

      const dateKey = getLocalDateKey(entry.timestamp);
      const row = db.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [dateKey]);
      const day = row
        ? parseJson(row.data, {})
        : {
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            cost: 0,
            byProvider: {},
            byModel: {},
            byAccount: {},
            byApiKey: {},
            byEndpoint: {},
          };
      aggregateEntryToDay(day, entry);
      db.run(
        `INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`,
        [dateKey, stringifyJson(day)],
      );

      // Atomic counter increment in same transaction
      const cur = db.get(`SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`);
      const next = (cur ? parseInt(cur.value, 10) : 0) + 1;
      db.run(
        `INSERT INTO _meta(key, value) VALUES('totalRequestsLifetime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [String(next)],
      );
    });

    pushToRing(entry);
    scheduleStatsEvent("update", 250);
  } catch (e) {
    console.error("Failed to save usage stats:", e);
  }
}

export async function getUsageHistory(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

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
    `SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost, status, tokens, meta FROM usageHistory ${where} ORDER BY id ASC`,
    params,
  );

  return rows.map((r) => ({
    timestamp: r.timestamp,
    provider: r.provider,
    model: r.model,
    connectionId: r.connectionId,
    apiKeyMasked: maskApiKey(r.apiKey),
    endpoint: r.endpoint,
    cost: r.cost,
    status: r.status,
    tokens: parseJson(r.tokens, {}),
    savings: parseJson(r.meta, {})?.savings || null,
    comboName: parseJson(r.meta, {})?.comboName || null,
  }));
}

function loadDaysInRange(adapter, maxDays) {
  if (maxDays == null) {
    return adapter.all(`SELECT dateKey, data FROM usageDaily`);
  }
  const today = new Date();
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - maxDays + 1);
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
  return adapter.all(`SELECT dateKey, data FROM usageDaily WHERE dateKey >= ?`, [cutoffKey]);
}

export async function getUsageStats(period = "all") {
  const db = await getAdapter();

  const [{ getProviderConnections }, { getApiKeys }, { getProviderNodes }] = await Promise.all([
    import("./connectionsRepo.js"),
    import("./apiKeysRepo.js"),
    import("./nodesRepo.js"),
  ]);

  let allConnections = [];
  try {
    allConnections = await getProviderConnections();
  } catch {}
  const connectionMap = {};
  for (const c of allConnections) connectionMap[c.id] = c.name || c.email || c.id;

  const providerNodeNameMap = {};
  try {
    const nodes = await getProviderNodes();
    for (const n of nodes) if (n.id && n.name) providerNodeNameMap[n.id] = n.name;
  } catch {}

  let allApiKeys = [];
  try {
    allApiKeys = await getApiKeys();
  } catch {}
  const apiKeyMap = {};
  for (const k of allApiKeys) apiKeyMap[k.key] = { name: k.name, id: k.id, createdAt: k.createdAt };

  // recentRequests from live history (last 100 entries enough for 20 deduped)
  const recentRows = db.all(
    `SELECT timestamp, provider, model, tokens, status FROM usageHistory ORDER BY id DESC LIMIT 100`,
  );
  const seen = new Set();
  const recentRequests = recentRows
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
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${minute}`;
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
    pending: pendingRequests,
    activeRequests: [],
    recentRequests,
    errorProvider: Date.now() - lastErrorProvider.ts < 10000 ? lastErrorProvider.provider : "",
  };

  // Active requests
  for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (count > 0) {
        const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
        const match = modelKey.match(/^(.*) \((.*)\)$/);
        stats.activeRequests.push({
          model: match ? match[1] : modelKey,
          provider: match ? match[2] : "unknown",
          account: accountName,
          count,
        });
      }
    }
  }

  // last10Minutes — query 10min window
  const now = new Date();
  const currentMinuteStart = new Date(Math.floor(now.getTime() / 60000) * 60000);
  const tenMinutesAgo = new Date(currentMinuteStart.getTime() - 9 * 60 * 1000);
  const bucketMap = {};
  for (let i = 0; i < 10; i++) {
    const ts = currentMinuteStart.getTime() - (9 - i) * 60 * 1000;
    bucketMap[ts] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    stats.last10Minutes.push(bucketMap[ts]);
  }
  const recent10 = db.all(
    `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND timestamp <= ?`,
    [tenMinutesAgo.toISOString(), now.toISOString()],
  );
  for (const r of recent10) {
    const tt = new Date(r.timestamp).getTime();
    const minuteStart = Math.floor(tt / 60000) * 60000;
    if (bucketMap[minuteStart]) {
      bucketMap[minuteStart].requests++;
      bucketMap[minuteStart].promptTokens += r.promptTokens || 0;
      bucketMap[minuteStart].completionTokens += r.completionTokens || 0;
      bucketMap[minuteStart].cost += r.cost || 0;
    }
  }

  const useDailySummary = period !== "24h" && period !== "today";

  if (useDailySummary) {
    const periodDays = { "7d": 7, "30d": 30, "60d": 60 };
    const maxDays = periodDays[period] || null;
    const dayRows = loadDaysInRange(db, maxDays);

    for (const dr of dayRows) {
      const dateKey = dr.dateKey;
      const day = parseJson(dr.data, {});
      stats.totalPromptTokens += day.promptTokens || 0;
      stats.totalCompletionTokens += day.completionTokens || 0;
      stats.totalCachedTokens += day.cachedTokens || 0;
      stats.totalCost += day.cost || 0;

      for (const [prov, p] of Object.entries(day.byProvider || {})) {
        if (!stats.byProvider[prov])
          stats.byProvider[prov] = {
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            cachedTokens: 0,
            cost: 0,
          };
        stats.byProvider[prov].requests += p.requests || 0;
        stats.byProvider[prov].promptTokens += p.promptTokens || 0;
        stats.byProvider[prov].completionTokens += p.completionTokens || 0;
        stats.byProvider[prov].cachedTokens += p.cachedTokens || 0;
        stats.byProvider[prov].cost += p.cost || 0;
      }

      for (const [mk, m] of Object.entries(day.byModel || {})) {
        const rawModel = m.rawModel || mk.split("|")[0];
        const provider = m.provider || mk.split("|")[1] || "";
        const statsKey = provider ? `${rawModel} (${provider})` : rawModel;
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        if (!stats.byModel[statsKey]) {
          stats.byModel[statsKey] = {
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            cachedTokens: 0,
            cost: 0,
            rawModel,
            provider: providerDisplayName,
            lastUsed: dateKey,
          };
        }
        stats.byModel[statsKey].requests += m.requests || 0;
        stats.byModel[statsKey].promptTokens += m.promptTokens || 0;
        stats.byModel[statsKey].completionTokens += m.completionTokens || 0;
        stats.byModel[statsKey].cachedTokens += m.cachedTokens || 0;
        stats.byModel[statsKey].cost += m.cost || 0;
        if (dateKey > (stats.byModel[statsKey].lastUsed || ""))
          stats.byModel[statsKey].lastUsed = dateKey;
      }

      for (const [connId, a] of Object.entries(day.byAccount || {})) {
        const accountName = connectionMap[connId] || `Account ${connId.slice(0, 8)}...`;
        const rawModel = a.rawModel || "";
        const provider = a.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        const accountKey = `${rawModel} (${provider} - ${accountName})`;
        if (!stats.byAccount[accountKey]) {
          stats.byAccount[accountKey] = {
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            cachedTokens: 0,
            cost: 0,
            rawModel,
            provider: providerDisplayName,
            connectionId: connId,
            accountName,
            lastUsed: dateKey,
          };
        }
        stats.byAccount[accountKey].requests += a.requests || 0;
        stats.byAccount[accountKey].promptTokens += a.promptTokens || 0;
        stats.byAccount[accountKey].completionTokens += a.completionTokens || 0;
        stats.byAccount[accountKey].cachedTokens += a.cachedTokens || 0;
        stats.byAccount[accountKey].cost += a.cost || 0;
        if (dateKey > (stats.byAccount[accountKey].lastUsed || ""))
          stats.byAccount[accountKey].lastUsed = dateKey;
      }

      for (const ak of Object.values(day.byApiKey || {})) {
        const rawModel = ak.rawModel || "";
        const provider = ak.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        // Persisted day rows are keyed by the raw key: re-key by identity so it never leaves.
        const { id: apiKeyKey, keyName, apiKeyMasked } = apiKeyIdentity(ak.apiKey, apiKeyMap);
        const akKey = `${apiKeyKey}|${rawModel}|${provider || "unknown"}`;
        if (!stats.byApiKey[akKey]) {
          stats.byApiKey[akKey] = {
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            cachedTokens: 0,
            cost: 0,
            rawModel,
            provider: providerDisplayName,
            apiKeyMasked,
            keyName,
            apiKeyKey,
            lastUsed: dateKey,
          };
        }
        stats.byApiKey[akKey].requests += ak.requests || 0;
        stats.byApiKey[akKey].promptTokens += ak.promptTokens || 0;
        stats.byApiKey[akKey].completionTokens += ak.completionTokens || 0;
        stats.byApiKey[akKey].cachedTokens += ak.cachedTokens || 0;
        stats.byApiKey[akKey].cost += ak.cost || 0;
        if (dateKey > (stats.byApiKey[akKey].lastUsed || ""))
          stats.byApiKey[akKey].lastUsed = dateKey;
      }

      for (const [epKey, ep] of Object.entries(day.byEndpoint || {})) {
        const endpoint = ep.endpoint || epKey.split("|")[0] || "Unknown";
        const rawModel = ep.rawModel || "";
        const provider = ep.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        if (!stats.byEndpoint[epKey]) {
          stats.byEndpoint[epKey] = {
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            cachedTokens: 0,
            cost: 0,
            endpoint,
            rawModel,
            provider: providerDisplayName,
            lastUsed: dateKey,
          };
        }
        stats.byEndpoint[epKey].requests += ep.requests || 0;
        stats.byEndpoint[epKey].promptTokens += ep.promptTokens || 0;
        stats.byEndpoint[epKey].completionTokens += ep.completionTokens || 0;
        stats.byEndpoint[epKey].cachedTokens += ep.cachedTokens || 0;
        stats.byEndpoint[epKey].cost += ep.cost || 0;
        if (dateKey > (stats.byEndpoint[epKey].lastUsed || ""))
          stats.byEndpoint[epKey].lastUsed = dateKey;
      }
    }

    // Overlay precise lastUsed timestamps from history
    const overlayCutoff = maxDays ? Date.now() - maxDays * 86400000 : 0;
    const histRows = db.all(
      `SELECT timestamp, provider, model, connectionId, apiKey, endpoint FROM usageHistory WHERE timestamp >= ?`,
      [new Date(overlayCutoff).toISOString()],
    );
    for (const e of histRows) {
      const ts = e.timestamp;
      const modelKey = e.provider ? `${e.model} (${e.provider})` : e.model;
      if (stats.byModel[modelKey] && new Date(ts) > new Date(stats.byModel[modelKey].lastUsed))
        stats.byModel[modelKey].lastUsed = ts;

      if (e.connectionId) {
        const accountName =
          connectionMap[e.connectionId] || `Account ${e.connectionId.slice(0, 8)}...`;
        const accountKey = `${e.model} (${e.provider} - ${accountName})`;
        if (
          stats.byAccount[accountKey] &&
          new Date(ts) > new Date(stats.byAccount[accountKey].lastUsed)
        )
          stats.byAccount[accountKey].lastUsed = ts;
      }

      const apiKeyKey = `${apiKeyIdentity(e.apiKey, apiKeyMap).id}|${e.model}|${e.provider || "unknown"}`;
      if (stats.byApiKey[apiKeyKey] && new Date(ts) > new Date(stats.byApiKey[apiKeyKey].lastUsed))
        stats.byApiKey[apiKeyKey].lastUsed = ts;

      const endpoint = e.endpoint || "Unknown";
      const endpointKey = `${endpoint}|${e.model}|${e.provider || "unknown"}`;
      if (
        stats.byEndpoint[endpointKey] &&
        new Date(ts) > new Date(stats.byEndpoint[endpointKey].lastUsed)
      )
        stats.byEndpoint[endpointKey].lastUsed = ts;
    }
  } else {
    // 24h / today: live history
    let cutoff;
    if (period === "today") {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      cutoff = startOfDay.toISOString();
    } else {
      cutoff = new Date(Date.now() - PERIOD_MS["24h"]).toISOString();
    }
    const filtered = db.all(
      `SELECT timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, tokens FROM usageHistory WHERE timestamp >= ?`,
      [cutoff],
    );

    for (const r of filtered) {
      const tokens = parseJson(r.tokens, {}) || {};
      const promptTokens = tokens.prompt_tokens || 0;
      const completionTokens = tokens.completion_tokens || 0;
      const cachedTokens = tokens.cached_tokens || tokens.cache_read_input_tokens || 0;
      const entryCost = r.cost || 0;
      const providerDisplayName = providerNodeNameMap[r.provider] || r.provider;

      stats.totalPromptTokens += promptTokens;
      stats.totalCompletionTokens += completionTokens;
      stats.totalCachedTokens += cachedTokens;
      stats.totalCost += entryCost;

      if (!stats.byProvider[r.provider])
        stats.byProvider[r.provider] = {
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          cost: 0,
        };
      stats.byProvider[r.provider].requests++;
      stats.byProvider[r.provider].promptTokens += promptTokens;
      stats.byProvider[r.provider].completionTokens += completionTokens;
      stats.byProvider[r.provider].cachedTokens += cachedTokens;
      stats.byProvider[r.provider].cost += entryCost;

      const modelKey = r.provider ? `${r.model} (${r.provider})` : r.model;
      if (!stats.byModel[modelKey]) {
        stats.byModel[modelKey] = {
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          cost: 0,
          rawModel: r.model,
          provider: providerDisplayName,
          lastUsed: r.timestamp,
        };
      }
      stats.byModel[modelKey].requests++;
      stats.byModel[modelKey].promptTokens += promptTokens;
      stats.byModel[modelKey].completionTokens += completionTokens;
      stats.byModel[modelKey].cachedTokens += cachedTokens;
      stats.byModel[modelKey].cost += entryCost;
      if (new Date(r.timestamp) > new Date(stats.byModel[modelKey].lastUsed))
        stats.byModel[modelKey].lastUsed = r.timestamp;

      if (r.connectionId) {
        const accountName =
          connectionMap[r.connectionId] || `Account ${r.connectionId.slice(0, 8)}...`;
        const accountKey = `${r.model} (${r.provider} - ${accountName})`;
        if (!stats.byAccount[accountKey]) {
          stats.byAccount[accountKey] = {
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            cachedTokens: 0,
            cost: 0,
            rawModel: r.model,
            provider: providerDisplayName,
            connectionId: r.connectionId,
            accountName,
            lastUsed: r.timestamp,
          };
        }
        stats.byAccount[accountKey].requests++;
        stats.byAccount[accountKey].promptTokens += promptTokens;
        stats.byAccount[accountKey].completionTokens += completionTokens;
        stats.byAccount[accountKey].cachedTokens += cachedTokens;
        stats.byAccount[accountKey].cost += entryCost;
        if (new Date(r.timestamp) > new Date(stats.byAccount[accountKey].lastUsed))
          stats.byAccount[accountKey].lastUsed = r.timestamp;
      }

      const { id: apiKeyKey, keyName, apiKeyMasked } = apiKeyIdentity(r.apiKey, apiKeyMap);
      const akKey = `${apiKeyKey}|${r.model}|${r.provider || "unknown"}`;
      if (!stats.byApiKey[akKey]) {
        stats.byApiKey[akKey] = {
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          cost: 0,
          rawModel: r.model,
          provider: providerDisplayName,
          apiKeyMasked,
          keyName,
          apiKeyKey,
          lastUsed: r.timestamp,
        };
      }
      const ake = stats.byApiKey[akKey];
      ake.requests++;
      ake.promptTokens += promptTokens;
      ake.completionTokens += completionTokens;
      ake.cachedTokens += cachedTokens;
      ake.cost += entryCost;
      if (new Date(r.timestamp) > new Date(ake.lastUsed)) ake.lastUsed = r.timestamp;

      const endpoint = r.endpoint || "Unknown";
      const epKey = `${endpoint}|${r.model}|${r.provider || "unknown"}`;
      if (!stats.byEndpoint[epKey]) {
        stats.byEndpoint[epKey] = {
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          cost: 0,
          endpoint,
          rawModel: r.model,
          provider: providerDisplayName,
          lastUsed: r.timestamp,
        };
      }
      const epe = stats.byEndpoint[epKey];
      epe.requests++;
      epe.promptTokens += promptTokens;
      epe.completionTokens += completionTokens;
      epe.cachedTokens += cachedTokens;
      epe.cost += entryCost;
      if (new Date(r.timestamp) > new Date(epe.lastUsed)) epe.lastUsed = r.timestamp;
    }
  }

  stats.totalRequests = Object.values(stats.byProvider).reduce(
    (sum, p) => sum + (p.requests || 0),
    0,
  );
  return stats;
}

export async function getChartData(period = "7d") {
  const db = await getAdapter();
  const now = Date.now();

  if (period === "today") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startTime = startOfDay.getTime();
    const endTime = startTime + bucketCount * bucketMs;
    const labelFn = (ts) =>
      new Date(ts).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({
      label: labelFn(startTime + i * bucketMs),
      input: 0,
      cached: 0,
      output: 0,
      tokens: 0,
      cost: 0,
    }));

    const rows = db.all(
      `SELECT timestamp, promptTokens, completionTokens, cost, tokens FROM usageHistory WHERE timestamp >= ?`,
      [new Date(startTime).toISOString()],
    );
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (t < startTime || t >= endTime) continue;
      const idx = Math.floor((t - startTime) / bucketMs);
      if (idx >= 0 && idx < bucketCount) {
        const tk = parseJson(r.tokens, {}) || {};
        const input = Math.max(
          tk.prompt_tokens || tk.input_tokens || r.promptTokens || 0,
          tk.cached_tokens || tk.cache_read_input_tokens || 0,
        );
        const cached = tk.cached_tokens || tk.cache_read_input_tokens || 0;
        const output = tk.completion_tokens || tk.output_tokens || r.completionTokens || 0;
        buckets[idx].input += input;
        buckets[idx].cached += cached;
        buckets[idx].output += output;
        buckets[idx].tokens += input + output;
        buckets[idx].cost += r.cost || 0;
      }
    }
    return buckets;
  }

  if (period === "24h") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const labelFn = (ts) =>
      new Date(ts).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    const startTime = now - bucketCount * bucketMs;
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({
      label: labelFn(startTime + i * bucketMs),
      input: 0,
      cached: 0,
      output: 0,
      tokens: 0,
      cost: 0,
    }));

    const rows = db.all(
      `SELECT timestamp, promptTokens, completionTokens, cost, tokens FROM usageHistory WHERE timestamp >= ?`,
      [new Date(startTime).toISOString()],
    );
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (t < startTime || t > now) continue;
      const idx = Math.min(Math.floor((t - startTime) / bucketMs), bucketCount - 1);
      const tk = parseJson(r.tokens, {}) || {};
      const input = Math.max(
        tk.prompt_tokens || tk.input_tokens || r.promptTokens || 0,
        tk.cached_tokens || tk.cache_read_input_tokens || 0,
      );
      const cached = tk.cached_tokens || tk.cache_read_input_tokens || 0;
      const output = tk.completion_tokens || tk.output_tokens || r.completionTokens || 0;
      buckets[idx].input += input;
      buckets[idx].cached += cached;
      buckets[idx].output += output;
      buckets[idx].tokens += input + output;
      buckets[idx].cost += r.cost || 0;
    }
    return buckets;
  }

  const bucketCount = period === "7d" ? 7 : period === "30d" ? 30 : 60;
  const today = new Date();
  const labelFn = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  // Build map of dateKey → day data
  const dayRows = loadDaysInRange(db, bucketCount);
  const dayMap = {};
  for (const r of dayRows) dayMap[r.dateKey] = parseJson(r.data, {});

  return Array.from({ length: bucketCount }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (bucketCount - 1 - i));
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const dayData = dayMap[dateKey];
    const input = dayData ? Math.max(dayData.promptTokens || 0, dayData.cachedTokens || 0) : 0;
    const cached = dayData ? dayData.cachedTokens || 0 : 0;
    const output = dayData ? dayData.completionTokens || 0 : 0;
    return {
      label: labelFn(d),
      input,
      cached,
      output,
      tokens: input + output,
      cost: dayData ? dayData.cost || 0 : 0,
    };
  });
}

function formatLogDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// No-op: request log is now derived from usageHistory table on read.
export async function appendRequestLog() {}

export async function getRecentLogs(limit = 200) {
  try {
    const db = await getAdapter();
    const rows = db.all(
      `SELECT timestamp, provider, model, connectionId, promptTokens, completionTokens, status, tokens FROM usageHistory ORDER BY id DESC LIMIT ?`,
      [limit],
    );
    if (!rows.length) return [];

    const connMap = {};
    try {
      const { getProviderConnections } = await import("./connectionsRepo.js");
      const connections = await getProviderConnections();
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

export const SAVINGS_PERIODS = ["today", "7d", "30d"];

const SAVINGS_DAY_MS = 24 * 60 * 60 * 1000;

function savingsPeriodRange(period, now) {
  if (period === "today") {
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    return { start: startOfToday.toISOString(), end: new Date(now).toISOString() };
  }
  const days = period === "30d" ? 30 : 7;
  return {
    start: new Date(now - days * SAVINGS_DAY_MS).toISOString(),
    end: new Date(now).toISOString(),
  };
}

/**
 * Period savings from recorded per-request meta (usageHistory.meta.savings).
 * Estimated only — RTK bytes/4, real Headroom tokens, PXPIPE estimates.
 * PXPIPE uses the same meta source (recorded once per successful request),
 * never the JSONL events file, so there is no double counting.
 */
export async function getUsageSavings(period = "7d") {
  if (!SAVINGS_PERIODS.includes(period)) throw new Error(`Invalid period: ${period}`);
  const db = await getAdapter();
  const now = Date.now();
  const { start, end } = savingsPeriodRange(period, now);

  const rows = db.all(
    `SELECT timestamp, provider, model, meta FROM usageHistory WHERE timestamp >= ? AND timestamp <= ?`,
    [start, end],
  );

  const byMethod = {};
  let tokensSavedEst = 0;
  let tokensBeforeEst = 0;
  let requestsWithSavings = 0;
  let costSavedEst = 0;
  let pricedRequests = 0;

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

    const rowCost = await savedTokensCost(row.provider, row.model, rowSaved);
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
 * @returns {Promise<number>} dollars
 */
async function savedTokensCost(provider, model, savedTokens) {
  if (!model || !(savedTokens > 0)) return 0;
  try {
    const { getPricingForModel } = await import("./pricingRepo.js");
    const pricing = await getPricingForModel(provider, model);
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
export async function getLiveRoutesFeed({ windowMs = 5 * 60 * 1000, limit = 500 } = {}) {
  const db = await getAdapter();
  const since = new Date(Date.now() - windowMs).toISOString();

  const { getApiKeys } = await import("./apiKeysRepo.js");
  const keyNames = {};
  try {
    const keys = await getApiKeys();
    for (const key of keys || []) keyNames[key.key] = key.name || "Unnamed key";
  } catch {}

  const capped = Math.max(1, Math.min(Number(limit) || 500, 2000));
  const usage = db.all(
    `SELECT timestamp, provider, model, apiKey, meta FROM usageHistory WHERE timestamp > ? ORDER BY id DESC LIMIT ?`,
    [since, capped],
  );
  // Failed attempts only reach requestDetails (usageHistory records successes);
  // the upstream status code sits in the detail JSON (response.status).
  const errors = db.all(
    `SELECT timestamp, provider, model, data FROM requestDetails WHERE timestamp > ? AND status = 'error' ORDER BY timestamp DESC LIMIT ?`,
    [since, capped],
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
          keyName: keyNames[row.apiKey] || null,
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
    fallbackHops: global._fallbackHops.filter((hop) => hop.timestamp > since),
  };
}

export async function getHomeSummary(period = "7d") {
  if (!SAVINGS_PERIODS.includes(period)) throw new Error(`Invalid period: ${period}`);
  const db = await getAdapter();
  const now = Date.now();

  const current = savingsPeriodRange(period, now);
  const spanMs = new Date(current.end).getTime() - new Date(current.start).getTime();
  const prev = {
    start: new Date(new Date(current.start).getTime() - spanMs).toISOString(),
    end: current.start,
  };

  const countIn = (start, end) => {
    const row = db.get(
      `SELECT COUNT(*) AS n FROM usageHistory WHERE timestamp >= ? AND timestamp <= ?`,
      [start, end],
    );
    return row?.n || 0;
  };

  const requests = countIn(current.start, current.end);
  const previousRequests = countIn(prev.start, prev.end);

  const rows = db.all(
    `SELECT timestamp, meta FROM usageHistory WHERE timestamp >= ? AND timestamp <= ?`,
    [current.start, current.end],
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
