#!/usr/bin/env node
// YAN-370 write-latency benchmark: old usageDaily JSON-blob read-modify-write
// vs the usageRollup increment upsert, each alongside the usageHistory insert,
// on a DB seeded with 100k history rows (and a populated day blob / rollup).
//
//   node scripts/bench-usage-rollup.mjs [--rows 100000] [--writes 2000]
//
// Exits 1 when the new p50 exceeds 1.2x the old p50 (issue gate). Not wired
// into CI. ponytail: both paths are inlined SQL copies of the repo code (no
// app imports, so plain node runs it); re-sync if the write path changes.
import { DatabaseSync } from "node:sqlite";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};
const ROWS = arg("rows", 100_000);
const WRITES = arg("writes", 2000);
const DAY = "2026-10-07";
const models = ["gpt-4o", "gpt-4o-mini", "claude-sonnet", "gemini-pro", "grok-4"];
const providers = ["openai", "anthropic", "gemini", "xai"];
const pick = (a, i) => a[i % a.length];
const entry = (i) => ({
  provider: pick(providers, i),
  model: pick(models, i * 7),
  connectionId: `conn-${i % 12}`,
  apiKeyId: `key-${i % 30}`,
  endpoint: "/v1/chat/completions",
  workspaceId: `ws-${i % 3}`,
  userId: `user-${i % 9}`,
  promptTokens: 100 + (i % 50),
  completionTokens: 40 + (i % 20),
  cost: 0.001,
});

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE usageHistory (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
    provider TEXT, model TEXT, connectionId TEXT, apiKey TEXT, endpoint TEXT, promptTokens INTEGER,
    completionTokens INTEGER, cost REAL, status TEXT, tokens TEXT, meta TEXT, workspaceId TEXT,
    userId TEXT, apiKeyId TEXT, grantId TEXT);
    CREATE INDEX idx_uh_ts ON usageHistory(timestamp DESC);
    CREATE INDEX idx_uh_ws_ts ON usageHistory(workspaceId, timestamp DESC);
    CREATE TABLE usageDaily (dateKey TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE usageRollup (dateKey TEXT NOT NULL, workspaceId TEXT NOT NULL DEFAULT '',
      userId TEXT NOT NULL DEFAULT '', apiKeyId TEXT NOT NULL DEFAULT 'local-no-key',
      provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', connectionId TEXT NOT NULL DEFAULT '',
      endpoint TEXT NOT NULL DEFAULT '', requests INTEGER NOT NULL DEFAULT 0, tokensIn INTEGER NOT NULL DEFAULT 0,
      tokensOut INTEGER NOT NULL DEFAULT 0, tokensCached INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint));
    CREATE INDEX idx_ur_ws_date ON usageRollup(workspaceId, dateKey);`);
  const ins = db.prepare(
    `INSERT INTO usageHistory (timestamp, provider, model, connectionId, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, workspaceId, userId, apiKeyId) VALUES (?,?,?,?,?,?,?,?,'ok',?,'{}',?,?,?)`,
  );
  return { db, ins };
}

const insertHistory = (ins, e, ts) =>
  ins.run(
    ts,
    e.provider,
    e.model,
    e.connectionId,
    e.endpoint,
    e.promptTokens,
    e.completionTokens,
    e.cost,
    JSON.stringify({ prompt_tokens: e.promptTokens, completion_tokens: e.completionTokens }),
    e.workspaceId,
    e.userId,
    e.apiKeyId,
  );

// Old path: aggregateEntryToDay on the day's blob (origin/master usageRepo.js).
function addTo(t, k, v, meta) {
  t[k] ||= { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
  t[k].requests += 1;
  t[k].promptTokens += v.promptTokens;
  t[k].completionTokens += v.completionTokens;
  t[k].cost += v.cost;
  if (meta) Object.assign(t[k], meta);
}
function blobWrite(db, e) {
  const row = db.prepare(`SELECT data FROM usageDaily WHERE dateKey = ?`).get(DAY);
  const day = row
    ? JSON.parse(row.data)
    : { byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {} };
  day.requests = (day.requests || 0) + 1;
  addTo(day.byProvider, e.provider, e);
  addTo(day.byModel, `${e.model}|${e.provider}`, e, { rawModel: e.model, provider: e.provider });
  addTo(day.byAccount, `${e.connectionId}|${e.model}|${e.provider}`, e, {
    connectionId: e.connectionId,
  });
  addTo(day.byApiKey, `${e.apiKeyId}|${e.model}|${e.provider}`, e, { apiKey: e.apiKeyId });
  addTo(day.byEndpoint, `${e.endpoint}|${e.model}|${e.provider}`, e, { endpoint: e.endpoint });
  db.prepare(
    `INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`,
  ).run(DAY, JSON.stringify(day));
}

// New path: usageRollupRepo.upsertRollupRowUnscoped.
function rollupWrite(db, e) {
  db.prepare(
    `INSERT INTO usageRollup (dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint, requests, tokensIn, tokensOut, tokensCached, cost)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, ?)
     ON CONFLICT (dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint) DO UPDATE SET
       requests = requests + excluded.requests, tokensIn = tokensIn + excluded.tokensIn,
       tokensOut = tokensOut + excluded.tokensOut, tokensCached = tokensCached + excluded.tokensCached,
       cost = cost + excluded.cost`,
  ).run(
    DAY,
    e.workspaceId,
    e.userId,
    e.apiKeyId,
    e.provider,
    e.model,
    e.connectionId,
    e.endpoint,
    e.promptTokens,
    e.completionTokens,
    e.cost,
  );
}

function run(name, write) {
  const { db, ins } = open();
  const ts = `${DAY}T12:00:00.000Z`;
  db.exec("BEGIN");
  for (let i = 0; i < ROWS; i++) {
    const e = entry(i);
    insertHistory(ins, e, ts);
    write(db, e);
  }
  db.exec("COMMIT");
  const times = [];
  for (let i = 0; i < WRITES; i++) {
    const e = entry(ROWS + i);
    const t0 = process.hrtime.bigint();
    db.exec("BEGIN");
    insertHistory(ins, e, ts);
    write(db, e);
    db.exec("COMMIT");
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const q = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))];
  const r = { name, p50: q(0.5), p99: q(0.99) };
  console.log(`${name.padEnd(7)} p50=${r.p50.toFixed(4)}ms p99=${r.p99.toFixed(4)}ms`);
  db.close();
  return r;
}

console.log(`seed=${ROWS} history rows, ${WRITES} timed writes`);
const old = run("blob", blobWrite);
const neu = run("rollup", rollupWrite);
const ratio = neu.p50 / old.p50;
console.log(`rollup/blob p50 ratio=${ratio.toFixed(3)} (gate ≤ 1.2)`);
process.exit(ratio > 1.2 ? 1 : 0);
