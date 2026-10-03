// YAN-354: tenancy classification guard. Every table and kv scope must be
// classified in src/lib/db/tenancy.js, and repo functions that touch a
// `scoped` table or kv scope must take `ctx` first or be named `*Unscoped`.
// ponytail: the repo lint is a static regex scan of src/lib/db/repos/*.js
// (function declarations, literal or const-bound table/scope names). SQL on
// scoped data belongs in repos; widen the scan if it ever lives elsewhere.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { KV_SCOPE_CLASSES, TABLE_CLASSES, findUnclassified } from "@/lib/db/tenancy.js";

const ROOT = path.resolve(__dirname, "../..");
const REPOS = path.join(ROOT, "src/lib/db/repos");

// Sync in-transaction helpers that take `db`. Their only callers
// (addMembership, updateMembershipRole, removeMembership, deleteUserUnscoped)
// check workspace membership first.
const HELPER_ALLOWLIST = new Set([
  "membershipsRepo.js:membershipRole",
  "membershipsRepo.js:assertNotLastManager",
]);

const liveTables = (db) =>
  db
    .all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .map((r) => r.name);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(m?js|jsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const KV_SCOPE_PATTERNS = [
  /makeKv\(\s*["'`](\w+)["'`]\s*\)/g,
  /\b(?:WHERE|AND|OR)\s+scope\s*=\s*["'`](\w+)["'`]/gi,
  /kv\s*\(\s*scope[^)]*\)\s*VALUES\s*\(\s*'(\w+)'/g,
  /\bSCOPE\s*=\s*["'`](\w+)["'`]/g,
];

function kvScopesIn(src) {
  const out = new Set();
  for (const re of KV_SCOPE_PATTERNS) for (const m of src.matchAll(re)) out.add(m[1]);
  return out;
}

/**
 * Per top-level function in a repo file: its first parameter and the tables
 * and kv scopes its own body touches.
 */
function analyzeRepo(file, src) {
  const decl = /^(export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/gm;
  const heads = [...src.matchAll(decl)];
  const consts = Object.fromEntries(
    [...src.matchAll(/^const\s+(\w+)\s*=\s*["'`](\w+)["'`]/gm)].map((m) => [m[1], m[2]]),
  );
  const kvBindings = Object.fromEntries(
    [...src.matchAll(/^const\s+(\w+)\s*=\s*makeKv\(\s*(?:["'`](\w+)["'`]|(\w+))\s*\)/gm)].map(
      (m) => [m[1], m[2] ?? consts[m[3]]],
    ),
  );
  return heads.map((m, i) => {
    const body = src.slice(m.index, heads[i + 1]?.index ?? src.length);
    const tables = new Set(
      [...body.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+(\w+)/g)].map((t) => t[1]),
    );
    const scopes = kvScopesIn(body);
    for (const [name, scope] of Object.entries(kvBindings)) {
      if (new RegExp(`\\b${name}\\.`).test(body)) {
        tables.add("kv");
        scopes.add(scope);
      }
    }
    if (tables.has("kv")) {
      for (const [name, value] of Object.entries(consts)) {
        if (Object.hasOwn(KV_SCOPE_CLASSES, value) && new RegExp(`\\b${name}\\b`).test(body))
          scopes.add(value);
      }
    }
    const firstParam = m[3].split(",")[0].trim().split(/\s|=/)[0];
    return { file, name: m[2], exported: Boolean(m[1]), firstParam, body, tables, scopes };
  });
}

/**
 * Analyze `[file, src]` pairs, folding in what callees touch: any function in
 * the same file, or an exported one from another repo, until nothing changes.
 */
function analyzeRepos(sources) {
  const fns = sources.flatMap(([file, src]) => analyzeRepo(file, src));
  const merge = (into, from) => {
    const before = into.size;
    for (const x of from) into.add(x);
    return into.size !== before;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of fns) {
      for (const g of fns) {
        if (g === f || (g.file !== f.file && !g.exported)) continue;
        if (!new RegExp(`\\b${g.name}\\(`).test(f.body)) continue;
        if (merge(f.tables, g.tables)) changed = true;
        if (merge(f.scopes, g.scopes)) changed = true;
      }
    }
  }
  return fns;
}

const isScoped = (cls) => cls?.class === "scoped";

/** Exported functions that touch a scoped table/kv scope without `ctx`. */
function unscopedViolations(sources) {
  return analyzeRepos(sources)
    .filter((f) => f.exported && f.firstParam !== "ctx" && !f.name.endsWith("Unscoped"))
    .filter((f) => !HELPER_ALLOWLIST.has(`${f.file}:${f.name}`))
    .filter(
      (f) =>
        [...f.tables].some((t) => t !== "kv" && isScoped(TABLE_CLASSES[t])) ||
        [...f.scopes].some((s) => isScoped(KV_SCOPE_CLASSES[s])),
    )
    .map((f) => `${f.file}:${f.name}`);
}

describe("tenancy classification", () => {
  it("classifies every table of the migrated schema", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { TABLES } = await import("@/lib/db/schema.js");
    const tables = [...new Set([...liveTables(await getAdapter()), ...Object.keys(TABLES)])];
    expect(tables.length).toBeGreaterThanOrEqual(15);
    expect(findUnclassified({ tables }).tables).toEqual([]);
  });

  it("classifies every kv scope used in the code", () => {
    const scopes = new Set();
    for (const dir of ["src", "open-sse"]) {
      for (const f of walk(path.join(ROOT, dir)))
        for (const s of kvScopesIn(fs.readFileSync(f, "utf8"))) scopes.add(s);
    }
    // A floor so a broken scan can't pass by finding nothing.
    expect(scopes.size).toBeGreaterThanOrEqual(8);
    expect(findUnclassified({ kvScopes: [...scopes] }).kvScopes).toEqual([]);
  });

  it("fails on an unclassified table or kv scope", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
    const { runVersionedMigrations } = await import("@/lib/db/migrate.js");
    const db = await createSqlJsAdapter(path.join(process.env.TOKENHOP_TEST_ROOT, "rogue.sqlite"));
    runVersionedMigrations(db);
    db.exec(`CREATE TABLE rogue (id TEXT PRIMARY KEY, secret TEXT)`);
    const kvScopes = [...kvScopesIn(`const k = makeKv("rogueScope");`)];
    expect(findUnclassified({ tables: liveTables(db), kvScopes })).toEqual({
      tables: ["rogue"],
      kvScopes: ["rogueScope"],
    });
    db.close();
    log.mockRestore();
  });

  it("every class is known and every scoped entry names its scope column", () => {
    const classes = ["scoped", "instance", "system", "usage-attribution", "pending-scope"];
    for (const c of [...Object.values(TABLE_CLASSES), ...Object.values(KV_SCOPE_CLASSES)]) {
      expect(classes).toContain(c.class);
    }
    for (const c of Object.values(TABLE_CLASSES))
      if (c.class === "scoped") expect(c.scopeColumn).toBeTruthy();
  });
});

describe("repo lint", () => {
  it("repo functions on scoped data take ctx or are named *Unscoped", () => {
    const files = fs.readdirSync(REPOS).filter((f) => f.endsWith(".js"));
    expect(files.length).toBeGreaterThan(10);
    // The lint only sees `function` declarations; arrow exports would slip past it.
    const arrows = files.filter((f) =>
      /^export\s+const\s+\w+\s*=\s*(async\s+)?(\([^)]*\)|\w+)\s*=>/m.test(
        fs.readFileSync(path.join(REPOS, f), "utf8"),
      ),
    );
    expect(arrows).toEqual([]);
    const sources = files.map((f) => [f, fs.readFileSync(path.join(REPOS, f), "utf8")]);
    expect(unscopedViolations(sources)).toEqual([]);
  });

  it("flags an unscoped reader, directly or through a same-file or imported helper", () => {
    const src = `
const k = makeKv("modelAliases");
function rows(db) { return db.all(\`SELECT * FROM memberships\`); }
export async function listAll() { return rows(await getAdapter()); }
export async function listMine(ctx) { return rows(await getAdapter()); }
export async function listAllUnscoped() { return rows(await getAdapter()); }
export async function getProxy() { return db.get(\`SELECT * FROM proxyPools\`); }
`;
    const other = `
import { membershipRole } from "./membershipsRepo.js";
export async function roleOf(id) { return membershipRole(await getAdapter(), id, id); }
`;
    const memberships = fs.readFileSync(path.join(REPOS, "membershipsRepo.js"), "utf8");
    expect(
      unscopedViolations([
        ["fixture.js", src],
        ["other.js", other],
        ["membershipsRepo.js", memberships],
      ]),
    ).toEqual(["fixture.js:listAll", "other.js:roleOf"]);
  });
});
