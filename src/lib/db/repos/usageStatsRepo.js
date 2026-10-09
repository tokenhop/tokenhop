// Usage stats and chart readers (YAN-370). Day-grain periods read the
// usageRollup table, sub-day periods read usageHistory; both feed one
// aggregator so the response shape is identical either way. `ctx` is a usage
// scope: null is the unscoped view (switch off / one user), otherwise
// `{ workspaceId, userId? }` (see usageRollupRepo.scopeSql).
import { createHash } from "node:crypto";
import { getAdapter } from "../driver.js";
import { parseJson } from "../helpers/jsonCol.js";
import { PERIOD_DAYS, periodStart } from "@/shared/utils/period";
import { readApiKeyStorageState } from "../apiKeyState.js";
import { tableHasColumn } from "../migrations/helpers.js";
import { lastErrorFor, pendingView } from "./usageLiveFeed.js";
import {
  NO_KEY,
  cutoffDateKey,
  localDateKey,
  readRollup,
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
      hashed = tableHasColumn(db, "apiKeys", "keyHash");
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
 * History-backed for every period: the rollup has no meta. Sets the values on
 * each matching byEndpoint row and per endpoint in `stats.endpointLatency`
 * (a group p50 can't be derived from per-row p50s).
 * ponytail: loads up to LATENCY_SAMPLE_CAP most recent rows into JS (keystroke
 * volume can be large; "all" would otherwise scan everything). Move to rollup
 * columns if stats over the full window are needed.
 */
function addCompletionsLatency(stats, db, scope, period) {
  // Same calendar window as the rollup/history rows above; "all" = no cutoff.
  const cutoff =
    period === "24h" || period === "today" || PERIOD_DAYS[period]
      ? periodStart(period, Date.now())
      : 0;
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

const historyRow = (r) => {
  const t = parseJson(r.tokens, {}) || {};
  return {
    ...r,
    requests: 1,
    tokensIn: r.promptTokens || 0,
    tokensOut: r.completionTokens || 0,
    tokensCached: t.cached_tokens || t.cache_read_input_tokens || 0,
    cost: r.cost || 0,
    lastUsed: r.timestamp,
  };
};

export async function getUsageStats(ctx, period = "all") {
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
  if (period === "24h" || period === "today") {
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
    // Overlay precise lastUsed timestamps from history.
    const cutoff = maxDays ? Date.now() - maxDays * 86400000 : 0;
    for (const e of db.all(
      `SELECT timestamp, provider, model, connectionId, apiKeyId, endpoint FROM usageHistory ${whereAll(scope.sql, "timestamp >= ?")}`,
      [...scope.params, new Date(cutoff).toISOString()],
    )) {
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
        const name = maps.connections[e.connectionId] || `Account ${e.connectionId.slice(0, 8)}...`;
        keys.push([stats.byAccount, `${model} (${provider} - ${name})`]);
      }
      for (const [bucket, key] of keys) {
        if (bucket[key] && new Date(e.timestamp) > new Date(bucket[key].lastUsed))
          bucket[key].lastUsed = e.timestamp;
      }
    }
  }

  addCompletionsLatency(stats, db, scope, period);
  stats.totalRequests = Object.values(stats.byProvider).reduce((s, p) => s + (p.requests || 0), 0);
  return stats;
}

const hourLabel = (ts) =>
  new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

export async function getChartData(ctx, period = "7d") {
  const db = await getAdapter();
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

  const bucketCount = PERIOD_DAYS[period];
  const days = {};
  for (const r of readRollup(ctx, db, cutoffDateKey(bucketCount))) {
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
