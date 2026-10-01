// Fail-closed guard for tests that write to or delete under the home dir.
// tests/setup/isolateDataDir.js points HOME at a per-file temp root, but only
// when vitest loads tests/vitest.config.js. Run any other way, os.homedir() is
// the developer's real home and a recursive rm under it wipes real config
// (2026-10-01: a bare root `npx vitest run` deleted ~/.config).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const NOT_ISOLATED =
  "HOME is not isolated; run via `npm test` or `npx vitest run -c tests/vitest.config.js`";

const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/**
 * Returns `home` if it lies inside this file's temp root (TOKENHOP_TEST_ROOT,
 * itself under os.tmpdir()) and is not the real home; throws otherwise.
 */
export function assertIsolatedHome(home = os.homedir()) {
  const root = process.env.TOKENHOP_TEST_ROOT;
  const realHome = process.env.TOKENHOP_TEST_REAL_HOME;
  const isolated =
    Boolean(root) &&
    isInside(path.resolve(root), path.resolve(os.tmpdir())) &&
    isInside(path.resolve(home), path.resolve(root)) &&
    (!realHome || path.resolve(home) !== path.resolve(realHome));
  if (!isolated) throw new Error(`${NOT_ISOLATED} (home = ${home})`);
  return home;
}

/** Recursively removes each of `rels` (paths relative to `home`), only inside an isolated home. */
export async function removeUnderHome(rels, home = os.homedir()) {
  const base = path.resolve(assertIsolatedHome(home));
  const targets = rels.map((rel) => {
    const target = path.resolve(base, rel);
    if (!isInside(target, base)) throw new Error(`refusing to remove ${target}: not under ${base}`);
    return target;
  });
  await Promise.all(targets.map((t) => fs.rm(t, { recursive: true, force: true })));
}
