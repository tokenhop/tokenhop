#!/usr/bin/env node
// YAN-378 gateway overhead bench. Manual, Docker, non-CI.
//   node tests/e2e/gateway-overhead-bench.mjs [--rounds 5] [--requests 120]
//     [--concurrency 4] [--max-load 20] [--reuse-master]
// Same pinned v1.0.3 seed database (one connection, one combo, one key, usage
// warm) copied to three scratch dirs, one per variant:
//   A ghcr.io/tokenhop/tokenhop:1.0.3
//   B yan378-master with TOKENHOP_MULTI_USER=off
//   C yan378-master with TOKENHOP_MULTI_USER=on  (owner+Default bootstrapped,
//     gateway keys + credentials migrated to hashed/encrypted storage)
// Each round measures four cells (sequential/concurrent x stream/non-stream).
// Inside a cell the three variants are interleaved batch by batch in an order
// that is shuffled per round, against one loopback mock upstream with a fixed
// 2ms artificial latency. Each round yields one p50/p95 per variant; the gate is
// the MEDIAN over >=5 rounds of (master-on - 1.0.3)/1.0.3, per cell and per
// percentile, and exits 1 above 5%. The 95% t-interval over rounds is printed
// for context only. Threshold is unchanged: with ~20ms requests 5% is ~1ms, so
// on a noisy host read absolute deltas and the CI before trusting a verdict.
// Budgets are in scope: master-on additionally carries exactly one active,
// non-limiting workspace TOTAL budget (limits >100x anything the run can reach)
// in the single user's Default workspace. The run asserts the budget exists,
// its spend delta equals master-on's requests (guard really engaged), it stays
// <1% of every limit and no budget_exceeded appears. Known-vs-unknown model
// pricing timing is NOT a hard gate here; the gate is the 5% median below plus
// the parity/zero-extra-upstream proofs. Aborts (exit 2) when 1-min load exceeds --max-load. Run on a quiet host: all
// three gateways and the mock share its CPUs. Streams are timed to completion.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  chat,
  check,
  client,
  docker,
  failureCount,
  harness,
  login,
  ownerLoginFrom,
  MASTER,
  markers,
  OLD,
  prepareImages,
  seed,
  waitRows,
} from "./upgrade-from-v1.0.mjs";

const THRESHOLD_PCT = 5; // Unchanged project gate.
// Two-sided 95% Student-t critical values, df 1..30 (standard table, 3 dp).
// --rounds is capped at 31 so every interval has a table entry.
const T95 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145,
  2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048,
  2.045, 2.042,
];
const KNOWN = new Set(["rounds", "requests", "concurrency", "max-load", "reuse-master", "final"]);
export function parseOptions(argv, cores = os.cpus().length) {
  const out = { rounds: 5, requests: 120, concurrency: 4, maxLoad: cores / 2 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--") || !KNOWN.has(arg.slice(2))) throw new Error(`unknown option ${arg}`);
    const name = arg.slice(2);
    if (name === "reuse-master" || name === "final") continue;
    const value = Number(argv[++i]);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${arg} needs a positive number`);
    out[name === "max-load" ? "maxLoad" : name] = value;
  }
  for (const k of ["rounds", "requests", "concurrency"])
    if (!Number.isInteger(out[k])) throw new Error(`--${k} must be an integer`);
  if (out.rounds < 5) throw new Error("--rounds must be >= 5 for a median/CI");
  if (out.rounds > 31) throw new Error("--rounds capped at 31 (t table covers df 1..30)");
  if (out.concurrency < 2) throw new Error("--concurrency must be >= 2 (sequential is always run)");
  if (out.requests % out.concurrency) throw new Error("--requests must divide by --concurrency");
  return out;
}
const opts =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
    ? parseOptions(process.argv.slice(2))
    : null;

const variants = [
  { name: "1.0.3", image: OLD, mode: "off", on: false },
  { name: "master-off", image: MASTER, mode: "off", on: false },
  { name: "master-on", image: MASTER, mode: "on", on: true },
];
const quantile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
export function interval(values) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const half = T95[n - 2] * (sd / Math.sqrt(n));
  return [mean - half, mean + half];
}
const shuffled = (list) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const fail = (message) => {
  throw new Error(message);
};

async function main() {
  const { rounds, requests, concurrency, maxLoad } = opts;
  const loadGuard = (where) => {
    const load = os.loadavg()[0];
    if (load > maxLoad) {
      console.error(
        `ABORT high load ${load.toFixed(1)} > ${maxLoad} (${where}); rerun on a quiet host`,
      );
      process.exit(2);
    }
  };
  loadGuard("start");
  await prepareImages();
  const h = await harness();
  const apps = [];
  try {
    const seedDir = path.join(h.scratch, "seed");
    const seeder = await h.start(OLD, seedDir);
    const { keys } = await seed(h, seeder, false);
    for (let i = 0; i < 40; i++) {
      const stream = i % 2 === 0;
      const r = await chat(seeder, keys[0], "yan378-combo-a", stream);
      if (!r.ok || !r.text.includes(stream ? "[DONE]" : "chatcmpl"))
        fail(`seeder chat ${i} failed: HTTP ${r.status}`);
    }
    await waitRows(h, seeder, 40);
    const key = keys[0];
    const dirs = variants.map((_v, i) => {
      const dir = path.join(h.scratch, `bench-${i}`);
      fs.mkdirSync(dir);
      // Seed files are node-owned 0600. Docker cp reads through the container
      // filesystem; host fs.cpSync cannot read those private files.
      docker("cp", `${seeder.name}:/app/data/.`, dir);
      return dir;
    });
    h.stop(seeder);
    // Distinct INITIAL_PASSWORD is irrelevant here (API key traffic only).
    for (const [i, v] of variants.entries()) {
      try {
        apps.push(await h.start(v.image, dirs[i], v.mode));
      } catch (err) {
        fail(`variant ${v.name} failed to start: ${err.message}`);
      }
    }
    // Single-owner comparison only: no second user, memberships or scoped
    // request path may change this benchmark into a multi-tenant comparison.
    // Pristine switch-off images need not bootstrap a users table/owner.
    for (const [i, v] of variants.entries()) {
      const hasUsers =
        h.dbRead(apps[i], "SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
          .length > 0;
      const active = hasUsers
        ? h.dbRead(apps[i], "SELECT COUNT(*) n FROM users WHERE status='active'")[0].n
        : 0;
      const valid = v.on ? active === 1 : active <= 1;
      check(
        `${v.name}: single-user fixture`,
        valid,
        `active=${active}; master-on requires exactly 1`,
      );
      if (!valid) fail(`${v.name}: invalid active-user count ${active}`);
    }
    // Activation must actually differ: markers + hashed key table on C only.
    for (const [i, v] of variants.entries()) {
      const m = markers(h, apps[i]).length;
      const hashed = h
        .dbRead(apps[i], "PRAGMA table_info(apiKeys)")
        .some((c) => c.name === "keyHash");
      const valid = v.on
        ? m === 2 && hashed && markers(h, apps[i]).every((r) => r.value === "1")
        : m === 0 && !hashed;
      check(
        `${v.name}: activation ${v.on ? "ON (2 markers, hashed apiKeys)" : "OFF (no markers, raw apiKeys)"}`,
        valid,
        `markers=${m} hashed=${hashed}`,
      );
      if (!valid) fail(`${v.name}: activation precondition failed`);
    }
    // Budget fixture, master-on only: one non-limiting TOTAL-window workspace
    // budget (single user's Default workspace; nothing else seeded anywhere).
    // Limits are astronomical vs ~40-keystroke synthetic traffic: proves the
    // guard evaluates on an enforced path (hasBudgets true) without any denial
    // risk, compares budget + spend only on the master-on copy, and keeps the
    // fixture single-user (creating a budget is not user creation).
    const defaultWs = (rows) => rows.find((w) => w.name === "Default")?.id;
    let ownerLogin = null;
    try {
      ownerLogin = ownerLoginFrom(
        h.dbRead(
          apps[2],
          "SELECT username,email FROM users WHERE instanceRole='owner' AND status='active'",
        ),
      );
    } catch (err) {
      fail(`master-on owner login identifier: ${err.message}`);
    }
    const onSession = await login(apps[2], false, ownerLogin);
    const wsId = defaultWs((await onSession.call("GET", "/api/workspaces")).json.workspaces);
    const gauge = { limitRequests: 10_000_000, limitUsd: 1_000_000, limitTokens: 1_000_000_000 };
    if (!wsId) fail("master-on Default workspace missing for budget fixture");
    const gaugeBody = { scopeType: "workspace", scopeId: wsId, window: "total", ...gauge };
    const gaugeCreate = await onSession.call("POST", `/api/workspaces/${wsId}/budgets`, gaugeBody);
    check(
      "master-on gauge budget seeded",
      gaugeCreate.status === 201 && gaugeCreate.json.budget.scopeType === "workspace",
      `HTTP ${gaugeCreate.status} ${gaugeCreate.text.slice(0, 120)}`,
    );
    const served = await Promise.all(
      apps.map(
        async (app) =>
          (
            await client(app.base).call("GET", "/v1/models", null, {
              authorization: `Bearer ${key}`,
            })
          ).ok,
      ),
    );
    check("all three variants serve the seeded key", served.every(Boolean));
    // Spend BEFORE timing: legacy rows may or may not be attributed to Default,
    // so the assertion below is a delta, never an absolute count.
    const spentBefore = (await onSession.call("GET", `/api/workspaces/${wsId}/budgets`)).json
      ?.budgets?.[0]?.spent;
    check("budget readable before timing", !!spentBefore, JSON.stringify(spentBefore));
    const base = apps.map((app) => h.dbRead(app, "SELECT COUNT(*) n FROM usageHistory")[0].n);
    const sent = variants.map(() => 0);
    const upstreamBefore = h.hits();

    const one = async (i, stream) => {
      const t0 = process.hrtime.bigint();
      let r;
      try {
        r = await chat(apps[i], key, "yan378-combo-a", stream);
      } catch (err) {
        fail(`variant ${variants[i].name} request error: ${err.message}`);
      }
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (!r.ok) fail(`variant ${variants[i].name} HTTP ${r.status}: ${r.text.slice(0, 120)}`);
      const content = stream
        ? r.text.includes('"content":"ok"') && r.text.includes("[DONE]")
        : JSON.parse(r.text).choices?.[0]?.message?.content === "ok";
      if (!content)
        fail(
          `variant ${variants[i].name} wrong ${stream ? "stream" : "body"}: ${r.text.slice(0, 120)}`,
        );
      sent[i]++;
      return ms;
    };
    const cell = async (order, conc, stream, n) => {
      const times = variants.map(() => []);
      for (let batch = 0; batch < n / conc; batch++)
        for (const i of order)
          times[i].push(...(await Promise.all(Array.from({ length: conc }, () => one(i, stream)))));
      return times;
    };
    console.log(
      `cpu=${os.cpus()[0]?.model ?? "?"} cores=${os.cpus().length} load=${os.loadavg().map((n) => n.toFixed(1))} rounds=${rounds} requests/cell/variant=${requests} concurrency=${concurrency}`,
    );
    for (const stream of [false, true]) {
      // Concurrent warmup (unmeasured), sized to whole batches.
      const n = concurrency * 8;
      const w = await cell(shuffled([0, 1, 2]), concurrency, stream, n);
      check(
        `concurrent ${stream ? "stream" : "non-stream"} warmup succeeded on all variants`,
        w.every((t) => t.length === n),
        w.map((t) => t.length).join(","),
      );
    }

    const cells = [];
    for (const conc of [1, concurrency])
      for (const stream of [false, true]) cells.push({ conc, stream, rounds: [] });
    for (let round = 0; round < rounds; round++) {
      loadGuard(`round ${round + 1}`);
      for (const c of shuffled(cells)) {
        const order = shuffled([0, 1, 2]);
        const times = await cell(order, c.conc, c.stream, requests);
        c.rounds.push({
          order,
          stats: times.map((t) => {
            const s = [...t].sort((a, b) => a - b);
            return { p50: quantile(s, 0.5), p95: quantile(s, 0.95) };
          }),
        });
      }
      console.log(`round ${round + 1}/${rounds} done load=${os.loadavg()[0].toFixed(1)}`);
    }
    const totalSent = sent.reduce((a, b) => a + b, 0);
    check(
      "upstream hit delta equals requests sent",
      h.hits() - upstreamBefore === totalSent,
      `hits=${h.hits() - upstreamBefore} sent=${totalSent}`,
    );
    for (const [i, v] of variants.entries()) {
      await waitRows(h, apps[i], base[i] + sent[i]).then(
        () => check(`${v.name}: usage rows delta equals requests`, true, `+${sent[i]}`),
        (err) => check(`${v.name}: usage rows delta equals requests`, false, err.message),
      );
    }
    // Budget gauge: still exactly one, spend equals what master-on sent, and it
    // is far below every limit (no denial possible, so no timing path skipped).
    const after = await onSession.call("GET", `/api/workspaces/${wsId}/budgets`);
    const rowsOut = after.json?.budgets ?? [];
    const gaugeRow = rowsOut[0];
    check(
      "budget row survived intact",
      !!gaugeRow &&
        gaugeRow.window === "total" &&
        gaugeRow.limitRequests === gauge.limitRequests &&
        gaugeRow.limitUsd === gauge.limitUsd &&
        gaugeRow.limitTokens === gauge.limitTokens,
      JSON.stringify(gaugeRow),
    );
    check("master-on has exactly one budget", rowsOut.length === 1, `n=${rowsOut.length}`);
    const used = gaugeRow?.spent;
    check(
      "budget spend delta equals master-on requests (counter engaged)",
      !!used &&
        !!spentBefore &&
        used.requests - spentBefore.requests === sent[2] &&
        used.tokens - spentBefore.tokens === sent[2] * 10,
      `before=${JSON.stringify(spentBefore)} after=${JSON.stringify(used)} sent=${sent[2]}`,
    );
    check(
      "budget far below limits (<1%)",
      !!used &&
        used.requests < gauge.limitRequests / 100 &&
        used.usd < gauge.limitUsd / 100 &&
        used.tokens < gauge.limitTokens / 100,
    );
    for (const [i, v] of variants.entries()) {
      if (v.on) continue;
      const hasBudgets = h.dbRead(
        apps[i],
        "SELECT name FROM sqlite_master WHERE type='table' AND name='budgets'",
      ).length;
      check(
        `${v.name}: no budgets seeded on non-master-on variants`,
        !hasBudgets || h.dbRead(apps[i], "SELECT COUNT(*) n FROM budgets")[0].n === 0,
      );
    }
    const denied = JSON.stringify(after.json).includes("budget_exceeded");
    check("no budget denial observed", !denied);

    // Fixture must not have drifted: still exactly the same single-user shape,
    // and every cell has the full round count (stream/non-stream never pooled).
    for (const [i, v] of variants.entries()) {
      const hasUsers =
        h.dbRead(apps[i], "SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
          .length > 0;
      const active = hasUsers
        ? h.dbRead(apps[i], "SELECT COUNT(*) n FROM users WHERE status='active'")[0].n
        : 0;
      check(
        `${v.name}: still single-user after run`,
        v.on ? active === 1 : active <= 1,
        `active=${active}`,
      );
    }
    check(
      "four separate cells, each with all rounds",
      cells.length === 4 &&
        new Set(cells.map((c) => `${c.conc}/${c.stream}`)).size === 4 &&
        cells.every((c) => c.rounds.length === rounds),
      cells
        .map((c) => `${c.conc}/${c.stream ? "stream" : "non-stream"}:${c.rounds.length}`)
        .join(" "),
    );

    for (const c of cells) {
      const label = `${c.conc === 1 ? "sequential" : `concurrency=${concurrency}`} ${c.stream ? "stream" : "non-stream"}`;
      console.log(`-- ${label} n=${requests * rounds}/variant`);
      for (const [i, v] of variants.entries()) {
        const p50 = median(c.rounds.map((r) => r.stats[i].p50));
        const p95 = median(c.rounds.map((r) => r.stats[i].p95));
        console.log(
          `${v.name.padEnd(11)} median-of-rounds p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`,
        );
      }
      for (const [vi, who] of [
        [1, "master-off"],
        [2, "master-on "],
      ]) {
        const line = [];
        for (const p of ["p50", "p95"]) {
          const per = c.rounds.map((r) => ((r.stats[vi][p] - r.stats[0][p]) / r.stats[0][p]) * 100);
          const abs = median(c.rounds.map((r) => r.stats[vi][p] - r.stats[0][p]));
          const [lo, hi] = interval(per);
          line.push(
            `${p} median ${median(per).toFixed(2)}% (${abs.toFixed(2)}ms) CI95[${lo.toFixed(1)},${hi.toFixed(1)}]`,
          );
          if (vi === 2)
            check(
              `${label} master-on overhead <= ${THRESHOLD_PCT}% at ${p} (median of ${rounds} rounds)`,
              median(per) <= THRESHOLD_PCT,
              `${median(per).toFixed(2)}%`,
            );
        }
        console.log(`${who} vs 1.0.3: ${line.join("  ")}`);
      }
    }
    const failed = failureCount();
    console.log(failed ? `${failed} FAILED` : "ALL PASSED");
    if (failed) process.exitCode = 1;
  } finally {
    for (const app of apps) {
      try {
        h.stop(app);
      } catch {}
    }
    h.cleanup();
  }
}
if (opts) {
  try {
    await main();
  } catch (err) {
    console.error(`FAIL ${err.message}`);
    process.exitCode = 1;
  }
}
