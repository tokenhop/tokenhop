"use strict";

/**
 * Data-dir resolver: one resolution for the app, the MITM server and the CLI.
 * Dependency-free CommonJS so every consumer can load it; the CLI build copies
 * this file into the CLI package next to the brand module (cli/scripts/build-cli.js).
 * YAN-325 switches the directory name to the new brand.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { LEGACY } = require("../brand/index.cjs");

const DIR_NAME = LEGACY.dataDirName;

const warned = new Set();

// The CLI resolves the data dir per call, so warn once per message per process.
function warnOnce(message) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

function defaultDataDir({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
} = {}) {
  if (platform === "win32") {
    return path.win32.join(env.APPDATA || path.win32.join(homedir, "AppData", "Roaming"), DIR_NAME);
  }
  return path.posix.join(homedir, `.${DIR_NAME}`);
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
      warnOnce(`[DATA_DIR] '${configured}' not writable → fallback ~/.${DIR_NAME}`);
      return defaultDataDir(opts);
    }
    throw e;
  }
}

module.exports = { getDataDir, defaultDataDir };
