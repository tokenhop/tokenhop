/**
 * `tokenhop data migrate` — move the legacy data dir to the tokenhop one.
 *
 * Offered only under the tokenhop brand. Refuses while the server may be
 * running, when DATA_DIR is set, or when the new dir is not empty. Same
 * filesystem: one atomic rename. Across devices: copy, verify (file count,
 * sizes, `PRAGMA integrity_check`), then rename the legacy dir to
 * `<legacy>.migrated-<stamp>`. Never deletes user data (only its own failed
 * partial copy). Idempotent. The running check is best-effort: a server
 * started between the check and the move is not detected.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { findListeningPids, isAlive } = require("../utils/processControl");
const { DEFAULT_PORT } = require("../utils/args");
const { requireShared } = require("../utils/requireShared");

const { ACTIVE_BRAND_ID, BRAND, LEGACY } = requireShared("brand");
const { brandDataDir, legacyDataDir } = requireShared("dataDir");

const AVAILABLE = ACTIVE_BRAND_ID === "tokenhop";
const DB_FILE = path.join("db", "data.sqlite");
const CA_ENV = "NODE_EXTRA_CA_CERTS";

const HELP = `
Usage: ${BRAND.npmPackage} data migrate [--dry-run] [--port <port>]

Move the legacy data dir to the ${BRAND.name} data dir. Stop ${BRAND.name} first.

Options:
  --dry-run        Print the plan without changing anything
  --port <port>    Server port to check before migrating (default: ${DEFAULT_PORT})
  -h, --help       Show this help
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { dryRun: false, port: DEFAULT_PORT, help: false };
  const [sub, ...rest] = argv;
  if (sub === "-h" || sub === "--help" || sub === undefined) return { ...opts, help: true };
  if (sub !== "migrate") throw new UsageError(`Unknown command "data ${sub}"`);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--port" || a === "-p") {
      const v = rest[++i];
      const n = Number(v);
      if (!/^\d+$/.test(v ?? "") || n < 1 || n > 65535) {
        throw new UsageError(`Invalid --port "${v}": expected an integer between 1 and 65535`);
      }
      opts.port = n;
    } else throw new UsageError(`Unknown option "${a}"`);
  }
  return opts;
}

function readPids(file) {
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    const parsed = /^\d+$/.test(raw) ? [Number(raw)] : Object.values(JSON.parse(raw));
    return parsed.filter((p) => Number.isInteger(p) && p > 0);
  } catch {
    return [];
  }
}

/** Reasons the server may be running: live PIDs recorded in either dir, or a listener on the port. */
function runningReasons(dirs, port, deps) {
  const names = [LEGACY.pidFile, BRAND.pidFile, path.join("mitm", ".mitm.pid")];
  const pidFiles = dirs.flatMap((dir) => names.map((f) => path.join(dir, f)));
  const reasons = [];
  for (const file of pidFiles) {
    const live = readPids(file).filter((pid) => pid !== process.pid && deps.isAlive(pid));
    if (live.length) reasons.push(`process ${live.join(", ")} recorded in ${file} is running`);
  }
  const listeners = deps.findListeningPids(port);
  if (listeners.length) reasons.push(`port ${port} is in use (pid ${listeners.join(", ")})`);
  return reasons;
}

// Every entry: relative path → file size, "dir" or "link:<target>".
function fileSizes(root) {
  const sizes = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        sizes.set(rel, "dir");
        walk(full);
      } else if (entry.isSymbolicLink()) sizes.set(rel, `link:${fs.readlinkSync(full)}`);
      else sizes.set(rel, fs.statSync(full).size);
    }
  };
  walk(root);
  return sizes;
}

function verifyCopy(from, to, deps) {
  const a = fileSizes(from);
  const b = fileSizes(to);
  if (a.size !== b.size) throw new Error(`entry count mismatch: ${a.size} vs ${b.size}`);
  for (const [rel, size] of a) {
    if (b.get(rel) !== size) throw new Error(`mismatch: ${rel}`);
  }
  const db = path.join(to, DB_FILE);
  if (!fs.existsSync(db)) return `${a.size} entries`;
  const result = deps.integrityCheck(db);
  if (result === null)
    return `${a.size} entries (integrity check skipped: node:sqlite unavailable)`;
  if (result !== "ok") throw new Error(`PRAGMA integrity_check: ${result}`);
  return `${a.size} entries, database integrity ok`;
}

// Opens the copy read-write: a WAL-mode DB left by a killed server needs its
// -wal/-shm written to open, and checkpointing the copy only touches the copy.
function integrityCheck(file) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return null;
  }
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return Object.values(db.prepare("PRAGMA integrity_check").get())[0];
  } finally {
    db.close();
  }
}

/**
 * NODE_EXTRA_CA_CERTS is the one stored absolute path into the data dir: the
 * MITM manager persists it with `setx` (Windows) and `launchctl setenv` (macOS).
 * Point it at the moved cert. The next MITM start rewrites it anyway.
 */
function caEnvCommands(legacy, target, platform, deps) {
  let current;
  if (platform === "win32") current = deps.env[CA_ENV];
  else if (platform === "darwin") {
    try {
      current = deps.exec("launchctl", ["getenv", CA_ENV]).trim();
    } catch {
      return [];
    }
  } else return [];
  const win = platform === "win32";
  const prefix = legacy + (win ? path.win32.sep : path.posix.sep);
  // Windows paths are case-insensitive.
  const fold = (s) => (win ? s.toLowerCase() : s);
  if (!current || !fold(current).startsWith(fold(prefix))) return [];
  const next = target + current.slice(legacy.length);
  return [
    platform === "win32" ? ["setx", [CA_ENV, next]] : ["launchctl", ["setenv", CA_ENV, next]],
  ];
}

function stamp(now) {
  return now().toISOString().replace(/[:.]/g, "-");
}

// A file (not a dir) at the target counts as occupied.
function isEmptyOrMissing(dir) {
  if (!fs.existsSync(dir)) return true;
  return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0;
}

function notEmptyError(target) {
  return new Error(
    `${target} already exists and is not empty. If an earlier migrate copied the data there, check it and remove the legacy dir yourself; otherwise move ${target} aside first`,
  );
}

/**
 * A failed copy must not stay at the target, or the resolver would prefer it
 * to the intact legacy dir. Move it aside; if that fails (e.g. a Windows file
 * lock), remove it: it is our own partial copy, not user data.
 */
function discardCopy(target, deps) {
  if (!fs.existsSync(target)) return "";
  const failed = `${target}.failed-${stamp(deps.now)}`;
  try {
    fs.renameSync(target, failed);
    return `The partial copy is at ${failed}.`;
  } catch {}
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return "The partial copy was removed.";
  } catch {
    return `Delete ${target} before starting ${BRAND.name}, or it will be used instead of the legacy dir.`;
  }
}

function migrate(opts, deps) {
  const { log } = deps;
  const dirOpts = { platform: deps.platform, env: deps.env, homedir: deps.homedir };
  const legacy = legacyDataDir(dirOpts);
  const target = brandDataDir(dirOpts);

  if (deps.env.DATA_DIR) {
    throw new Error(`DATA_DIR is set (${deps.env.DATA_DIR}); there is nothing to migrate`);
  }
  if (!fs.existsSync(legacy)) {
    log(
      fs.existsSync(target)
        ? `already migrated: ${target}`
        : `nothing to migrate: ${legacy} not found`,
    );
    return;
  }
  if (!fs.statSync(legacy).isDirectory()) throw new Error(`${legacy} is not a directory`);
  const running = runningReasons([legacy, target], opts.port, deps);
  if (running.length) {
    throw new Error(
      `${BRAND.name} may be running: ${running.join("; ")}. Stop it (Ctrl+C in its terminal, or Quit in the tray) and try again.`,
    );
  }
  if (!isEmptyOrMissing(target)) throw notEmptyError(target);
  const caCommands = caEnvCommands(legacy, target, deps.platform, deps);

  if (opts.dryRun) {
    log(`Plan (dry run, nothing changed):`);
    log(`  move ${legacy}`);
    log(`    to ${target}`);
    log(
      `  (across devices: copy, verify, then rename the legacy dir to ${legacy}.migrated-<stamp>)`,
    );
    for (const [cmd, args] of caCommands) log(`  run: ${cmd} ${args.join(" ")}`);
    return;
  }

  // An empty target would block rename on Windows; it holds nothing to lose.
  try {
    if (fs.existsSync(target)) fs.rmdirSync(target);
  } catch (e) {
    if (e?.code === "ENOTEMPTY" || e?.code === "EEXIST") throw notEmptyError(target);
    throw e;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    deps.rename(legacy, target);
    log(`Moved ${legacy} → ${target}`);
  } catch (e) {
    if (e?.code !== "EXDEV") throw e;
    log(`${legacy} and ${target} are on different devices; copying…`);
    let summary;
    try {
      deps.cp(legacy, target);
      summary = verifyCopy(legacy, target, deps);
    } catch (err) {
      throw new Error(
        `copy failed (${err.message}); ${legacy} is untouched. ${discardCopy(target, deps)}`,
      );
    }
    const kept = `${legacy}.migrated-${stamp(deps.now)}`;
    try {
      deps.rename(legacy, kept);
    } catch (err) {
      throw new Error(
        `the copy at ${target} is complete and verified, but ${legacy} could not be renamed (${err.message}). Rename or remove ${legacy} yourself; ${target} is already in use.`,
      );
    }
    log(`Copied ${legacy} → ${target} (${summary}); the original is kept at ${kept}`);
  }
  for (const [cmd, args] of caCommands) {
    try {
      deps.exec(cmd, args);
      log(`Updated ${CA_ENV} to the new data dir`);
    } catch (e) {
      log(`Could not update ${CA_ENV} (${e.message}); it is rewritten the next time MITM starts`);
    }
  }
  log(`Done. Start ${BRAND.name} again.`);
}

function defaultDeps() {
  return {
    env: process.env,
    platform: process.platform,
    homedir: require("os").homedir(),
    rename: fs.renameSync,
    cp: (from, to) =>
      fs.cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true }),
    exec: (cmd, args) =>
      execFileSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 5000 }),
    findListeningPids,
    isAlive,
    integrityCheck,
    now: () => new Date(),
    log: (msg) => console.log(msg),
  };
}

/** Exit code: 0 done/no-op, 1 refused or failed, 2 usage error. */
async function run(argv, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  if (!AVAILABLE) {
    console.error(`❌ data migrate is only available in ${BRAND.name} builds`);
    return 2;
  }
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`❌ ${e.message}\n${HELP}`);
    return 2;
  }
  if (opts.help) {
    deps.log(HELP);
    return 0;
  }
  try {
    migrate(opts, deps);
    return 0;
  } catch (e) {
    console.error(`❌ ${e.message}`);
    return 1;
  }
}

module.exports = { AVAILABLE, HELP, parseArgs, caEnvCommands, run };
