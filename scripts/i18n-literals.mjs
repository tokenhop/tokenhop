#!/usr/bin/env node
/**
 * Extract user-facing literals from the dashboard source for the runtime i18n
 * lookup (see src/i18n/runtime.js).
 *
 * The runtime translates trimmed text nodes in the DOM plus any string passed
 * through translate("..."), so the translatable set is:
 * - JSX text content (collapsed whitespace, trimmed), including <option> text
 *   (the runtime skips <select> containers but the selected label shows)
 * - String-literal values of native DOM attributes: aria-label, placeholder,
 *   title, alt
 * - String-literal values of app/shared component props that render as
 *   visible DOM text (label, title, subtitle, hint, description, placeholder,
 *   body, emptyTitle, emptyBody, eyebrow, message, text, valueText,
 *   confirmText, actionLabel, checkingLabel, installHint, pickLabel,
 *   resetLabel), and `label:` keys in navigation constant files
 * - String-literal arguments to translate("...") calls
 *
 * Skipped by design (matches the runtime):
 * - Icon ligatures (material-symbols spans carry aria-hidden)
 * - Code/mono content, scripts, styles (data-i18n-skip subtrees, code/pre tags)
 * - Dynamic values (template literals, concatenation, variables)
 * - Anything under a data-i18n-skip ancestor
 *
 * Usage:
 *   node scripts/i18n-literals.mjs [--root <dir>] [--locales <dir>] [--json]
 *
 * --json prints a machine-readable report instead of the human summary.
 * Exit code is 0 either way; this script only reports, never writes.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "package.json"));
const babelParser = require("next/dist/compiled/babel/parser.js");
const babelTraverse = require("next/dist/compiled/babel/traverse.js").default;

const DEFAULT_SRC_DIRS = ["src/app", "src/shared", "src/dashboardGuard.js"];
const DEFAULT_LOCALES_DIR = "public/i18n/literals";

const TRANSLATABLE_ATTRS = new Set(["aria-label", "placeholder", "title", "alt"]);

/**
 * Props on app/shared components that end up as visible DOM text. Derived by
 * checking each component's render: the value is rendered as a JSX child or a
 * translatable DOM attribute, so the runtime walker will translate it.
 */
const TRANSLATABLE_COMPONENT_PROPS = new Set([
  "label",
  "title",
  "subtitle",
  "hint",
  "description",
  "placeholder",
  "body",
  "emptyTitle",
  "emptyBody",
  "eyebrow",
  "message",
  "text",
  "valueText",
  "confirmText",
  "actionLabel",
  "checkingLabel",
  "installHint",
  "pickLabel",
  "resetLabel",
]);

/**
 * Object-literal keys whose string values render as visible UI labels, but
 * only inside the allowlisted UI modules (option arrays, nav constants,
 * section registries). Everywhere else (API payloads, config) these same
 * keys are data, not UI copy.
 */
const CONDITIONAL_OBJECT_KEYS = new Set([
  "label",
  "title",
  "subtitle",
  "hint",
  "desc",
  "description",
  "message",
  "text",
  "emptyTitle",
  "emptyBody",
  "body",
  "placeholder",
  "helper",
  "helperText",
  "eyebrow",
  "actionLabel",
  "confirmText",
  "tooltip",
  "summary",
  "detail",
  "caption",
  "short",
]);

/**
 * UI source trees whose object-literal copy renders as visible text: the
 * dashboard pages and shared components/constants. Excludes API routes,
 * server libs and request payload builders where the same keys are data.
 */
const LABEL_KEY_FILE_RES = [
  /src[/\\]app[/\\]\(dashboard\)[/\\]/,
  /src[/\\]app[/\\]login[/\\]/,
  /src[/\\]shared[/\\](components|constants|hooks|utils)[/\\]/,
];

/** Object-literal values that look like code, model ids or API enums. */
const OBJECT_VALUE_SKIP_RE = /^[a-z0-9_.:/-]+$|^[A-Z0-9_]+$|^\$\{|[<>]{1}|^\w+\(/;

const SKIP_TAGS = new Set([
  "script",
  "style",
  "code",
  "pre",
  "datalist",
  "optgroup",
  "colgroup",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
]);
const CODE_TAGS = new Set(["script", "style", "code", "pre"]);

const MATERIAL_ICON_CLASS = "material-symbols";
const SKIP_VALUE_RE = /^[\d\s\-_:.,/\\|#*()[\]{}!?…+='";$%@&<>"'`~^]*$/;

/** Product names, model ids and mono identifiers stay untranslated. */
export const UNTRANSLATED_RE =
  /^(9router|9remote|rtk|pxpipe|mcp|api|url|json|cli|sdk|ok|[\w-]+(\/[\w.-]+)+)$/i;

/**
 * Identifier-like values the runtime would look up but no locale should
 * translate: URLs, bare hosts, snake_case tokens (icon ligatures, API enums),
 * masked sample keys and comma-separated host lists.
 */
const IDENTIFIER_RES = [
  /:\/\//, // any URL or custom scheme
  /^[\w-]+(\.[\w-]+)+(\/\S*)?$/, // bare host / domain with optional path
  /^[a-z]+(_[a-z]+)+$/, // snake_case identifiers (chevron_right, verbose_json)
  /^[a-z]{2,4}$/, // short lowercase codes (srt, vtt, esc)
  /x{4,}/i, // masked samples (ddo_xxxx), but not Loading.../Fetching...
  /^(?=[a-z]*\d)[a-z0-9]+\.{3}$|^[a-z]+-\.{3}$/, // key stubs: abc123def456..., sk-...
  /^[\w.-]+(,\s*[\w.-]+)+$/, // host lists (localhost, 127.0.0.1)
  /^[a-z]+[A-Z]\w*$/, // camelCase settings keys (providerStrategies)
  /^[~%]/, // filesystem paths (~/.9router, %APPDATA%/…)
  /^[A-Z]{2,5}$/, // bare units/acronyms (KB, TTFT)
  /^[a-z0-9]+(-[a-z0-9]+)+$/, // lowercase slugs / sample ids (my-combo-123)
];

/**
 * Multi-word values that are still code/data, not prose: CLI invocations,
 * model-id mappings, font specs, byte sizes, sample tokens.
 */
const CODE_VALUE_RES = [
  /^(jcode|npx|npm|git|curl|node|python)\s/, // shell commands
  /\w+\/[\w.-]+\s*→\s*\w+\/[\w.-]+/, // model-id mappings
  /^(Geist|Bricolage|Inter)\b.*\d{3}/, // font family + weight specs
  /^[\d.]+\s*(KB|MB|GB)$/, // byte sizes
  /^e\.g\.\s+[A-Za-z0-9]{12,}$/, // sample opaque ids
  /\s·\s[\d.]+\s*(KB|MB)$/, // "git log · 18.2 KB"
  /^(?:[a-z]+:)?(?:text|bg|border)-[\w[\]-]+(?:\s+(?:[a-z]+:)?(?:text|bg|border)-[\w[\]-]+)*$/, // Tailwind class lists
  /^[A-Z][\w]*(-[A-Z]+)+$/, // header-style tokens (Cloud-IDE-JWT)
];

function isUntranslatableValue(value) {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed || trimmed.length < 2) return true;
  if (SKIP_VALUE_RE.test(trimmed)) return true;
  if (/^[{}\s]*$/.test(trimmed)) return true;
  if (!/\s/.test(trimmed) && IDENTIFIER_RES.some((re) => re.test(trimmed))) return true;
  if (/:\/\//.test(trimmed) && !/\s\w{3,}\s/.test(trimmed.replace(/\S*:\/\/\S*/g, ""))) return true;
  if (/^[\w.-]+(,\s*[\w.-]+)+$/.test(trimmed)) return true;
  if (CODE_VALUE_RES.some((re) => re.test(trimmed))) return true;
  return false;
}

function classAttrOf(attributes) {
  for (const attr of attributes || []) {
    if (attr.type !== "JSXAttribute" || attr.name?.name !== "className") continue;
    const value = attr.value;
    if (value?.type === "StringLiteral") return value.value;
    const expr = value?.type === "JSXExpressionContainer" ? value.expression : null;
    if (expr?.type === "StringLiteral") return expr.value;
    // Template literal: static parts are enough to detect icon classes.
    if (expr?.type === "TemplateLiteral") return expr.quasis.map((q) => q.value.cooked).join(" ");
  }
  return "";
}

function hasSkipAncestor(elementPath) {
  let path = elementPath.parentPath;
  while (path) {
    if (path.isJSXElement()) {
      const attrs = path.node.openingElement?.attributes || [];
      if (
        attrs.some((attr) => attr.type === "JSXAttribute" && attr.name?.name === "data-i18n-skip")
      ) {
        return true;
      }
      const name = path.node.openingElement?.name;
      const tag = name?.name || "";
      // Code tags suppress the full subtree; structural table/select tags
      // suppress only their own text nodes, not cell/option copy.
      if (CODE_TAGS.has(tag) || (path === elementPath.parentPath && SKIP_TAGS.has(tag))) {
        return true;
      }
      const className = classAttrOf(attrs);
      if (className.includes(MATERIAL_ICON_CLASS)) return true;
    }
    path = path.parentPath;
  }
  return false;
}

/**
 * Extract translatable literals from a source string.
 * @param {string} code File contents.
 * @param {string} [filename] Used only for parser error messages.
 * @returns {Set<string>} Trimmed literals in first-seen order.
 */
export function extractFromSource(code, filename = "unknown.js") {
  const literals = new Set();
  let ast;
  try {
    ast = babelParser.parse(code, {
      sourceType: "unambiguous",
      plugins: ["jsx", "typescript"],
    });
  } catch {
    return literals;
  }

  babelTraverse(ast, {
    JSXText(path) {
      const trimmed = path.node.value.replace(/\s+/g, " ").trim();
      if (isUntranslatableValue(trimmed)) return;
      if (hasSkipAncestor(path)) return;
      // Fragments split by JSX expressions/components cannot be translated by
      // the runtime's exact text-node lookup. Report only complete literals.
      if (/^[,.;:\-)]|[,;:\-(]$/.test(trimmed)) return;
      literals.add(trimmed);
    },
    JSXAttribute(path) {
      const attrName = path.node.name?.name;
      const opening = path.parentPath?.node;
      const tagName = opening?.name?.name || "";
      const isComponent = /^[A-Z]/.test(tagName);
      const translatable =
        TRANSLATABLE_ATTRS.has(attrName) ||
        (isComponent && TRANSLATABLE_COMPONENT_PROPS.has(attrName));
      if (!translatable) return;
      if (path.node.value?.type !== "StringLiteral") return;
      const trimmed = path.node.value.value.replace(/\s+/g, " ").trim();
      if (isUntranslatableValue(trimmed)) return;
      if (hasSkipAncestor(path)) return;
      literals.add(trimmed);
    },
    ObjectProperty(path) {
      const key = path.node.key;
      const keyName =
        key?.type === "Identifier" ? key.name : key?.type === "StringLiteral" ? key.value : "";
      if (!CONDITIONAL_OBJECT_KEYS.has(keyName)) return;
      if (!LABEL_KEY_FILE_RES.some((re) => re.test(filename))) return;
      if (path.node.value?.type !== "StringLiteral") return;
      const trimmed = path.node.value.value.replace(/\s+/g, " ").trim();
      if (isUntranslatableValue(trimmed)) return;
      if (OBJECT_VALUE_SKIP_RE.test(trimmed)) return;
      literals.add(trimmed);
    },
    CallExpression(path) {
      if (path.node.callee?.name !== "translate") return;
      const arg = path.node.arguments[0];
      if (!arg || arg.type !== "StringLiteral") return;
      const trimmed = arg.value.replace(/\s+/g, " ").trim();
      if (isUntranslatableValue(trimmed)) return;
      literals.add(trimmed);
    },
  });

  return literals;
}

function collectJsFiles(roots) {
  const files = [];
  const visit = (entry) => {
    const stat = statSync(entry);
    if (stat.isDirectory()) {
      if (entry.split("/").pop() === "graphify-out") return;
      for (const child of readdirSync(entry)) visit(join(entry, child));
      return;
    }
    if (entry.endsWith(".js") && !entry.endsWith(".test.js")) files.push(entry);
  };
  for (const root of roots) visit(root);
  return files.sort();
}

/**
 * Extract literals from every dashboard source file under repoRoot.
 * @param {string} repoRoot Absolute path to the repo checkout.
 * @returns {{ literals: string[], files: number }} Sorted literals + file count.
 */
export function extractFromRepo(repoRoot) {
  const roots = DEFAULT_SRC_DIRS.map((dir) => join(repoRoot, dir)).filter((entry) => {
    try {
      statSync(entry);
      return true;
    } catch {
      return false;
    }
  });
  const literals = new Set();
  const files = collectJsFiles(roots);
  const failures = [];
  for (const file of files) {
    try {
      for (const literal of extractFromSource(readFileSync(file, "utf8"), file)) {
        literals.add(literal);
      }
    } catch {
      failures.push(file);
    }
  }
  return { literals: [...literals].sort(), files: files.length, failures };
}

/**
 * Read every <locale>.json file in localesDir.
 * @param {string} localesDir Absolute path to public/i18n/literals.
 * @returns {Map<string, Record<string, string>>} locale -> key/value map.
 */
export function readLocaleFiles(localesDir) {
  const locales = new Map();
  for (const entry of readdirSync(localesDir).sort()) {
    if (!entry.endsWith(".json")) continue;
    const locale = entry.slice(0, -".json".length);
    locales.set(locale, JSON.parse(readFileSync(join(localesDir, entry), "utf8")));
  }
  return locales;
}

const PLACEHOLDER_RE = /({\d+}|%[sd]|\{[^}\s]+\}|\[[a-z]+\])/gi;

/**
 * Placeholder/format tokens inside a literal (e.g. {count}, %s, [code]).
 * @param {string} text
 * @returns {string[]} Lower-cased tokens in order.
 */
export function placeholdersOf(text) {
  return [...String(text).matchAll(PLACEHOLDER_RE)].map((match) => match[0].toLowerCase());
}

/**
 * Diff extracted literals against every locale file.
 * @param {string[]} literals Sorted literals from the source.
 * @param {Map<string, Record<string, string>>} locales locale -> map.
 * @returns {{ missing: Record<string, string[]>, orphaned: string[], mismatches: Array<{locale: string, key: string, expected: string[], actual: string[]}> }}
 */
export function diffAgainstLocales(literals, locales) {
  const extracted = new Set(literals);
  const missing = {};
  const mismatches = [];
  for (const [locale, map] of locales) {
    const absent = literals.filter((literal) => !(literal in map));
    if (absent.length > 0) missing[locale] = absent;
    for (const literal of literals) {
      if (!(literal in map)) continue;
      const expected = placeholdersOf(literal);
      const actual = placeholdersOf(map[literal]);
      if (expected.join("|") !== actual.join("|")) {
        mismatches.push({ locale, key: literal, expected, actual });
      }
    }
  }
  const keyCounts = new Map();
  for (const map of locales.values()) {
    for (const key of Object.keys(map)) keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
  }
  const orphaned = [...keyCounts.keys()].filter((key) => !extracted.has(key)).sort();
  return { missing, orphaned, mismatches };
}

/**
 * Invalid entries inside one locale file: empty values and placeholder drift.
 * @param {Record<string, string>} map
 * @returns {{ empty: string[], mismatched: string[] }}
 */
export function validateLocaleFile(map) {
  const empty = Object.entries(map)
    .filter(([, value]) => !String(value ?? "").trim())
    .map(([key]) => key);
  const mismatched = Object.entries(map)
    .filter(([key, value]) => placeholdersOf(key).join("|") !== placeholdersOf(value).join("|"))
    .map(([key]) => key);
  return { empty, mismatched };
}

function parseArgs(argv) {
  const options = { json: false, root: null, locales: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--json") options.json = true;
    else if (argv[index] === "--root") options.root = resolve(argv[(index += 1)]);
    else if (argv[index] === "--locales") options.locales = resolve(argv[(index += 1)]);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const repoRoot = options.root || resolve(here, "..");
  const localesDir = options.locales || join(repoRoot, DEFAULT_LOCALES_DIR);

  const { literals, files, failures } = extractFromRepo(repoRoot);
  const locales = readLocaleFiles(localesDir);
  const { missing, orphaned, mismatches } = diffAgainstLocales(literals, locales);

  const missingTotal = Object.values(missing).reduce((sum, keys) => sum + keys.length, 0);

  if (options.json) {
    console.log(
      JSON.stringify({ literals, files, failures, missing, orphaned, mismatches }, null, 2),
    );
    return;
  }

  console.log(`Scanned ${files} source files, extracted ${literals.length} literals.`);
  if (failures.length > 0) console.log(`Unreadable files: ${failures.length}`);
  console.log(`Locales: ${locales.size}. Missing translations: ${missingTotal} (locale x key).`);
  console.log(`Orphaned keys (in locale files, not in source): ${orphaned.length}.`);
  console.log(`Placeholder mismatches: ${mismatches.length}.`);
  if (orphaned.length > 0) {
    console.log("\nOrphaned keys (first 50):");
    for (const key of orphaned.slice(0, 50)) console.log(`  - ${key}`);
  }
}

const invokedAsScript =
  process.argv[1] && resolve(process.argv[1]) === resolve(here, "i18n-literals.mjs");
if (invokedAsScript) main();
