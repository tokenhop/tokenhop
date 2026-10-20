// Private staging + durability helpers for bounded-memory snapshot transfer.
// No DB imports: this module only touches the filesystem under DB_DIR/staging.
import fs from "node:fs";
import path from "node:path";
import { DB_DIR, STAGING_DIR } from "./paths.js";

const IS_WIN = process.platform === "win32";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// Orphaned atomic-write temp files left by a crashed writer: `<DATA_FILE>.<pid>.<rand>.tmp`.
const DB_TMP_RE = /^data\.sqlite\.(\d+)\.[a-z0-9]*\.tmp$/;

function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function ensureStagingRoot() {
  fs.mkdirSync(STAGING_DIR, { recursive: true, mode: DIR_MODE });
  const st = fs.lstatSync(STAGING_DIR);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error("Staging root is not a directory");
  }
  if (!IS_WIN) fs.chmodSync(STAGING_DIR, DIR_MODE);
}

/**
 * Create a private per-operation directory `STAGING_DIR/<prefix>XXXXXX` (0700).
 * @param {string} prefix
 * @returns {string} absolute directory path
 */
export function makeStagingDir(prefix) {
  ensureStagingRoot();
  const base = path.join(STAGING_DIR, String(prefix || "tmp-"));
  // mkdtemp honours the process umask; narrow it so the dir is never group/world-visible.
  const prev = IS_WIN ? null : process.umask(0o077);
  let dir;
  try {
    dir = fs.mkdtempSync(base);
  } finally {
    if (prev !== null) process.umask(prev);
  }
  if (!IS_WIN) fs.chmodSync(dir, DIR_MODE);
  return dir;
}

/**
 * Create a new 0600 file (fails if it exists). Returns the fd.
 * @param {string} file
 * @returns {number}
 */
export function openPrivateFileSync(file) {
  const fd = fs.openSync(file, "wx", FILE_MODE);
  try {
    if (!IS_WIN) fs.fchmodSync(fd, FILE_MODE);
  } catch (e) {
    try {
      fs.closeSync(fd);
    } catch {}
    throw e;
  }
  return fd;
}

/** fsync a directory so a rename inside it is durable. No-op on Windows. */
export function fsyncDirSync(dir) {
  if (IS_WIN) return;
  const dirFd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

function writeAll(fd, bytes) {
  let off = 0;
  while (off < bytes.length) {
    off += fs.writeSync(fd, bytes, off, bytes.length - off, null);
  }
}

/**
 * Atomically publish `bytes` at `dest`: sibling temp (wx, 0600) → write → fsync → rename → fsync dir.
 * The temp file is removed on any failure.
 * @param {string} dest
 * @param {Uint8Array | string} bytes
 * @param {{ mode?: number }} [opts]
 */
export function publishDurableSync(dest, bytes, { mode = FILE_MODE } = {}) {
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  const dir = path.dirname(dest);
  const rand = Math.random().toString(36).slice(2, 10);
  const tmp = path.join(dir, `.${path.basename(dest)}.${process.pid}.${rand}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, "wx", mode);
    if (!IS_WIN) fs.fchmodSync(fd, mode);
    writeAll(fd, buf);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, dest);
    fsyncDirSync(dir);
  } catch (e) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw e;
  }
}

/**
 * Best-effort recursive removal of a staging directory. Refuses (returns false)
 * any path that is not strictly inside STAGING_DIR. Does not follow symlinks.
 * @param {string} dir
 * @returns {boolean} true when removal was attempted and did not throw
 */
export function removeStagingDir(dir) {
  if (typeof dir !== "string" || !dir || !isInside(STAGING_DIR, dir)) return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

const processStartMs = () => Date.now() - process.uptime() * 1000;

/**
 * Boot sweep: remove everything under STAGING_DIR (keeping the root) plus orphaned
 * `data.sqlite.<pid>.<rand>.tmp` files from other pids (or from this pid but older than this process). Safe because processLock
 * guarantees a single writer per DATA_DIR. Never follows symlinks.
 * @returns {number} count of removed entries
 */
export function sweepStagingDir() {
  let removed = 0;

  let rootStat = null;
  try {
    rootStat = fs.lstatSync(STAGING_DIR);
  } catch {}
  if (rootStat?.isDirectory() && !rootStat.isSymbolicLink()) {
    for (const name of fs.readdirSync(STAGING_DIR)) {
      try {
        // rmSync does not dereference: a symlink child is unlinked, never traversed.
        fs.rmSync(path.join(STAGING_DIR, name), { recursive: true, force: true });
        removed++;
      } catch {}
    }
  }

  let names = [];
  try {
    names = fs.readdirSync(DB_DIR);
  } catch {}
  for (const name of names) {
    const m = DB_TMP_RE.exec(name);
    if (!m) continue;
    const file = path.join(DB_DIR, name);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile()) continue;
      // Our own pid: a temp file older than this process is a leftover of a
      // previous incarnation (containers reuse low pids). Newer ones are live.
      if (Number(m[1]) === process.pid && st.mtimeMs >= processStartMs()) continue;
      fs.rmSync(file, { force: true });
      removed++;
    } catch {}
  }
  return removed;
}

let freeBytesProbe = null;
let warnedNoStatfs = false;

/** Test hook: replace the free-bytes probe (`fn(dir) => number | null`), or pass null to reset. */
export function __setFreeBytesProbeForTests(fn) {
  freeBytesProbe = typeof fn === "function" ? fn : null;
}

function nearestExisting(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}

/**
 * Free bytes available to unprivileged writers at `dir` (nearest existing ancestor).
 * Returns null when it cannot be determined (no statfsSync, or statfs failed).
 * @param {string} dir
 * @returns {number | null}
 */
export function freeBytes(dir) {
  if (freeBytesProbe) return freeBytesProbe(dir);
  if (typeof fs.statfsSync !== "function") {
    if (!warnedNoStatfs) {
      warnedNoStatfs = true;
      console.warn("[staging] fs.statfsSync is unavailable; disk space checks are skipped");
    }
    return null;
  }
  try {
    const s = fs.statfsSync(nearestExisting(dir));
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * Device id (st_dev) of `dir` (nearest existing ancestor), or null if unknown.
 * @param {string} dir
 * @returns {number | bigint | null}
 */
export function deviceOf(dir) {
  try {
    return fs.statSync(nearestExisting(dir)).dev;
  } catch {
    return null;
  }
}
