#!/usr/bin/env node
/**
 * Delete locale keys that the extractor proves unused.
 *
 * A key is provably unused only when it is not extracted from src AND does not
 * appear as a complete quoted string in any src file. Keys that still appear
 * as full quoted strings may still be rendered (server API messages, array
 * prop strings the extractor cannot see) so they are kept.
 *
 * Usage: node scripts/i18n-prune-orphans.mjs [--apply]
 * Dry run by default; --apply rewrites every locale file without the dead keys.
 */
import { readFileSync, writeFileSync, renameSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
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

/**
 * Split orphan keys into provably-dead vs. still-referenced (quoted in src).
 * @param {string} repoRoot Absolute repo path.
 * @returns {{dead: string[], kept: string[], orphans: string[]}}
 */
export function classifyOrphans(repoRoot) {
  const { literals } = extractFromRepo(repoRoot);
  const extracted = new Set(literals);
  const locales = readLocaleFiles(join(repoRoot, DEFAULT_LOCALES_DIR));
  const keyCounts = new Map();
  for (const map of locales.values()) {
    for (const key of Object.keys(map)) keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
  }
  const orphans = [...keyCounts.keys()].filter((key) => !extracted.has(key)).sort();

  const hay = collectJsFiles(join(repoRoot, "src"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

  const dead = [];
  const kept = [];
  for (const key of orphans) {
    // Keys containing delimiters/backslashes cannot be matched reliably as a
    // complete quoted string — keep them rather than guess.
    if (/["'`\\]/.test(key)) {
      kept.push(key);
      continue;
    }
    const quoted = [`"${key}"`, `'${key}'`, `\`${key}\``];
    if (quoted.some((form) => hay.includes(form))) kept.push(key);
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
