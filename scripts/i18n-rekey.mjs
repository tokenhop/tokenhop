#!/usr/bin/env node
/**
 * Re-key locale translations whose English key was renamed in place.
 *
 * A rename is provable only when the SAME source location (same file, same
 * syntactic slot) held exactly one literal before a commit range and exactly
 * one different literal after it. Fuzzy text similarity is never used.
 *
 * CLI:
 *   node scripts/i18n-rekey.mjs --since <sha> --until <sha> \
 *     --missing <missing.json> --out <report.json> [--apply]
 *
 * --missing is the JSON array of still-missing literals (from
 * scripts/i18n-literals.mjs --json, the union of missing[locale]).
 * Writes a report (mapping old→new per file, per-locale rekey counts,
 * unmapped missing keys) or, with --apply, copies old values to new keys in
 * every locale file (old keys are kept — orphan cleanup is YAN-414).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { extractWithLines } from "./i18n-literals.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 100e6,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Attribute slots keep the attribute name but drop the component tag:
 * a rename like Callout→ErrorState keeps the same attribute home, while
 * keeping distinct names for text/key/call slots.
 */
function normalizeSlot(slot) {
  if (!slot.startsWith("attr:")) return slot;
  const dot = slot.indexOf(".");
  return `attr:${dot === -1 ? slot.slice(5) : slot.slice(dot + 1)}`;
}

function sameIgnoringCase(a, b) {
  return a !== b && a.toLocaleLowerCase("en") === b.toLocaleLowerCase("en");
}

function occurrences(root, sha, file) {
  let code;
  try {
    code = git(root, "show", `${sha}:${file}`);
  } catch {
    return []; // added or deleted between the range ends
  }
  return extractWithLines(code, file);
}

/**
 * Build the deterministic old→new literal rename map for a commit range.
 * @param {string} root Repo checkout.
 * @param {string} since Start commit (exclusive).
 * @param {string} until End commit (inclusive).
 * @param {string[]} missingLiterals Literals still missing from locales.
 * @param {string[]} oldCandidates Orphaned literals present in locale files.
 * @returns {{mapping: Record<string,string>, unmapped: string[], evidence: Record<string,string>}}
 */
export function buildRenameMap(root, since, until, missingLiterals, oldCandidates) {
  const missingSet = new Set(missingLiterals);
  const oldSet = new Set(oldCandidates);
  const mapping = {};
  const evidence = {};
  const conflicted = new Set();

  // A rename is provable only when the same commit changes a hunk in the
  // same syntactic slot from exactly one distinct orphaned old literal to
  // exactly one distinct missing new literal (case-only, meaning preserved).
  // Everything else — semantic edits, moved blocks, ambiguous pairs — is
  // left unmapped for fresh translation, never guessed.: each commit is evaluated
  // against its own parent, so later slices never mask earlier ones and
  // intermediate copies (e.g. a header string moved into a page) still pair.
  const revList = git(root, "rev-list", "--reverse", `${since}..${until}`)
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const commit of revList) {
    const files = git(root, "diff", "--name-only", `${commit}^`, commit)
      .split("\n")
      .filter((f) => f.startsWith("src/") && f.endsWith(".js") && !f.endsWith(".test.js"));
    for (const file of files) {
      const before = occurrences(root, `${commit}^`, file);
      const after = occurrences(root, commit, file);
      const diff = git(root, "diff", "--unified=0", `${commit}^`, commit, "--", file);
      const ranges = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map(
        (match) => ({
          oldStart: Number(match[1]),
          oldEnd: Number(match[1]) + Number(match[2] ?? 1) - 1,
          newStart: Number(match[3]),
          newEnd: Number(match[3]) + Number(match[4] ?? 1) - 1,
        }),
      );

      for (const range of ranges) {
        const oldInHunk = before.filter(
          (o) => o.endLine >= range.oldStart && o.line <= range.oldEnd && oldSet.has(o.literal),
        );
        const newInHunk = after.filter(
          (o) => o.endLine >= range.newStart && o.line <= range.newEnd && missingSet.has(o.literal),
        );
        // Pair within one changed hunk and one syntactic slot, and only when
        // the edit is case-only (meaning preserved, no locale review needed).
        // Each new literal must have exactly one such old partner.
        for (const newOcc of newInHunk) {
          const partners = new Set(
            oldInHunk
              .filter((occ) => normalizeSlot(occ.slot) === normalizeSlot(newOcc.slot))
              .filter((occ) => sameIgnoringCase(occ.literal, newOcc.literal))
              .map((occ) => occ.literal),
          );
          if (partners.size !== 1 || conflicted.has(newOcc.literal)) continue;
          const [oldLiteral] = partners;
          if (newOcc.literal in mapping && mapping[newOcc.literal] !== oldLiteral) {
            delete mapping[newOcc.literal]; // conflicting evidence: never guess
            delete evidence[newOcc.literal];
            conflicted.add(newOcc.literal);
            continue;
          }
          mapping[newOcc.literal] = oldLiteral;
          evidence[newOcc.literal] =
            `${commit.slice(0, 8)} ${file} [${normalizeSlot(newOcc.slot)}] line ${newOcc.line}`;
        }
      }
    }
  }

  // Invert new->old into old->new; one old literal must not silently feed
  // two different new literals — that is a rename fork, not a rename.
  const inverted = {};
  const forkedOlds = new Set();
  for (const [newLiteral, oldLiteral] of Object.entries(mapping)) {
    if (forkedOlds.has(oldLiteral)) {
      delete evidence[newLiteral];
      conflicted.add(newLiteral);
      delete mapping[newLiteral];
      continue;
    }
    if (oldLiteral in inverted && inverted[oldLiteral] !== newLiteral) {
      // Fork: both new literals lose the rename.
      for (const forked of [newLiteral, inverted[oldLiteral]]) {
        delete evidence[forked];
        conflicted.add(forked);
        delete mapping[forked];
      }
      delete inverted[oldLiteral];
      forkedOlds.add(oldLiteral);
      continue;
    }
    inverted[oldLiteral] = newLiteral;
  }
  const unmapped = missingLiterals.filter(
    (literal) => conflicted.has(literal) || !(literal in mapping),
  );
  return { mapping: inverted, unmapped, evidence };
}

/**
 * Copy old values to new keys in every locale map (old keys are kept).
 * @param {Map<string, Record<string,string>>} locales
 * @param {Record<string,string>} mapping old literal -> new literal
 * @returns {{counts: Record<string, number>, locales: Map<string, Record<string,string>>}}
 */
export function rekeyLocales(locales, mapping) {
  const counts = {};
  for (const [locale, map] of locales) {
    let copied = 0;
    for (const [oldKey, newKey] of Object.entries(mapping)) {
      if (!(oldKey in map) || newKey in map) continue;
      map[newKey] = map[oldKey];
      copied += 1;
    }
    counts[locale] = copied;
  }
  return { counts, locales };
}

function writeJsonAtomic(path, data) {
  const tmp = join(dirname(path), `.${randomUUID()}.json`);
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function parseArgs(argv) {
  const options = {
    since: null,
    until: null,
    missing: null,
    out: null,
    apply: false,
    localesDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--apply") {
      options.apply = true;
      continue;
    }
    i += 1;
    if (flag === "--since") options.since = argv[i];
    else if (flag === "--until") options.until = argv[i];
    else if (flag === "--missing") options.missing = argv[i];
    else if (flag === "--out") options.out = argv[i];
    else if (flag === "--locales") options.localesDir = resolve(argv[i]);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!options.since || !options.until || !options.missing || !options.out) {
    console.error(
      "Usage: node scripts/i18n-rekey.mjs --since <sha> --until <sha> --missing <file> --out <report.json> [--locales <dir>] [--apply]",
    );
    process.exit(1);
  }
  const repoRoot = resolve(here, "..");
  const localesDir = options.localesDir || join(repoRoot, "public/i18n/literals");
  const missing = JSON.parse(readFileSync(options.missing, "utf8"));

  // Old-key candidates: literal keys present in the locale files that the
  // current source no longer extracts (the orphaned set).
  const report = JSON.parse(
    execFileSync(
      "node",
      [join(here, "i18n-literals.mjs"), "--json", "--root", repoRoot, "--locales", localesDir],
      { encoding: "utf8", maxBuffer: 100e6 },
    ),
  );
  const orphans = new Set(report.orphaned);

  const { mapping, unmapped, evidence } = buildRenameMap(
    repoRoot,
    options.since,
    options.until,
    missing,
    [...orphans],
  );

  const locales = new Map();
  for (const entry of readdirSync(localesDir).sort()) {
    if (!entry.endsWith(".json")) continue;
    locales.set(entry.slice(0, -5), JSON.parse(readFileSync(join(localesDir, entry), "utf8")));
  }
  const { counts } = rekeyLocales(locales, mapping);

  // The report is written before locales are touched so a bad --out path can
  // never leave half-applied locale files behind.
  writeFileSync(
    options.out,
    `${JSON.stringify({ since: options.since, until: options.until, mapping, evidence, counts, unmapped }, null, 2)}\n`,
    "utf8",
  );
  if (options.apply) {
    for (const [locale, map] of locales) {
      const sorted = Object.fromEntries(
        Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
      writeJsonAtomic(join(localesDir, `${locale}.json`), sorted);
    }
  }
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  console.log(
    `rekeyed ${total} locale entries across ${Object.keys(mapping).length} renames; unmapped: ${unmapped.length}`,
  );
  for (const key of unmapped) console.log(`  UNMAPPED ${JSON.stringify(key)}`);
}

const invokedAsScript =
  process.argv[1] && resolve(process.argv[1]) === resolve(here, "i18n-rekey.mjs");
if (invokedAsScript) main();
