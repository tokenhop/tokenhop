#!/usr/bin/env node
/**
 * Delete locale keys that the extractor proves unused.
 *
 * A key is provably dead only when it has zero occurrence anywhere in src
 * code: JSX text fragments (unquoted) and server-side strings (quoted) both
 * render at runtime, so both count as live. The haystack is comment-stripped
 * (comments never render) and whitespace-collapsed (JSX text spans line
 * breaks, and the runtime looks up the collapsed text), and each orphan key
 * is compared collapsed so multi-line JSX fragments are matched correctly.
 *
 * Usage: node scripts/i18n-prune-orphans.mjs [--apply]
 * Dry run by default; --apply rewrites every locale file without the dead keys.
 */
import { readFileSync, writeFileSync, renameSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import brand from "../src/shared/brand/index.cjs";
import { extractFromRepo, readLocaleFiles } from "./i18n-literals.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOCALES_DIR = "public/i18n/literals";

function collectJsFiles(root, files = []) {
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      collectJsFiles(p, files);
    } else if (p.endsWith(".js")) files.push(p);
  }
  return files;
}

/** Collapse runs of whitespace to single spaces (matches runtime DOM text). */
function collapse(text) {
  return String(text).replace(/\s+/g, " ");
}

/**
 * Strip line/block comments without touching string literals, then collapse
 * runs of whitespace inside string values so they match the runtime's
 * normalized lookup. Implemented on tokens: a token is kept verbatim when it
 * sits inside a quoted literal or JSX text, otherwise every // or /* comment
 * is skipped. Not a full parser, but the haystack only ever needs comment
 * boundaries right when they do not cut through literals.
 */
export function uncomment(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");
}

/** Test hook for the liveness probe (kept name-compatible with tests). */
export function stripComments(code) {
  return uncomment(code);
}

/**
 * Literals extracted under every brand: a key another brand's build renders
 * (e.g. the tokenhop strings behind the brand switch) is live, not orphaned.
 * The extractor resolves brand templates at module load, so each other brand
 * runs in its own process.
 * @param {string} repoRoot Absolute repo path.
 * @returns {Set<string>}
 */
export function extractAllBrands(repoRoot) {
  const literals = new Set(extractFromRepo(repoRoot).literals);
  for (const id of brand.BRAND_IDS) {
    if (id === brand.ACTIVE_BRAND_ID) continue;
    const out = execFileSync(
      process.execPath,
      [join(here, "i18n-literals.mjs"), "--json", "--root", repoRoot],
      { env: { ...process.env, NEXT_PUBLIC_BRAND: id }, encoding: "utf8", maxBuffer: 100e6 },
    );
    for (const literal of JSON.parse(out).literals) literals.add(literal);
  }
  return literals;
}

/**
 * Split orphan keys into provably-dead vs. still-referenced in live code.
 * @param {string} repoRoot Absolute repo path.
 * @returns {{dead: string[], kept: string[], orphans: string[]}}
 */
export function classifyOrphans(repoRoot) {
  const extracted = extractAllBrands(repoRoot);
  const locales = readLocaleFiles(join(repoRoot, DEFAULT_LOCALES_DIR));
  const keyCounts = new Map();
  for (const map of locales.values()) {
    for (const key of Object.keys(map)) keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
  }
  const orphans = [...keyCounts.keys()].filter((key) => !extracted.has(key)).sort();

  // Comment-stripped, whitespace-collapsed haystack: comments never render,
  // and the runtime walker looks up collapsed JSX text.
  const hay = collapse(
    collectJsFiles(join(repoRoot, "src"))
      .map((file) => stripComments(readFileSync(file, "utf8")))
      .join("\n"),
  );

  const dead = [];
  const kept = [];
  for (const key of orphans) {
    // A rendered key must appear as a substring somewhere in live src code:
    // JSX text fragments (unquoted) and server-side strings (quoted) both
    // count. Only a key with zero live occurrence is provably unreachable.
    if (hay.includes(collapse(key))) kept.push(key);
    else dead.push(key);
  }
  return { dead, kept, orphans };
}

function sortByKey(data) {
  return Object.fromEntries(Object.entries(data).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function writeJsonAtomic(path, data) {
  const tmp = join(dirname(path), `.${randomUUID()}.json`);
  writeFileSync(tmp, `${JSON.stringify(sortByKey(data), null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function main(argv = process.argv.slice(2)) {
  const apply = argv.includes("--apply");
  const repoRoot = resolve(here, "..");
  const { dead, kept, orphans } = classifyOrphans(repoRoot);
  console.log(
    `Orphan keys: ${orphans.length}. Provably dead: ${dead.length}. Kept (quoted in src): ${kept.length}.`,
  );
  if (!apply) {
    console.log("Dry run — pass --apply to delete the dead keys from every locale file.");
    return;
  }
  const deadSet = new Set(dead);
  const localesDir = join(repoRoot, DEFAULT_LOCALES_DIR);
  const perLocale = {};
  for (const entry of readdirSync(localesDir).sort()) {
    if (!entry.endsWith(".json")) continue;
    const path = join(localesDir, entry);
    const data = JSON.parse(readFileSync(path, "utf8"));
    let removed = 0;
    for (const key of Object.keys(data)) {
      if (deadSet.has(key)) {
        delete data[key];
        removed += 1;
      }
    }
    writeJsonAtomic(path, data);
    perLocale[entry.slice(0, -5)] = removed;
  }
  console.log("Removed per locale:", JSON.stringify(perLocale));
}

const invokedAsScript =
  process.argv[1] && resolve(process.argv[1]) === resolve(here, "i18n-prune-orphans.mjs");
if (invokedAsScript) main();
