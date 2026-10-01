"use strict";

/**
 * Data-dir resolver: one resolution for the app, the MITM server and the CLI.
 * Dependency-free CommonJS so every consumer can load it; the CLI build copies
 * this file into the CLI package next to the brand module (cli/scripts/build-cli.js).
 *
 * With DATA_DIR unset: the active brand's dir if it exists, else the legacy dir
 * if it exists (warning once), else the active brand's dir. Under the default
 * brand both names match, so nothing changes. Options are injectable for tests.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { ACTIVE, BRAND, LEGACY } = require("../brand/index.cjs");

const warned = new Set();

// The CLI resolves the data dir per call, so warn once per message per process.
function warnOnce(message) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

function dirFor(name, { platform = process.platform, env = process.env, homedir = os.homedir() }) {
  if (platform === "win32") {
    return path.win32.join(env.APPDATA || path.win32.join(homedir, "AppData", "Roaming"), name);
  }
  return path.posix.join(homedir, `.${name}`);
}

/** The active brand's default dir, whether or not it exists. */
function brandDataDir(opts = {}) {
  return dirFor(ACTIVE.dataDirName, opts);
}

/** The legacy default dir, whether or not it exists. legacy(9router): remove in v2 */
function legacyDataDir(opts = {}) {
  return dirFor(LEGACY.dataDirName, opts);
}

function resolveDefault(opts = {}) {
  const { exists = fs.existsSync } = opts;
  const dir = brandDataDir(opts);
  const legacy = legacyDataDir(opts);
  if (dir === legacy) return { dir, isLegacy: false, ignoredLegacy: null };
  if (exists(dir)) {
    if (!exists(legacy)) return { dir, isLegacy: false, ignoredLegacy: null };
    warnOnce(`[DATA_DIR] using ${dir}; legacy ${legacy} is ignored`);
    return { dir, isLegacy: false, ignoredLegacy: legacy };
  }
  if (exists(legacy)) {
    // legacy(9router): remove in v2
    warnOnce(
      `[DATA_DIR] using legacy ${legacy}; move it to ${dir} with: ${BRAND.npmPackage} data migrate`,
    );
    return { dir: legacy, isLegacy: true, ignoredLegacy: null };
  }
  return { dir, isLegacy: false, ignoredLegacy: null };
}

function defaultDataDir(opts = {}) {
  return resolveDefault(opts).dir;
}

function getDataDir(opts = {}) {
  const { platform = process.platform, env = process.env } = opts;
  const configured = env.DATA_DIR;
  if (!configured) return defaultDataDir(opts);

  // On Windows, ignore Unix-style absolute paths (e.g. /var/lib/...) that come
  // from a Linux-targeted .env or Docker config — they are not valid here.
  if (platform === "win32" && /^\//.test(configured)) {
    warnOnce(`[DATA_DIR] '${configured}' is a Unix path on Windows → fallback to default`);
    return defaultDataDir(opts);
  }

  try {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  } catch (e) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      warnOnce(`[DATA_DIR] '${configured}' not writable → fallback ~/.${ACTIVE.dataDirName}`);
      return defaultDataDir(opts);
    }
    throw e;
  }
}

/**
 * True when DATA_DIR is unset and the legacy default is in use (tokenhop brand
 * only). A DATA_DIR pointing at the legacy dir is the user's choice: false.
 */
function isLegacyDataDir(opts = {}) {
  const { env = process.env } = opts;
  return !env.DATA_DIR && resolveDefault(opts).isLegacy;
}

/** The legacy dir when it exists but the new one wins (DATA_DIR unset), else null. */
function ignoredLegacyDataDir(opts = {}) {
  const { env = process.env } = opts;
  return env.DATA_DIR ? null : resolveDefault(opts).ignoredLegacy;
}

module.exports = {
  getDataDir,
  defaultDataDir,
  brandDataDir,
  legacyDataDir,
  isLegacyDataDir,
  ignoredLegacyDataDir,
};
