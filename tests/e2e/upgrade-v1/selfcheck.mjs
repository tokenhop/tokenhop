// Static self-check for the YAN-378 harness: pure functions and export shape,
// no Docker. Run: node tests/e2e/upgrade-v1/selfcheck.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import * as core from "./core.mjs";
import * as evidence from "./evidence.mjs";
import { failedClosed, isTransientStartupError, sanitizeLogs, waitForHealth } from "./harness.mjs";
import { ownerLoginFrom, passwordLoginBody } from "./client.mjs";
import { parseOptions, interval } from "../gateway-overhead-bench.mjs";

// --- bench option parsing: input validation at the trust boundary
assert.deepEqual(parseOptions(["--rounds", "6"], 8), {
  rounds: 6,
  requests: 120,
  concurrency: 4,
  maxLoad: 4,
});
assert.deepEqual(parseOptions(["--requests", "40", "--concurrency", "8", "--max-load", "3"], 8), {
  rounds: 5,
  requests: 40,
  concurrency: 8,
  maxLoad: 3,
});
for (const bad of [
  ["--bogus"],
  ["--rounds"],
  ["--rounds", "0"],
  ["--rounds", "-3"],
  ["--requests", "abc"],
  ["--rounds", "4"],
  ["--rounds", "32"],
  ["--concurrency", "1"],
  ["--requests", "100", "--concurrency", "7"],
]) {
  assert.throws(
    () => parseOptions(bad),
    undefined,
    `parseOptions(${JSON.stringify(bad)}) should throw`,
  );
}
// every allowed round count has a critical value (df = rounds - 1)
for (let n = 5; n <= 31; n++)
  assert(Number.isFinite(interval(Array.from({ length: n }, (_, i) => i))[0]), `interval n=${n}`);
// t-interval widens with spread and is centered on the mean.
const [lo, hi] = interval([10, 10, 10, 10, 10]);
assert.equal(lo, 10);
assert.equal(hi, 10);
const wide = interval([0, 20, 0, 20, 0]);
assert(wide[0] < 0 && wide[1] > 20, JSON.stringify(wide));

// --- constants and export surface the bench relies on
const { OLD, MASTER, PASSWORD, secrets, prepareImages, fingerprint, failureCount } = core;
assert.equal(OLD, "ghcr.io/tokenhop/tokenhop:1.0.3");
assert.equal(MASTER, "yan378-master");
for (const fn of [prepareImages, fingerprint, failureCount]) assert.equal(typeof fn, "function");
const { markers, waitRows, storageEvidence, backupInfo, privateRoot, seedTotals } = evidence;
for (const fn of [markers, waitRows, storageEvidence, backupInfo, privateRoot, seedTotals])
  assert.equal(typeof fn, "function");

// Check actual lexical scope, not export* or text matching. Installed Biome's
// AST-backed rule inspects dormant main/restart/compat/rollback paths too.
{
  const cli = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");
  const entryPath = new URL("../upgrade-from-v1.0.mjs", import.meta.url).pathname;
  const benchPath = new URL("../gateway-overhead-bench.mjs", import.meta.url).pathname;
  const root = core.ROOT;
  const args = ["lint", "--only=correctness/noUndeclaredVariables"];
  const lint = spawnSync(
    process.execPath,
    [cli, ...args, entryPath, benchPath, new URL(".", import.meta.url).pathname],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  assert.equal(lint.status, 0, `undeclared runtime identifiers: ${lint.stdout}${lint.stderr}`);
  // Regression control: removing only the LOCAL binding leaves export* intact.
  // The same lint pass must fail: exporting a helper cannot bind it in main().
  const entry = fs.readFileSync(entryPath, "utf8");
  const missingBinding = entry.replace(/(import\s*\{[^}]*?)\bownerLoginFrom\s*,/, "$1");
  assert.notEqual(missingBinding, entry, "ownerLoginFrom must be locally imported");
  const brokenPath = new URL(`../.selfcheck-broken-${process.pid}.mjs`, import.meta.url).pathname;
  fs.writeFileSync(brokenPath, missingBinding);
  let broken;
  try {
    broken = spawnSync(process.execPath, [cli, ...args, brokenPath], {
      cwd: root,
      encoding: "utf8",
    });
  } finally {
    fs.rmSync(brokenPath, { force: true });
  }
  assert.notEqual(broken.status, 0, "missing local import must fail AST check");
  assert.match(
    `${broken.stdout}${broken.stderr}`,
    /ownerLoginFrom.*undeclared|undeclared[\s\S]*ownerLoginFrom/,
  );
}
// Sentinels are synthetic-only and never shell-interpreted.
for (const s of [...secrets, PASSWORD])
  assert(!/["'`\\$;]/.test(s), `sentinel must be shell-safe: ${s}`);

// --- LISTEN_PROBE ownership parse: prove the probe reports owned=true for a
// same-user socket walk, loopback-only, and the exact pid-1 ownership contract.
{
  const { LISTEN_PROBE } = await import("./harness.mjs");
  const probe = (port, tcp, fds) => {
    const fs = {
      readFileSync: (f) => (f === "/proc/net/tcp" ? tcp : f === "/proc/net/tcp6" ? "" : ""),
      readdirSync: (d) => {
        if (d === "/proc") return Object.keys(fds);
        const m = d.match(/^\/proc\/(\d+)\/fd$/);
        return m ? Object.keys(fds[m[1]] ?? {}) : [];
      },
      readlinkSync: (l) => {
        const m = l.match(/^\/proc\/(\d+)\/fd\/(\d+)$/);
        if (!m || !(m[1] in fds) || !(m[2] in fds[m[1]]))
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        return fds[m[1]][m[2]];
      },
    };
    const proc = { argv: ["node", String(port)] };
    let out = "";
    const console2 = {
      log: (t) => {
        out = t;
      },
    };
    new Function(
      "process",
      "console",
      `const fs=arguments[2];${LISTEN_PROBE.replace(/^const fs=require\('fs'\);/, "")}`,
    )(proc, console2, fs);
    return JSON.parse(out);
  };
  const row =
    "  22: 0100007F:8C6D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 119166652 1 0000000000000000 100 0 0 10 0\n";
  const mine = probe(35949, `sl local_address rem\n${row}`, { 1: { 4: "socket:[119166652]" } });
  assert.deepEqual(mine, { owned: true, owner: "1", local: "0100007F:8C6D", loopback: true });
  const foreign = probe(35949, `sl local_address rem\n${row}`, { 63: { 0: "socket:[119166652]" } });
  assert.equal(foreign.owned, true);
  assert.notEqual(foreign.owner, "1");
  const blind = probe(35949, `sl local_address rem\n${row}`, { 1: {} });
  assert.equal(blind.owned, false); // unreadable fds (root exec vs uid-1000 server) must never read as owned
  const wide = probe(
    35949,
    `sl local_address rem\n  22: 00000000:8C6D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 7 1 0000000000000000 100 0 0 10 0\n`,
    { 1: { 4: "socket:[7]" } },
  );
  assert.equal(wide.loopback, false);
}
// --- startExpectFail semantics: failClosed requires terminated + nonzero exit
// + no listener + no statuses; a Running/500 case must NOT pass. Deterministic
// contract table, no Docker: accepted = predicate returns true on the result shape.
const passed = failedClosed;
{
  const good = {
    exited: true,
    exitCode: 1,
    listening: false,
    loginStatus: null,
    healthStatus: null,
  };
  const bads = [
    // Running, nonzero, no listener: still alive, must fail.
    { exited: false, exitCode: 0, listening: false, loginStatus: null, healthStatus: null },
    { exited: true, exitCode: 0, listening: false, loginStatus: null, healthStatus: null },
    { exited: true, exitCode: 1, listening: true, loginStatus: null, healthStatus: null },
    { exited: true, exitCode: 1, listening: false, loginStatus: 500, healthStatus: 500 },
    { exited: true, exitCode: 1, listening: false, loginStatus: 200, healthStatus: null },
  ];
  assert(passed(good));
  for (const [i, b] of bads.entries()) assert(!passed(b), `bad case ${i} must not pass`);
}
// --- login identifier: omitted vs explicit owner login (second-user ambiguity)
assert.equal(ownerLoginFrom([{ username: "ownerX", email: "x@y" }]), "ownerX");
assert.equal(ownerLoginFrom([{ username: null, email: "x@y" }]), "x@y");
assert.throws(() => ownerLoginFrom([]));
assert.throws(() => ownerLoginFrom([{ username: "a" }, { username: "b" }]));
assert.throws(() => ownerLoginFrom([{ username: null, email: null }]));
assert.deepEqual(passwordLoginBody(), { password: core.PASSWORD });
assert.deepEqual(passwordLoginBody("owner"), { password: core.PASSWORD, login: "owner" });
// --- table shell filter: indexes/triggers/requestDetails never enter the
// backup comparison; shells keep name+tbl_name+sql only
{
  const rows = [
    { type: "index", name: "idx_a", tbl_name: "t", sql: "CREATE INDEX idx_a ON t(x)" },
    { type: "table", name: "t", tbl_name: "t", sql: "CREATE TABLE t(x)" },
    { type: "trigger", name: "tr", tbl_name: "t", sql: "CREATE TRIGGER" },
  ];
  assert.deepEqual(evidence.tableShells(rows), [
    { name: "t", tbl_name: "t", sql: "CREATE TABLE t(x)" },
  ]);
}
// --- health polling: fake fetch + fake clock, no sockets, no sleeping
const timeoutErr = () =>
  Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
const refused = () =>
  Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
const clock = () => {
  let t = 0;
  return {
    now: () => t,
    sleepFn: async (ms) => {
      t += ms;
    },
  };
};
{
  // fails twice (timeout, refused) then ok: must retry and succeed
  let calls = 0;
  const c = clock();
  const r = await waitForHealth("http://x", {
    ...c,
    fetchFn: async () => {
      calls++;
      if (calls === 1) throw timeoutErr();
      if (calls === 2) throw refused();
      return { ok: true, status: 200 };
    },
  });
  assert.equal(calls, 3);
  assert.equal(r.attempts, 3);
}
{
  // non-200 while booting is retried too
  let calls = 0;
  const r = await waitForHealth("http://x", {
    ...clock(),
    fetchFn: async () => (++calls < 3 ? { ok: false, status: 503 } : { ok: true, status: 200 }),
  });
  assert.equal(r.attempts, 3);
}
{
  // permanent transient failure: bounded by the deadline, reports last error
  const c = clock();
  let calls = 0;
  await assert.rejects(
    waitForHealth("http://x", {
      ...c,
      deadlineMs: 5000,
      intervalMs: 500,
      fetchFn: async () => {
        calls++;
        throw timeoutErr();
      },
    }),
    (err) => /health timeout after 5000ms, 10 attempts \(last: TimeoutError/.test(err.message),
  );
  assert.equal(calls, 10);
  assert(c.now() <= 5500, "must not run past the deadline");
}
{
  // non-transient errors surface at once, never retried
  let calls = 0;
  await assert.rejects(
    waitForHealth("http://x", {
      ...clock(),
      fetchFn: async () => {
        calls++;
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
      },
    }),
    /non-transient/,
  );
  assert.equal(calls, 1);
  // a tick that throws (container died) ends the wait immediately
  await assert.rejects(
    waitForHealth("http://x", {
      ...clock(),
      fetchFn: async () => {
        throw refused();
      },
      tick: async () => {
        throw new Error("container exited");
      },
    }),
    /container exited/,
  );
}
assert(isTransientStartupError(Object.assign(new Error("a"), { name: "AbortError" })));
assert(!isTransientStartupError(new RangeError("bug")));
assert(!isTransientStartupError(new TypeError("fetch failed"))); // codeless: not presumed transient
// --- scanResponse: PASSWORD included, 8 MiB bound
{
  const { PASSWORD: pw, secrets: sc } = core;
  const { scanResponse: scan } = await import("./client.mjs");
  scan("plain ok", new Headers({ "x-hint": "nothing" }));
  assert.throws(() => scan(`leak ${pw}`, new Headers()), /SENSITIVE/);
  assert.throws(() => scan("ok body", new Headers({ "x-s": sc[0] })), /SENSITIVE/);
  assert.throws(() => scan("x".repeat(9 * 1024 * 1024), new Headers()), /8 MiB/);
}
// --- firstDataFrame: chunk-split SSE, timeout, scan
{
  const { firstDataFrame } = await import("./client.mjs");
  const sse = (chunks) => ({
    headers: new Headers(),
    body: new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
      },
    }),
  });
  const ac = new AbortController();
  const f = await firstDataFrame(sse(['data: {"a":', "1}\n", "\ndata: done\n\n"]), ac);
  assert.equal(f, '{"a":1}');
  const slow = new Promise((resolve) => setTimeout(resolve, 8000));
  const ac2 = new AbortController();
  await Promise.race([
    assert.rejects(firstDataFrame(sse(["data: no-frame-yet"]), ac2, 300), /first data timeout/),
    slow.then(() => {
      throw new Error("timeout test itself stalled");
    }),
  ]);
}
// --- log sanitizing
{
  const leaked = `sk-abc12345678 Bearer abcdefgh12345 password=hunter22 ${secrets[0]} eyJhbGciOiJIUzI1.eyJzdWIiOiIx.c2lnbmF0dXJl_x`;
  const clean = sanitizeLogs(leaked, [secrets[1]]);
  for (const bad of ["sk-abc12345678", "abcdefgh12345", "hunter22", secrets[0], "eyJhbGci"])
    assert(!clean.includes(bad), `leaked ${bad}`);
  assert(sanitizeLogs("plain startup line ready").includes("plain startup line ready"));
}
console.log("PASS selfcheck (options, interval, exports, sentinels, health retry, log sanitizing)");
