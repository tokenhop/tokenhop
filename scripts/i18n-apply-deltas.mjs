#!/usr/bin/env node
/**
 * Merge per-locale translation deltas (written by translate-literals.mjs
 * --delta) into the locale files of the current checkout.
 *
 * CI translates against the commit that triggered the run but opens the PR on
 * the newest master, so only the *added* keys travel between jobs. A key that
 * already exists in the checkout wins: master may have gained a newer or
 * hand-edited translation in the meantime.
 *
 * Usage:
 *   node scripts/i18n-apply-deltas.mjs --locales public/i18n/literals --deltas <dir>
 *
 * <dir> holds one <locale>.json per translated locale; other files are ignored.
 * Prints one JSON summary line: {"<locale>": <keys added>, ...}.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { sortByKey, writeJsonAtomic } from "./lib/i18n-json.mjs";

/**
 * Add delta entries whose key is absent from the locale map.
 * @param {Record<string, string>} map Current locale file contents.
 * @param {Record<string, string>} delta Newly translated entries.
 * @returns {{ merged: Record<string, string>, added: number }} Key-sorted result.
 */
export function mergeDelta(map, delta) {
  const merged = { ...map };
  let added = 0;
  for (const [key, value] of Object.entries(delta)) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`delta value for ${JSON.stringify(key)} is not a non-empty string`);
    }
    if (key in merged) continue;
    merged[key] = value;
    added += 1;
  }
  return { merged: sortByKey(merged), added };
}

function main() {
  const { values: options } = parseArgs({
    options: { locales: { type: "string" }, deltas: { type: "string" } },
  });
  if (!options.locales || !options.deltas) {
    console.error("Usage: node scripts/i18n-apply-deltas.mjs --locales <dir> --deltas <dir>");
    process.exit(1);
  }
  const summary = {};
  for (const entry of readdirSync(options.deltas).sort()) {
    if (!entry.endsWith(".json")) continue;
    const locale = entry.slice(0, -".json".length);
    // A delta for a locale with no file means the matrix and checkout disagree:
    // fail instead of silently creating a new locale.
    const target = join(options.locales, entry);
    const map = JSON.parse(readFileSync(target, "utf8"));
    const delta = JSON.parse(readFileSync(join(options.deltas, entry), "utf8"));
    const { merged, added } = mergeDelta(map, delta);
    if (added > 0) writeJsonAtomic(target, merged);
    summary[locale] = added;
  }
  console.log(JSON.stringify(summary));
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) main();
