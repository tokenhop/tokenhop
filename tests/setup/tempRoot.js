// vitest `globalSetup`: runs in the main process (once per vitest project, so
// only the first call creates anything). Owns the parent temp dir
// that every per-file root (see isolateDataDir.js) is created in, and removes it
// after the run — including roots of files that were skipped or failed to load,
// where per-file afterAll hooks never run.
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export default function setup() {
  if (process.env.TOKENHOP_TEST_TMP_PARENT) return;
  // Workers inherit this env. Recorded here, before any worker overrides HOME.
  process.env.TOKENHOP_TEST_REAL_HOME ??= homedir();
  const parent = mkdtempSync(join(tmpdir(), "tokenhop-test-"));
  process.env.TOKENHOP_TEST_TMP_PARENT = parent;
  return () => rmSync(parent, { recursive: true, force: true });
}
