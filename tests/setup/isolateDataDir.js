// vitest `setupFiles`: runs before every test file. Points DATA_DIR and the
// home-dir env vars at a fresh per-file temp root so tests never read or write
// the developer's real ~/.9router (DB, jwt-secret, machine-id, MITM logs, …).
// App modules resolve these paths at import time, which is why this must run
// before the test file loads rather than inside a beforeAll.
//
// Only files in the `real` vitest project may opt out, and only when a live
// gate (RUN_REAL=1 / RUN_E2E=1) is set: they need the real credential DB.
import { mkdtempSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LIVE_GATES = ["RUN_REAL", "RUN_E2E"];

const usesRealData =
  process.env.TOKENHOP_TEST_REAL_PROJECT === "1" &&
  LIVE_GATES.some((gate) => process.env[gate] === "1");

if (!usesRealData) isolateDataDir();

function isolateDataDir() {
  const parent = process.env.TOKENHOP_TEST_TMP_PARENT;
  if (!parent) {
    throw new Error(
      "TOKENHOP_TEST_TMP_PARENT is unset: tests/setup/tempRoot.js must be the vitest globalSetup",
    );
  }

  // Removed with the parent by tempRoot.js teardown.
  const root = mkdtempSync(join(parent, "file-"));
  const home = join(root, "home");
  mkdirSync(home);

  process.env.TOKENHOP_TEST_ROOT = root;
  process.env.DATA_DIR = join(root, "data");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  process.env.LOCALAPPDATA = join(home, "AppData", "Local");
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.XDG_DATA_HOME = join(home, ".local", "share");
  process.env.XDG_CACHE_HOME = join(home, ".cache");

  // os.homedir() ignores process.env inside worker threads (--pool=threads),
  // so home-based paths would still hit the real home. Refuse to run then.
  if (homedir() !== home) {
    throw new Error(
      `HOME override not honored (os.homedir() = ${homedir()}); run tests with the forks pool`,
    );
  }
}
