// YAN-1993: the SQLite driver the suite runs on depends on the Node major
// (better-sqlite3 below 24, node:sqlite from 24; see src/lib/db/driver.js), and
// the drivers bind parameters differently. CI runs the `.nvmrc` version, so a
// local run on another major can pass queries that CI rejects.
//
// - `npm test` (root) runs this file first and FAILS on a major mismatch.
// - vitest loads it as a globalSetup and only WARNS, so a direct
//   `npx vitest run <file>` still works on another Node.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const NVMRC = fileURLToPath(new URL("../../.nvmrc", import.meta.url));

/** Major version from a `.nvmrc` value ("22.23.4", "v22", "22"); null when not numeric (e.g. "lts/*"). */
export function parseNvmrcMajor(text) {
  const m = /^v?(\d+)(?:\.|$)/.exec(String(text ?? "").trim());
  return m ? Number(m[1]) : null;
}

/**
 * Compare the running Node major with the `.nvmrc` major.
 * @param {{ nvmrc: string, nodeVersion: string }} input `.nvmrc` text and `process.versions.node`
 * @returns {{ ok: boolean, expected: number|null, actual: number, message: string|null }}
 */
export function checkNodeVersion({ nvmrc, nodeVersion }) {
  const expected = parseNvmrcMajor(nvmrc);
  const actual = Number(String(nodeVersion).split(".")[0]);
  // A non-numeric .nvmrc (e.g. "lts/*") has no major to compare.
  if (expected === null || actual === expected)
    return { ok: true, expected, actual, message: null };
  return {
    ok: false,
    expected,
    actual,
    message:
      `Node ${nodeVersion} is running, but .nvmrc pins Node ${String(nvmrc).trim()} (major ${expected}), which CI uses. ` +
      "The SQLite driver differs by Node major (better-sqlite3 vs node:sqlite), so results here may not match CI. " +
      "Switch first, e.g. `nvm use`, `fnm use` or `mise exec node@$(cat .nvmrc) -- npm test`.",
  };
}

function checkCurrent() {
  return checkNodeVersion({
    nvmrc: readFileSync(NVMRC, "utf8"),
    nodeVersion: process.versions.node,
  });
}

// vitest globalSetup: warn only.
export default function setup() {
  const result = checkCurrent();
  if (!result.ok) console.warn(`\n[node-version] WARNING: ${result.message}\n`);
}

// CLI (`node tests/setup/nodeVersionGate.js`, run by the root `npm test`): fail.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkCurrent();
  if (!result.ok) {
    console.error(`[node-version] ${result.message}`);
    process.exit(1);
  }
}
