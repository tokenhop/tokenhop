#!/usr/bin/env node
// YAN-1063 / GH #888. Run: node scripts/bench-prediction-rollup.mjs
// Options: --driver default|node --rows N --writes N --warmup N --reps N(even).
// Current history+rollup transaction vs SAME SQL minus histogram UPDATE merge.
// Baseline intentionally retains first-insert bins; not a valid replacement.
// ponytail: isolated synchronous writer only; add concurrent load for contention.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createNodeSqliteAdapter } from "../src/lib/db/adapters/nodeSqliteAdapter.js";
import { TABLES, buildCreateTableSql } from "../src/lib/db/schema.js";
import {
  LATENCY_BOUNDS,
  LATENCY_MERGE_SQL,
  latencyDeltas,
} from "../src/lib/db/helpers/usageLatencyRollup.js";
import { localDateKey, upsertRollupRowUnscoped } from "../src/lib/db/repos/usageRollupRepo.js";

// Defined BEFORE measurements: material if median paired overhead meets BOTH
// >=0.1 ms and >=20%, on p50 OR p95. Local diagnostic, never a universal SLA.
const MIN_MS = 0.1,
  MIN_PCT = 20;
const usage =
  "usage: bench-prediction-rollup.mjs [--driver default|node] [--rows N] [--writes N] [--warmup N] [--reps N(even)]";
let args;
try {
  args = parseArgs({
    options: {
      driver: { type: "string", default: "default" },
      rows: { type: "string", default: "20000" },
      writes: { type: "string", default: "10000" },
      warmup: { type: "string", default: "1000" },
      reps: { type: "string", default: "4" },
    },
    allowPositionals: false,
  }).values;
  for (const [name, min, max] of [
    ["rows", 0, 200000],
    ["writes", 100, 100000],
    ["warmup", 0, 10000],
    ["reps", 2, 12],
  ]) {
    assert(/^\d+$/.test(args[name]), `--${name} must be integer`);
    args[name] = Number(args[name]);
    assert(args[name] >= min && args[name] <= max, `--${name} must be ${min}..${max}`);
  }
  assert(args.reps % 2 === 0, "--reps must be even (balanced order)");
  assert(["default", "node"].includes(args.driver), "--driver must be default|node");
} catch (e) {
  console.error(`${e.message}\n${usage}`);
  process.exit(2);
}
// Mirror driver.js's Node default: better-sqlite3 below 24; node:sqlite on 24+.
// No driver.js import: it resolves real DATA_DIR and takes writer locks.
let open = createNodeSqliteAdapter;
let fallback = "bun:sqlite and sql.js untested";
if (args.driver === "default" && Number(process.versions.node.split(".")[0]) < 24) {
  try {
    open = (await import("../src/lib/db/adapters/betterSqliteAdapter.js"))
      .createBetterSqliteAdapter;
  } catch (e) {
    fallback += `; better-sqlite3 unavailable: ${e.message}`;
  }
}
const schema = ["users", "workspaces", "usageHistory", "usageRollup"]
  .flatMap((t) => [buildCreateTableSql(t, TABLES[t]), ...(TABLES[t].indexes || [])])
  .join(";\n");
// Verbatim history SQL; source guard prevents silent drift (repo has @ aliases).
const insert =
  "INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, workspaceId, userId, apiKeyId, grantId) VALUES(?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM workspaces WHERE id = ?), (SELECT id FROM users WHERE id = ?), ?, ?)";
const stored = "SELECT workspaceId, userId FROM usageHistory WHERE id = last_insert_rowid()";
const source = fs.readFileSync(
  new URL("../src/lib/db/repos/usageRepo.js", import.meta.url),
  "utf8",
);
assert(source.includes(insert) && source.includes(stored), "usageRepo SQL drifted; re-sync bench");
const clause = LATENCY_MERGE_SQL.slice(LATENCY_MERGE_SQL.indexOf("latencyHistogram = CASE"));
assert(clause.includes("json_array(") && LATENCY_MERGE_SQL.endsWith(clause));
const day = new Date(2026, 9, 12, 12).toISOString(),
  dateKey = localDateKey(day);
const dims = ["workspaceId", "userId", "apiKeyId", "provider", "model", "connectionId", "endpoint"];
const key = (r) =>
  JSON.stringify(dims.map((d) => r[d] || (d === "apiKeyId" ? "local-no-key" : "")));
const counts = [
  "requests",
  "tokensIn",
  "tokensOut",
  "tokensCached",
  "latencySumMs",
  "latencyCount",
  "emptyCount",
  "latencyRequests",
];
// Deterministic seeded random; all arms/reps share identical inputs per pair.
function random(seed) {
  let x = seed;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}
function payloads(scenario, seed) {
  const r = random(seed),
    pick = (n, p) => `${p}-${Math.floor(r() * n)}`;
  const pool = Array.from({ length: scenario.startsWith("hot") ? 1 : 512 }, (_, i) => ({
    workspaceId: i % 9 === 8 ? null : pick(8, "ws"),
    userId: i % 11 === 10 ? null : pick(16, "u"),
    apiKeyId: i % 7 === 6 ? "local-no-key" : pick(32, "key"),
    provider: "openai",
    model: pick(8, "fim"),
    connectionId: pick(24, "conn"),
  }));
  return Array.from({ length: args.warmup + args.writes }, (_, i) => {
    const d = {
      ...pool[i < pool.length ? i : Math.floor(r() * pool.length)],
      dateKey,
      endpoint: scenario.endsWith("mixed") && r() < 0.7 ? "/v1/chat/completions" : "completions",
    };
    // Cycle every bin boundary + overflow, invalid/missing, empty and zero.
    // Variable latency independent of attribution; includes all bins even mixed.
    const ms = [...LATENCY_BOUNDS, 200000, "bad", null][Math.floor(r() * 15)];
    const meta = { latencyMs: ms, empty: r() < 0.1 };
    const delta = {
      requests: 1,
      tokensIn: 100 + (i % 50),
      tokensOut: 40 + (i % 20),
      tokensCached: 0,
      cost: 0.001,
      ...latencyDeltas(d.endpoint, meta),
    };
    return {
      d,
      delta,
      hist: [
        day,
        d.provider,
        d.model,
        d.connectionId,
        d.endpoint,
        delta.tokensIn,
        delta.tokensOut,
        delta.cost,
        "ok",
        JSON.stringify({ prompt_tokens: delta.tokensIn, completion_tokens: delta.tokensOut }),
        JSON.stringify(meta),
        d.workspaceId,
        d.userId,
        d.apiKeyId,
        null,
      ],
    };
  });
}
// Oracle: sum every dimension independently; full bins/counts AND baseline's
// deliberate first-insert-only histogram. Also assert helper against bin fixtures.
for (let i = 0; i < LATENCY_BOUNDS.length; i++) {
  const bins = Array(12).fill(0);
  bins[i] = 1;
  assert.deepEqual(
    JSON.parse(latencyDeltas("completions", { latencyMs: LATENCY_BOUNDS[i] }).latencyHistogram),
    bins,
  );
}
assert.equal(latencyDeltas("completions", { latencyMs: 200000 }).latencyCount, 1);
assert.equal(
  JSON.parse(latencyDeltas("completions", { latencyMs: 200000 }).latencyHistogram)[11],
  1,
);
assert.equal(latencyDeltas("completions", { latencyMs: "bad" }).latencyCount, 0);
assert.equal(latencyDeltas("/v1/chat/completions", { latencyMs: 100 }).latencyRequests, 0);
function verify(db, arm, data) {
  const expected = new Map();
  for (const { d, delta } of data) {
    const k = key(d),
      e = expected.get(k) || {
        ...Object.fromEntries(counts.map((c) => [c, 0])),
        bins: Array(12).fill(0),
        first: delta.latencyHistogram,
      };
    for (const c of counts) e[c] += delta[c];
    JSON.parse(delta.latencyHistogram).forEach((n, i) => {
      e.bins[i] += n;
    });
    expected.set(k, e);
  }
  const rows = db.all("SELECT * FROM usageRollup"),
    hit = new Set();
  assert.equal(rows.length, expected.size, "dimension isolation");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM usageHistory").n, args.rows + data.length);
  for (const row of rows) {
    assert.equal(row.dateKey, dateKey);
    const e = expected.get(key(row));
    assert(e, "unexpected dimension");
    for (const c of counts) assert.equal(row[c], e[c], `${arm} ${c} ${key(row)}`);
    assert(Math.abs(row.cost - e.requests * 0.001) < 1e-9);
    const bins = JSON.parse(row.latencyHistogram);
    assert.deepEqual(bins, arm === "histogram" ? e.bins : JSON.parse(e.first));
    if (arm === "histogram") {
      assert.equal(
        bins.reduce((a, b) => a + b, 0),
        row.latencyCount,
      );
      bins.forEach((n, i) => {
        if (n) hit.add(i);
      });
    }
  }
  if (arm === "histogram" && data.length >= 10000) assert.equal(hit.size, 12, "all bins exercised");
  return rows.length;
}
const median = (a) => {
  const s = [...a].sort((a, b) => a - b),
    h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
const quantile = (s, p) => s[Math.ceil(s.length * p) - 1];
const events = ["beforeExit", "SIGINT", "SIGTERM"];
// Real adapters register process-lifetime listeners. Bench closes many handles;
// remove only listeners registered by this handle, not unrelated listeners.
async function run(file, arm, data) {
  const before = events.map((e) => process.listeners(e));
  let db;
  try {
    db = await open(file);
    db.exec(schema);
    db.transaction(() => {
      for (let i = 0; i < 16; i++)
        db.run(
          "INSERT INTO users(id, instanceRole, createdAt, updatedAt) VALUES(?, 'user', ?, ?)",
          [`u-${i}`, day, day],
        );
      for (let i = 0; i < 8; i++)
        db.run(
          "INSERT INTO workspaces(id, name, kind, createdAt, updatedAt) VALUES(?, ?, 'shared', ?, ?)",
          [`ws-${i}`, `ws-${i}`, day, day],
        );
      for (let i = 0; i < args.rows; i++)
        db.run(insert, [
          new Date(2026, 8, 1 + (i % 40), 12, 0, i % 60).toISOString(),
          "openai",
          `fim-${i % 8}`,
          `conn-${i % 24}`,
          "chat",
          100,
          40,
          0.001,
          "ok",
          "{}",
          "{}",
          `ws-${i % 8}`,
          `u-${i % 16}`,
          `key-${i % 32}`,
          null,
        ]);
    });
    const sqlCache = new Map();
    const writer = {
      run(sql, params) {
        if (!sqlCache.has(sql)) {
          let edited = sql;
          if (arm === "baseline") {
            assert(sql.endsWith(clause), "merge must remain final SET clause");
            edited = sql.slice(0, -(clause.length + 2)); // remove preceding ', '
            assert(!edited.includes("latencyHistogram = "));
          }
          sqlCache.set(sql, edited);
        }
        db.run(sqlCache.get(sql), params);
      },
    };
    const txn = (p) =>
      db.transaction(() => {
        db.run(insert, p.hist);
        const identity = db.get(stored);
        upsertRollupRowUnscoped(writer, { ...p.d, ...identity }, p.delta);
      });
    for (let i = 0; i < args.warmup; i++) txn(data[i]);
    const samples = new Float64Array(args.writes),
      start = process.hrtime.bigint();
    for (let i = 0; i < args.writes; i++) {
      const t = process.hrtime.bigint();
      txn(data[i + args.warmup]);
      samples[i] = Number(process.hrtime.bigint() - t) / 1e6;
    }
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const rows = verify(db, arm, data);
    samples.sort();
    return {
      p50: quantile(samples, 0.5),
      p95: quantile(samples, 0.95),
      p99: quantile(samples, 0.99),
      tps: args.writes / seconds,
      rows,
    };
  } finally {
    db?.close();
    events.forEach((e, i) => {
      for (const listener of process.listeners(e))
        if (!before[i].includes(listener)) process.removeListener(e, listener);
    });
  }
}
// No HOME/DATA_DIR resolution; only files under unique temporary directory.
const tmp = fs.existsSync("/tmp/opencode") ? "/tmp/opencode" : os.tmpdir();
const dir = fs.mkdtempSync(path.join(tmp, "tokenhop-bench-pred-"));
let material = false;
try {
  // Probe uses same cleanup as run; close also removes process hooks.
  const before = events.map((e) => process.listeners(e));
  const probe = await open(path.join(dir, "probe.sqlite"));
  try {
    console.log(
      JSON.stringify(
        {
          runtime: process.version,
          driver: probe.driver,
          sqlite: probe.get("SELECT sqlite_version() AS v").v,
          os: `${os.platform()} ${os.release()} ${os.arch()}`,
          cpu: `${os.cpus()[0].model} x${os.cpus().length}`,
          memoryGiB: Math.round(os.totalmem() / 2 ** 30),
          temp: dir,
          args,
          untested: fallback,
          threshold: { ms: MIN_MS, pct: MIN_PCT, statistic: "median paired p50 OR p95" },
          pragmas: Object.fromEntries(
            [
              "journal_mode",
              "synchronous",
              "temp_store",
              "mmap_size",
              "cache_size",
              "foreign_keys",
              "busy_timeout",
              "wal_autocheckpoint",
            ].map((n) => [n, Object.values(probe.get(`PRAGMA ${n}`))[0]]),
          ),
        },
        null,
        2,
      ),
    );
  } finally {
    probe.close();
    events.forEach((e, i) => {
      for (const l of process.listeners(e))
        if (!before[i].includes(l)) process.removeListener(e, l);
    });
  }
  for (const scenario of ["hot", "varied", "hot-mixed", "varied-mixed"]) {
    const results = { histogram: [], baseline: [] };
    for (let rep = 0; rep < args.reps; rep++) {
      const data = payloads(scenario, 1000 + rep);
      for (const arm of rep % 2 ? ["baseline", "histogram"] : ["histogram", "baseline"]) {
        const file = path.join(dir, `${scenario}-${rep}-${arm}.sqlite`);
        results[arm].push(await run(file, arm, data));
        for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
      }
    }
    console.log(
      `\n${scenario}: all ${args.reps * 2} arm assertions passed; ${results.histogram[0].rows} rollup rows`,
    );
    console.log("metric baseline histogram paired_delta_ms paired_delta_pct slower_reps");
    for (const m of ["p50", "p95", "p99"]) {
      const b = results.baseline.map((x) => x[m]),
        h = results.histogram.map((x) => x[m]);
      const ds = h.map((x, i) => x - b[i]),
        dp = ds.map((x, i) => (100 * x) / b[i]);
      const hit = m !== "p99" && median(ds) >= MIN_MS && median(dp) >= MIN_PCT;
      material ||= hit;
      console.log(
        `${m} ${median(b).toFixed(4)} ${median(h).toFixed(4)} ${median(ds).toFixed(4)} ${median(dp).toFixed(1)}% ${ds.filter((x) => x > 0).length}/${args.reps}${hit ? " MATERIAL" : ""}`,
      );
    }
    for (const arm of ["baseline", "histogram"])
      console.log(`${arm} throughput txn/s: ${Math.round(median(results[arm].map((x) => x.tps)))}`);
    console.log(`paired repetitions: ${JSON.stringify(results)}`);
  }
  console.log(
    `\nVERDICT: ${material ? "MATERIAL: file follow-up; no production edits here." : "NOT material: keep current writer under local threshold."}`,
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
