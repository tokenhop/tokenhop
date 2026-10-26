#!/usr/bin/env node
// YAN-1226 savings-rollup benchmark: (a) write-path overhead of folding the
// savings/combo/lastUsedAt deltas into the existing transaction vs the same
// transaction without them, and (b) the rollup savings read (one GROUP BY
// provider, model scan of usageRollup) vs the old per-row usageHistory meta
// scan, on a DB seeded with ~1M history rows (~10% savings-bearing, plus
// combo-bearing rows) and the equivalent rollup rows.
//
//   node scripts/bench-savings-rollup.mjs [--rows 1000000] [--writes 2000]
//
// Exits 1 when the savings write path adds > 20% to the non-savings p50, or
// when the rollup read is not at least 5x faster than the history scan.
// Not wired into CI. ponytail: both arms are inlined SQL copies of the repo
// code (no app imports, so plain node runs it); the source-drift guard below
// pins the copies to the live statements — re-sync if they change.
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

// ---- args -------------------------------------------------------------
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};
const ROWS = arg("rows", 1_000_000);
const WRITES = arg("writes", 2000);

// ---- source-drift guard ----------------------------------------------
// The inlined SQL below must match the live writer (bench-prediction-rollup
// pattern). usageRollupRepo.js builds UPSERT_SQL at module scope; assert its
// exact template fragments so any change fails here loudly.
{
  const repo = fs.readFileSync(
    new URL("../src/lib/db/repos/usageRollupRepo.js", import.meta.url),
    "utf8",
  );
  const upsert = repo.match(/^const UPSERT_SQL = `([\s\S]*?)`;\n/m);
  assert(upsert, "UPSERT_SQL not found in usageRollupRepo.js; re-sync bench");
  for (const fragment of [
    'INSERT INTO usageRollup (dateKey, ${DIMS.join(", ")}, requests, tokensIn, tokensOut, tokensCached, cost, ${MEASURE_COLUMNS.join(", ")}, lastUsedAt)',
    "${SAVINGS_MERGE_SQL},",
    "lastUsedAt = MAX(lastUsedAt, excluded.lastUsedAt)",
  ]) {
    assert(
      upsert[1].includes(fragment),
      `usageRollupRepo UPSERT_SQL drifted (missing ${JSON.stringify(fragment)}); re-sync bench-savings-rollup.mjs`,
    );
  }
  const combo = repo.match(/^const COMBO_UPSERT_SQL = `([\s\S]*?)`;\n/m);
  assert(combo, "COMBO_UPSERT_SQL not found in usageRollupRepo.js; re-sync bench");
  for (const fragment of [
    'INSERT INTO usageComboRollup (dateKey, ${COMBO_DIMS.join(", ")}, comboName, requests)',
    "DO UPDATE SET requests = requests + 1",
  ]) {
    assert(
      combo[1].includes(fragment),
      `usageRollupRepo COMBO_UPSERT_SQL drifted (missing ${JSON.stringify(fragment)}); re-sync bench-savings-rollup.mjs`,
    );
  }
  // And the frozen counting rule must stay in sync with the live helper.
  const helper = fs.readFileSync(
    new URL("../src/lib/db/helpers/usageSavingsRollup.js", import.meta.url),
    "utf8",
  );
  assert(
    helper.includes("d.savingsBeforeEst = Number(savings.tokensBeforeEst) || 0;"),
    "savingsDeltas top-level tokensBeforeEst rule drifted; re-sync bench",
  );
}

// ---- schema -----------------------------------------------------------
// Column lists frozen copies of schema.js / migration 021 (bench-prediction
// precedent: never import app modules).
const SAVINGS_COLS = [
  "savingsSavedEst",
  "savingsBeforeEst",
  "savingsRequests",
  "rtkSavedEst",
  "rtkBeforeEst",
  "rtkRequests",
  "headroomSavedEst",
  "headroomBeforeEst",
  "headroomRequests",
  "pxpipeSavedEst",
  "pxpipeBeforeEst",
  "pxpipeRequests",
];
const UPSERT_BASE = `INSERT INTO usageRollup (dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint, requests, tokensIn, tokensOut, tokensCached, cost${SAVINGS_COLS.map((c) => `, ${c}`).join("")}, lastUsedAt)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, ?${SAVINGS_COLS.map(() => ", ?").join("")}, ?)
 ON CONFLICT (dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint) DO UPDATE SET
   requests = requests + excluded.requests, tokensIn = tokensIn + excluded.tokensIn,
   tokensOut = tokensOut + excluded.tokensOut, tokensCached = tokensCached + excluded.tokensCached,
   cost = cost + excluded.cost${SAVINGS_COLS.map((c) => `, ${c} = ${c} + excluded.${c}`).join("")},
   lastUsedAt = MAX(lastUsedAt, excluded.lastUsedAt)`;
const UPSERT_NO_SAVINGS = `INSERT INTO usageRollup (dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint, requests, tokensIn, tokensOut, tokensCached, cost)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, ?)
 ON CONFLICT (dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint) DO UPDATE SET
   requests = requests + excluded.requests, tokensIn = tokensIn + excluded.tokensIn,
   tokensOut = tokensOut + excluded.tokensOut, tokensCached = tokensCached + excluded.tokensCached,
   cost = cost + excluded.cost`;
const COMBO_UPSERT = `INSERT INTO usageComboRollup (dateKey, workspaceId, userId, apiKeyId, comboName, requests)
 VALUES (?, ?, ?, ?, ?, 1)
 ON CONFLICT (dateKey, workspaceId, userId, apiKeyId, comboName)
 DO UPDATE SET requests = requests + 1`;
const HISTORY_INSERT = `INSERT INTO usageHistory (timestamp, provider, model, connectionId, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, workspaceId, userId, apiKeyId) VALUES (?,?,?,?,?,?,?,?,'ok',?,?,?, ?, ?)`;
// readSavingsTotals (usageRollupRepo.js): one aggregate scan, no history.
const ROLLUP_READ = `SELECT provider, model, ${SAVINGS_COLS.map((c) => `SUM(${c}) AS ${c}`).join(", ")}
 FROM usageRollup
 WHERE dateKey >= ?
 GROUP BY provider, model`;
// Old getUsageSavings: load every history row's meta in the window and parse.
const HISTORY_READ = `SELECT timestamp, provider, model, meta FROM usageHistory WHERE timestamp >= ? AND timestamp <= ?`;

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE usageHistory (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
    provider TEXT, model TEXT, connectionId TEXT, apiKey TEXT, endpoint TEXT, promptTokens INTEGER,
    completionTokens INTEGER, cost REAL, status TEXT, tokens TEXT, meta TEXT, workspaceId TEXT,
    userId TEXT, apiKeyId TEXT, grantId TEXT);
  CREATE INDEX idx_uh_ts ON usageHistory(timestamp DESC);
  CREATE INDEX idx_uh_ws_ts ON usageHistory(workspaceId, timestamp DESC);
  CREATE TABLE usageComboRollup (dateKey TEXT NOT NULL DEFAULT '', workspaceId TEXT NOT NULL DEFAULT '',
    userId TEXT NOT NULL DEFAULT '', apiKeyId TEXT NOT NULL DEFAULT 'local-no-key', comboName TEXT NOT NULL DEFAULT '',
    requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (dateKey, workspaceId, userId, apiKeyId, comboName));
  CREATE TABLE usageRollup (dateKey TEXT NOT NULL, workspaceId TEXT NOT NULL DEFAULT '',
    userId TEXT NOT NULL DEFAULT '', apiKeyId TEXT NOT NULL DEFAULT 'local-no-key',
    provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', connectionId TEXT NOT NULL DEFAULT '',
    endpoint TEXT NOT NULL DEFAULT '', requests INTEGER NOT NULL DEFAULT 0, tokensIn INTEGER NOT NULL DEFAULT 0,
    tokensOut INTEGER NOT NULL DEFAULT 0, tokensCached INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0${SAVINGS_COLS.map((c, i) => `, ${c} ${i === 2 || c.endsWith("Requests") ? "INTEGER" : "REAL"} NOT NULL DEFAULT 0`).join("")}, lastUsedAt TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (dateKey, workspaceId, userId, apiKeyId, provider, model, connectionId, endpoint));
  CREATE INDEX idx_ur_ws_date ON usageRollup(workspaceId, dateKey);`);
  return db;
}

// ---- seed data --------------------------------------------------------
const DAY_MS = 86_400_000;
const BASE = Date.UTC(2026, 0, 1);
const models = ["gpt-4o", "gpt-4o-mini", "claude-sonnet", "gemini-pro", "grok-4"];
const providers = ["openai", "openai", "anthropic", "gemini", "xai"];
const combos = ["alpha", "beta", "gamma", "delta"];
const pick = (a, i) => a[i % a.length];
const localDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// ~10% of rows carry savings; of those ~1/3 each rtk / headroom / pxpipe
// (sometimes two methods on one row, some zero/negative legs for realism).
function metaFor(i) {
  if (i % 10 !== 0) return i % 6 === 0 ? JSON.stringify({ comboName: pick(combos, i) }) : "{}";
  const methods = {};
  const kind = i % 3;
  if (kind !== 2) methods.rtk = { tokensSavedEst: 100 + (i % 50), tokensBeforeEst: 2000 };
  if (kind !== 0) methods.headroom = { tokensSavedEst: 60 + (i % 30), tokensBeforeEst: 1500 };
  if (i % 5 === 0) methods.pxpipe = { tokensSavedEst: -3, tokensBeforeEst: 0 }; // negative leg
  const saved = Object.values(methods).reduce((s, m) => s + Math.max(0, m.tokensSavedEst), 0);
  return JSON.stringify({
    ...(i % 6 === 0 ? { comboName: pick(combos, i) } : {}),
    savings: { byMethod: methods, tokensBeforeEst: saved * 3 },
  });
}

function savingsDeltas(metaRaw) {
  let meta = null;
  try {
    meta = JSON.parse(metaRaw);
  } catch {}
  const out = SAVINGS_COLS.map(() => 0);
  const idx = Object.fromEntries(SAVINGS_COLS.map((c, i) => [c, i]));
  const methods = meta?.savings?.byMethod;
  if (methods && typeof methods === "object") {
    let rowSaved = 0;
    for (const m of Object.values(methods)) {
      const saved = typeof m === "object" && m ? Number(m.tokensSavedEst) || 0 : 0;
      if (saved > 0) rowSaved += saved;
    }
    if (rowSaved > 0) {
      out[idx.savingsSavedEst] = rowSaved;
      out[idx.savingsBeforeEst] = Number(meta.savings.tokensBeforeEst) || 0;
      out[idx.savingsRequests] = 1;
      for (const [method, col] of [
        ["rtk", "rtk"],
        ["headroom", "headroom"],
        ["pxpipe", "pxpipe"],
      ]) {
        const m = methods[method];
        if (m === undefined) continue;
        const saved = Number(m.tokensSavedEst) || 0;
        if (saved <= 0) continue;
        out[idx[`${col}SavedEst`]] = saved;
        out[idx[`${col}BeforeEst`]] = Number(m.tokensBeforeEst) || 0;
        out[idx[`${col}Requests`]] = 1;
      }
    }
  }
  return out;
}

// ---- seed -------------------------------------------------------------

function seed(db) {
  const ins = db.prepare(HISTORY_INSERT);
  const up = db.prepare(UPSERT_BASE);
  const cu = db.prepare(COMBO_UPSERT);
  db.exec("BEGIN");
  const stmtTokens = JSON.stringify({ prompt_tokens: 100, completion_tokens: 40 });
  for (let i = 0; i < ROWS; i++) {
    // Spread over ~400 days ending "now" so day-grain windows are exercised.
    const tsMs = BASE + Math.floor((i * 400 * DAY_MS) / ROWS);
    const ts = new Date(tsMs).toISOString();
    const p = pick(providers, i);
    const m = pick(models, i * 7);
    const meta = metaFor(i);
    const ws = `ws-${i % 3}`;
    const user = `user-${i % 9}`;
    const key = `key-${i % 30}`;
    ins.run(
      ts,
      p,
      m,
      `conn-${i % 12}`,
      "/v1/chat/completions",
      100,
      40,
      0.001,
      stmtTokens,
      meta,
      ws,
      user,
      key,
    );
    up.run(
      localDay(tsMs),
      ws,
      user,
      key,
      p,
      m,
      `conn-${i % 12}`,
      "/v1/chat/completions",
      100,
      40,
      0.001,
      ...savingsDeltas(meta),
      ts,
    );
    const name = JSON.parse(meta).comboName;
    if (name) cu.run(localDay(tsMs), ws, user, key, name);
  }
  db.exec("COMMIT");
}

// ---- measurement ------------------------------------------------------

function quantile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function runWriteArm(name, { withSavings, withCombo }) {
  const db = open();
  const tsMs = BASE + 399 * DAY_MS; // last seeded day
  const ts = new Date(tsMs).toISOString();
  const stmtTokens = JSON.stringify({ prompt_tokens: 100, completion_tokens: 40 });
  const ins = db.prepare(HISTORY_INSERT);
  const up = db.prepare(withSavings ? UPSERT_BASE : UPSERT_NO_SAVINGS);
  const cu = db.prepare(COMBO_UPSERT);
  const meta = metaFor(0); // savings-bearing, combo-bearing payload
  const deltas = savingsDeltas(meta, ts);
  const times = [];
  const stamp = {
    ins: [
      ts,
      "openai",
      "gpt-4o",
      "conn-1",
      "/v1/chat/completions",
      100,
      40,
      0.001,
      stmtTokens,
      meta,
      "ws-0",
      "user-0",
      "key-0",
    ],
    base: [
      localDay(tsMs),
      "ws-0",
      "user-0",
      "key-0",
      "openai",
      "gpt-4o",
      "conn-1",
      "/v1/chat/completions",
      100,
      40,
      0.001,
    ],
  };
  const comboName = JSON.parse(meta).comboName;
  for (let i = 0; i < WRITES; i++) {
    const t0 = process.hrtime.bigint();
    db.exec("BEGIN");
    ins.run(...stamp.ins);
    if (withSavings) up.run(...stamp.base, ...deltas, ts);
    else up.run(...stamp.base);
    // The combo upsert runs only for combo requests (a minority); it is
    // reported separately so the gate measures the per-request upsert cost.
    if (withCombo && comboName) cu.run(localDay(tsMs), "ws-0", "user-0", "key-0", comboName);
    db.exec("COMMIT");
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  db.close();
  return { name, p50: quantile(times, 0.5), p99: quantile(times, 0.99) };
}

// Alternate the arms over several rounds and keep each arm's best p50, so a
// burst of background load on a shared box can't land on one arm only.
function runWriteArms(arms, rounds = 5) {
  const best = {};
  for (let r = 0; r < rounds; r++) {
    for (const [name, opts] of arms) {
      const res = runWriteArm(name, opts);
      if (!best[name] || res.p50 < best[name].p50) best[name] = res;
    }
  }
  for (const res of Object.values(best)) {
    console.log(`${res.name.padEnd(16)} p50=${res.p50.toFixed(4)}ms p99=${res.p99.toFixed(4)}ms`);
  }
  return best;
}

function runReadArm(db, name) {
  // 30-day window (mirrors getUsageSavings('30d') / readSavingsTotals).
  const since = new Date(BASE + 370 * DAY_MS).toISOString();
  const until = new Date(BASE + 400 * DAY_MS).toISOString();
  const sinceKey = localDay(BASE + 370 * DAY_MS);
  const times = [];
  let checked = null;
  const historyRows = db
    .prepare(`SELECT COUNT(*) AS n FROM usageHistory WHERE timestamp >= ? AND timestamp <= ?`)
    .get(since, until).n;
  for (let i = 0; i < 5; i++) {
    const t0 = process.hrtime.bigint();
    if (name === "rollup") {
      const rows = db.prepare(ROLLUP_READ).all(sinceKey);
      if (!checked)
        checked = { groups: rows.length, rowsScanned: "usageRollup only (no usageHistory)" };
    } else {
      const rows = db.prepare(HISTORY_READ).all(since, until);
      // Old path: parse every row's meta and fold in JS.
      let saved = 0;
      for (const row of rows) {
        saved += savingsDeltas(row.meta)[0];
      }
      if (!checked)
        checked = { groups: rows.length, rowsScanned: `${historyRows} history rows parsed in JS` };
    }
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const r = { name, p50: quantile(times, 0.5), checked };
  console.log(`${name.padEnd(16)} p50=${r.p50.toFixed(2)}ms (${r.checked.rowsScanned})`);
  return { ...r, historyRows };
}

// ---- run --------------------------------------------------------------

console.log(
  `seed=${ROWS} history rows (~${Math.round(ROWS / 10)} savings-bearing), ${WRITES} timed writes`,
);
const readDb = open();
seed(readDb);
console.log(
  `rollup rows=${readDb.prepare(`SELECT COUNT(*) AS n FROM usageRollup`).get().n} combo rows=${readDb.prepare(`SELECT COUNT(*) AS n FROM usageComboRollup`).get().n}`,
);
const histRollup = runReadArm(readDb, "history");
const rollupRead = runReadArm(readDb, "rollup");
const speedup = histRollup.p50 / rollupRead.p50;
const readGate = histRollup.historyRows >= 50_000 ? 5 : 2; // small runs: sanity only
console.log(
  `rollup/history read p50 ratio=${speedup.toFixed(1)}x (gate ≥ ${readGate}; window rows=${histRollup.historyRows})`,
);
readDb.close();

const writes = runWriteArms([
  ["no-savings", { withSavings: false, withCombo: false }],
  ["with-savings", { withSavings: true, withCombo: false }],
  ["with-combo", { withSavings: true, withCombo: true }],
]);
const ratio = writes["with-savings"].p50 / writes["no-savings"].p50;
console.log(`savings/plain write p50 ratio=${ratio.toFixed(3)} (gate ≤ 1.2)`);
console.log(
  `combo request extra statement p50=+${(writes["with-combo"].p50 - writes["with-savings"].p50).toFixed(4)}ms (combo requests only; informational)`,
);

const failed = speedup < readGate || ratio > 1.2;
if (failed) {
  console.error("BENCH GATE FAILED");
  process.exit(1);
}
console.log("bench gates passed");
