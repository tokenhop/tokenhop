// Collect every Material Symbols name the UI can render, by scanning source literals.
// Over-inclusive on purpose: any quoted string or JSX text equal to a known icon name counts,
// so props (`icon: "home"`), maps, ternaries and registry `display.icon` values are all covered.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Source roots whose literals can reach a `.material-symbols-outlined` element. */
export const ICON_SOURCE_DIRS = ["src", "open-sse/providers/registry"];

/** Every ligature in the full Material Symbols font (written by scripts/icons-subset.mjs). */
export function loadKnownIconNames(root) {
  const text = readFileSync(join(root, "scripts/lib/material-symbols-names.txt"), "utf8");
  return new Set(text.split("\n").filter(Boolean));
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.(m?js|jsx)$/.test(entry.name)) yield path;
  }
}

/** Every icon-shaped token (quoted literal or JSX text) under ICON_SOURCE_DIRS. */
export function collectLiteralTokens(root) {
  const tokens = new Set();
  for (const dir of ICON_SOURCE_DIRS) {
    for (const file of sourceFiles(join(root, dir))) {
      // Storage-mode enums are server data, not icon names (e.g. "encrypted").
      const text = readFileSync(file, "utf8").replace(
        /(?:\.storage\s*[!=]==?\s*|\bstorage\s*:\s*)["'`]encrypted["'`]/g,
        "",
      );
      for (const m of text.matchAll(/["'`]([a-z0-9_]+)["'`]|>\s*([a-z0-9_]+)\s*</g)) {
        tokens.add(m[1] || m[2]);
      }
    }
  }
  return tokens;
}

/** Sorted icon names referenced anywhere under ICON_SOURCE_DIRS. */
export function collectUsedIconNames(root) {
  const known = loadKnownIconNames(root);
  return [...collectLiteralTokens(root)].filter((token) => known.has(token)).sort();
}
