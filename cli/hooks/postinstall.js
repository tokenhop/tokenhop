#!/usr/bin/env node

// Postinstall: warm-up SQLite deps into <data dir>/runtime so the first
// start doesn't need network. Failure here is non-fatal —
// cli.js will retry at runtime if anything is missing.
const { ensureSqliteRuntime } = require("./sqliteRuntime");
const { ensureTrayRuntime } = require("./trayRuntime");
const { requireShared } = require("../src/cli/utils/requireShared");

const LOG_PREFIX = `[${requireShared("brand").ACTIVE.slug}]`;

try {
  ensureSqliteRuntime({ silent: false });
  console.log(`${LOG_PREFIX} runtime SQLite deps ready`);
} catch (e) {
  console.warn(`${LOG_PREFIX} runtime warm-up skipped: ${e.message}`);
}

try {
  ensureTrayRuntime({ silent: false });
} catch (e) {
  console.warn(`${LOG_PREFIX} tray runtime skipped: ${e.message}`);
}

process.exit(0);
