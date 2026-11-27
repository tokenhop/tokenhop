// YAN-1993 (follow-up to YAN-1981 / #1142): adapter contract for parameter
// binding. The adapters take an array of binds and spread it into the
// statement. better-sqlite3 (CI's driver on the .nvmrc Node) rejects numbered
// `?N` placeholders bound that way, even with the exact count; node:sqlite
// (the driver from Node 24) accepts them. A `?N` query therefore passes a
// local run on Node 24+ and fails in CI. Use positional `?` only.
//
// better-sqlite3 runs in a child process: on some Node majors the native addon
// crashes the process on load (see src/lib/db/driver.js), which would take the
// test worker down with it.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createNodeSqliteAdapter } from "@/lib/db/adapters/nodeSqliteAdapter.js";
import { parseNvmrcMajor } from "../setup/nodeVersionGate.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const adapterUrl = pathToFileURL(`${repoRoot}src/lib/db/adapters/betterSqliteAdapter.js`).href;
const nvmrcMajor = parseNvmrcMajor(readFileSync(`${repoRoot}.nvmrc`, "utf8"));
const onNvmrcNode = Number(process.versions.node.split(".")[0]) === nvmrcMajor;

const SETUP = "CREATE TABLE t(a, b); INSERT INTO t VALUES (1, 2), (3, 4)";

// Each case runs adapter.all(sql, params) and reports rows or the error message.
const CASES = {
  positional: ["SELECT a, b FROM t WHERE a = ? AND b = ?", [1, 2]],
  positionalRepeated: [
    "SELECT a, b FROM t WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)",
    [1, 2, 3, 4],
  ],
  positionalTooMany: ["SELECT a, b FROM t WHERE a = ?", [1, 2]],
  numbered: ["SELECT a, b FROM t WHERE a = ?1 AND b = ?2", [1, 2]],
  numberedReused: ["SELECT a, b FROM t WHERE a = ?1 OR b = ?1", [1]],
  numberedReusedPadded: [
    "SELECT a, b FROM t WHERE (a = ?1 AND b = ?2) OR (a = ?1 AND b = ?2)",
    [1, 2, 1, 2],
  ],
};

function runCases(adapter) {
  adapter.exec(SETUP);
  const out = {};
  for (const [name, [sql, params]] of Object.entries(CASES)) {
    try {
      out[name] = { rows: adapter.all(sql, params).map((r) => ({ ...r })) };
    } catch (e) {
      out[name] = { error: e.message };
    }
  }
  return out;
}

const childScript = `
let createBetterSqliteAdapter;
try {
  ({ createBetterSqliteAdapter } = await import(${JSON.stringify(adapterUrl)}));
} catch (e) {
  process.stdout.write(JSON.stringify({ unavailable: e.message }));
  process.exit(0);
}
const CASES = ${JSON.stringify(CASES)};
const SETUP = ${JSON.stringify(SETUP)};
${runCases.toString()}
const db = createBetterSqliteAdapter(":memory:");
const driver = db.driver;
const results = runCases(db);
db.close();
process.stdout.write(JSON.stringify({ driver, results }));
process.exit(0);
`;

const TOO_MANY = /Too many parameter values were provided/;

describe("better-sqlite3 adapter: parameter binding contract", () => {
  let child;
  beforeAll(() => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
    let parsed = null;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {}
    child = { status: r.status, signal: r.signal, stderr: r.stderr, parsed };
  });

  // Off the .nvmrc Node the driver may be missing or crash on load: skip there.
  // On the .nvmrc Node (CI) it must load, or this contract is not checked at all.
  const results = (ctx) => {
    const ok = child.status === 0 && child.parsed && !child.parsed.unavailable;
    if (!ok && !onNvmrcNode) ctx.skip();
    expect(child.signal, child.stderr).toBeNull();
    expect(
      child.parsed?.unavailable,
      "better-sqlite3 must load on the .nvmrc Node",
    ).toBeUndefined();
    expect(child.parsed?.driver).toBe("better-sqlite3");
    return child.parsed.results;
  };

  it("binds positional `?` from an array", (ctx) => {
    const r = results(ctx);
    expect(r.positional).toEqual({ rows: [{ a: 1, b: 2 }] });
    expect(r.positionalRepeated.rows).toHaveLength(2);
  });

  it("rejects more array binds than positional `?`", (ctx) => {
    expect(results(ctx).positionalTooMany.error).toMatch(TOO_MANY);
  });

  it("rejects numbered `?N` with array binds, even with the exact count", (ctx) => {
    const r = results(ctx);
    expect(r.numbered.error).toMatch(TOO_MANY);
    expect(r.numberedReused.error).toMatch(TOO_MANY);
    expect(r.numberedReusedPadded.error).toMatch(TOO_MANY);
  });
});

// The contrast that hid the YAN-1981 bug locally: node:sqlite accepts `?N`.
describe("node:sqlite adapter: numbered `?N` with array binds", () => {
  it("accepts them, unlike better-sqlite3", async () => {
    const db = await createNodeSqliteAdapter(":memory:");
    try {
      const r = runCases(db);
      expect(r.positional).toEqual({ rows: [{ a: 1, b: 2 }] });
      expect(r.numbered).toEqual({ rows: [{ a: 1, b: 2 }] });
      expect(r.numberedReused).toEqual({ rows: [{ a: 1, b: 2 }] });
    } finally {
      db.close();
    }
  });
});
