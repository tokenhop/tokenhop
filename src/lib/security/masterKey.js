import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { constants } from "node:fs";
import path from "node:path";
import { getDataDir } from "../dataDir.js";

const HASH_INFO = "tokenhop/api-key-hash";
const MASTER_ENV = "TOKENHOP_MASTER_KEY";
const IS_WINDOWS = process.platform === "win32";
const MASTER_LABEL = "master key file";

// MASTER_KEY_INVALID keeps message text identical; callers may branch on code.
// The two "missing" failures keep their established KEY_MISSING code (the
// activation/startup contract treats that exact code as root-unavailable).
function fail(message, code = "MASTER_KEY_INVALID") {
  const err = new Error(`[master-key] ${message}`);
  err.code = code;
  throw err;
}

function assertMaster(value) {
  if (!Buffer.isBuffer(value) || value.length !== 32) fail("master key must be a 32-byte Buffer");
}

function decodeStrictEnv(value) {
  if (typeof value !== "string") fail("env master key must be canonical base64 of 32 bytes");
  let raw;
  try {
    raw = Buffer.from(value, "base64");
  } catch {
    fail("env master key must be canonical base64 of 32 bytes");
  }
  if (raw.length !== 32 || raw.toString("base64") !== value) {
    fail("env master key must be canonical base64 of 32 bytes");
  }
  return raw;
}

function checkKid(kid, expectedKid) {
  if (expectedKid != null && kid !== expectedKid) fail("master key id mismatch");
}

function assertPrivateMode(stat, label) {
  // Unix permission bits do not exist on Windows; creation modes stay best-effort there.
  if (IS_WINDOWS) return;
  // Fail closed on any group/other access instead of silently chmodding existing paths.
  if ((stat.mode & 0o077) !== 0) fail(`${label} must not be group/other accessible`);
}

async function lstatNoFollow(target, label) {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "missing" : "error", error };
  }
  if (stat.isSymbolicLink()) fail(`${label} must not be a symlink`);
  return { status: "ok", stat };
}

async function statKeysDir(dir) {
  const seen = await lstatNoFollow(dir, "keys directory");
  if (seen.status === "missing") return seen;
  if (seen.status === "error") return seen;
  if (!seen.stat.isDirectory()) fail("keys path must be a directory");
  assertPrivateMode(seen.stat, "keys directory");
  return seen;
}

async function ensureKeysDir(dir) {
  // Validate first: an existing unsafe keys dir fails closed here and is
  // never chmodded below.
  const before = await lstatNoFollow(dir, "keys directory");
  if (before.status === "error") throw before.error;
  if (before.status === "ok") {
    if (!before.stat.isDirectory()) fail("keys path must be a directory");
    assertPrivateMode(before.stat, "keys directory");
    return;
  }
  // Missing: create a missing DATA_DIR parent chain recursively, then the keys
  // dir itself non-recursively so the chmod below applies solely to a
  // directory this call created. A concurrent winner (EEXIST) is never
  // chmodded; the validate-after fails closed on a loose raced dir.
  await fs.mkdir(path.dirname(dir), { recursive: true });
  let created = false;
  try {
    await fs.mkdir(dir, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  if (created && !IS_WINDOWS) await fs.chmod(dir, 0o700);
  const seen = await statKeysDir(dir);
  if (seen.status === "missing") fail("keys directory missing after create");
  if (seen.status === "error") throw seen.error;
}

async function syncDir(dir) {
  // Directories cannot be fsynced on Windows. POSIX durability failures propagate.
  if (IS_WINDOWS) return;
  const handle = await fs.open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createExclusive(file, dir) {
  await ensureKeysDir(dir);
  const candidate = crypto.randomBytes(32);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let owned = false;
  try {
    const handle = await fs.open(tmp, "wx", 0o600);
    owned = true;
    try {
      // open mode is masked by umask, so re-assert 0600 on the handle before
      // the bytes are synced and published.
      if (!IS_WINDOWS) await handle.chmod(0o600);
      await handle.writeFile(candidate);
      await handle.sync();
    } finally {
      await handle.close();
    }
    let key = candidate;
    try {
      // Non-overwriting atomic publish of already synced bytes. Never replace
      // or delete an existing root, including corrupt/partial files. Readers
      // see either no entry or the complete 32 bytes.
      await fs.link(tmp, file);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const seen = readValidatedKeyFileSync(file, MASTER_LABEL);
      if (seen.status === "error") throw seen.error;
      if (seen.status !== "ok") fail("master key disappeared during creation");
      key = seen.key;
    }
    await fs.unlink(tmp);
    owned = false;
    // Both winner and loser sync the publication and the keys directory entry.
    await syncDir(dir);
    await syncDir(path.dirname(dir));
    return key;
  } finally {
    // A collision at open('wx') does not make that temp file ours to delete.
    if (owned) await fs.rm(tmp, { force: true });
  }
}

export function deriveApiKeyHashKey(master) {
  assertMaster(master);
  return Buffer.from(crypto.hkdfSync("sha256", master, Buffer.alloc(0), HASH_INFO, 32));
}

export function hashApiKey(raw, hashKey) {
  if (typeof raw !== "string" || raw.length === 0) fail("api key must be a non-empty string");
  if (!Buffer.isBuffer(hashKey) || hashKey.length !== 32) fail("hash key must be a 32-byte Buffer");
  return crypto.createHmac("sha256", hashKey).update(raw).digest("hex");
}

export function masterKeyId(master) {
  assertMaster(master);
  return crypto.createHash("sha256").update(master).digest("hex").slice(0, 16);
}

/** Fresh random 32-byte master (rotation generates its own next root). */
export function randomMasterKey() {
  return crypto.randomBytes(32);
}

// YAN-1106 root-file memo. The validated 32-byte root is reused only while
// fresh lstat fingerprints of the keys directory AND the file are unchanged
// (dev, ino, size, mode, mtime, ctime; bigint stats so 64-bit inodes and
// nanosecond times compare exactly). An atomic rename publishes a new inode and
// any in-place write moves mtime/ctime, so a rotated or replaced root is never
// served. Racy-clean rule: a file modified within RACY_MS of the read is not
// cached (a same-tick rewrite could keep an identical fingerprint). Any
// symlink, type, mode or stat failure drops the entry and takes the full
// validating path, which keeps the original fail-closed errors. The entry
// lives at most ROOT_CACHE_TTL_MS: an unref'd timer zeroes it at expiry even
// when no further request arrives. Callers always receive private copies.
const ROOT_CACHE_TTL_MS = 30_000;
const ROOT_RACY_MS = 2_000;
let rootEntry = null;
let rootTimer = null;

function dropRootEntry() {
  if (rootTimer) clearTimeout(rootTimer);
  rootTimer = null;
  if (rootEntry) rootEntry.key.fill(0);
  rootEntry = null;
}

const fingerprintOf = (s) => `${s.dev}:${s.ino}:${s.size}:${s.mode}:${s.mtimeNs}:${s.ctimeNs}`;

// Null when the pair cannot be proven plain (missing, symlink, wrong type).
function rootFingerprint(file) {
  if (IS_WINDOWS) return null;
  try {
    const dir = fsSync.lstatSync(path.dirname(file), { bigint: true });
    const st = fsSync.lstatSync(file, { bigint: true });
    if (dir.isSymbolicLink() || !dir.isDirectory()) return null;
    if (st.isSymbolicLink() || !st.isFile()) return null;
    const changedNs = st.mtimeNs > st.ctimeNs ? st.mtimeNs : st.ctimeNs;
    return {
      dir: fingerprintOf(dir),
      file: fingerprintOf(st),
      changedAt: Number(changedNs / 1_000_000n),
    };
  } catch {
    return null;
  }
}

function cachedRoot(file) {
  const entry = rootEntry;
  if (!entry) return null;
  if (entry.path !== file || Date.now() - entry.at >= ROOT_CACHE_TTL_MS) return dropRootEntry();
  const now = rootFingerprint(file);
  if (!now || now.dir !== entry.dir || now.file !== entry.file) return dropRootEntry();
  return entry;
}

function rememberRoot(file, before, kid, key) {
  const after = rootFingerprint(file);
  if (!before || !after || before.dir !== after.dir || before.file !== after.file) return;
  const at = Date.now();
  if (at - after.changedAt < ROOT_RACY_MS) return;
  dropRootEntry();
  rootEntry = { path: file, at, kid, dir: after.dir, file: after.file, key: Buffer.from(key) };
  rootTimer = setTimeout(dropRootEntry, ROOT_CACHE_TTL_MS);
  rootTimer.unref?.();
}

/** Drop the memoized root (in-process rotation/staging; also test hook). */
export function clearMasterKeyCache() {
  dropRootEntry();
}

export async function loadMasterKey({ create = false, expectedKid = null } = {}) {
  const env = process.env[MASTER_ENV];
  if (env !== undefined) {
    dropRootEntry(); // env wins: never keep a file root alive behind it
    const key = decodeStrictEnv(env);
    const kid = masterKeyId(key);
    checkKid(kid, expectedKid);
    return { kid, key };
  }
  const file = path.join(getDataDir(), "keys", "master");
  const hit = cachedRoot(file);
  if (hit) {
    checkKid(hit.kid, expectedKid);
    return { kid: hit.kid, key: Buffer.from(hit.key) };
  }
  // Cold path: the full validated read (symlink, type, size, mode checks).
  const before = rootFingerprint(file);
  const seen = readValidatedKeyFileSync(file, MASTER_LABEL);
  if (seen.status === "ok") {
    const kid = masterKeyId(seen.key);
    checkKid(kid, expectedKid);
    rememberRoot(file, before, kid, seen.key);
    return { kid, key: seen.key };
  }
  if (seen.status === "error") throw seen.error;
  // Corrupt/partial roots throw inside readValidatedKeyFileSync and are never
  // unlinked or regenerated, even with create:true.
  if (expectedKid != null) fail("master key missing for expected id", "KEY_MISSING");
  if (!create) fail("master key missing; pass { create: true } to initialize", "KEY_MISSING");
  const key = await createExclusive(file, path.dirname(file));
  return { kid: masterKeyId(key), key };
}

// ─── Sync root primitives (YAN-365 B4 key rotation) ────────────────────────
// The rotation service must not yield between its durable DB commit and file
// publication, so these apply the loader's safety rules synchronously (the
// async loader reads through the same validator):
// exclusive-create staging (0600), no symlink follows, checked size/modes and
// POSIX directory fsync. The async loader semantics above stay unchanged, and
// every runtime caller of loadMasterKey revalidates the root per call (stat
// fingerprint memo above), so a published new root is picked up immediately.

function lstatNoFollowSync(target, label) {
  let stat;
  try {
    stat = fsSync.lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing" };
    return { status: "error", error };
  }
  if (stat.isSymbolicLink()) fail(`${label} must not be a symlink`);
  return { status: "ok", stat };
}

// The keys/ component itself must be a real private directory before the file
// inside it is judged. Single validator shared by loadMasterKey (async API) and
// readMasterKeyFileSync.
function assertKeysDirSync(file) {
  const dirSeen = lstatNoFollowSync(path.dirname(file), "keys directory");
  if (dirSeen.status === "missing") return dirSeen;
  if (dirSeen.status === "error") return dirSeen;
  if (!dirSeen.stat.isDirectory()) fail("keys path must be a directory");
  assertPrivateMode(dirSeen.stat, "keys directory");
  return dirSeen;
}

function readValidatedKeyFileSync(file, label) {
  const dirSeen = assertKeysDirSync(file);
  if (dirSeen.status === "missing") return { status: "missing" };
  if (dirSeen.status === "error") return { status: "error", error: dirSeen.error };
  const seen = lstatNoFollowSync(file, label);
  if (seen.status !== "ok") return seen;
  let fd;
  try {
    fd = fsSync.openSync(
      file,
      IS_WINDOWS ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error?.code === "ELOOP") fail(`${label} must not be a symlink`);
    return error?.code === "ENOENT" ? { status: "missing" } : { status: "error", error };
  }
  try {
    const stat = fsSync.fstatSync(fd);
    if (!stat.isFile()) fail(`${label} must be a regular file`);
    if (stat.size !== 32) fail(`${label} corrupt: expected 32 bytes`);
    assertPrivateMode(stat, label);
    const buffer = Buffer.alloc(32);
    if (fsSync.readSync(fd, buffer, 0, 32, 0) !== 32) {
      fail(`${label} corrupt: expected 32 bytes`);
    }
    return { status: "ok", key: buffer };
  } finally {
    fsSync.closeSync(fd);
  }
}

function ensureKeysDirSync(dir) {
  const before = lstatNoFollowSync(dir, "keys directory");
  if (before.status === "ok") {
    if (!before.stat.isDirectory()) fail("keys path must be a directory");
    assertPrivateMode(before.stat, "keys directory");
    return;
  }
  if (before.status === "error") throw before.error;
  fsSync.mkdirSync(path.dirname(dir), { recursive: true });
  let created = false;
  try {
    fsSync.mkdirSync(dir, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  if (created && !IS_WINDOWS) fsSync.chmodSync(dir, 0o700);
  const after = lstatNoFollowSync(dir, "keys directory");
  if (after.status === "missing") fail("keys directory missing after create");
  if (after.status === "error") throw after.error;
  if (!after.stat.isDirectory()) fail("keys path must be a directory");
  assertPrivateMode(after.stat, "keys directory");
}

function syncDirSync(dir) {
  if (IS_WINDOWS) return;
  const fd = fsSync.openSync(dir, "r");
  try {
    fsSync.fsyncSync(fd);
  } finally {
    fsSync.closeSync(fd);
  }
}

/** `keys/` dir, the master file and the fixed rotation stage path. */
export function masterKeyPaths() {
  const dir = path.join(getDataDir(), "keys");
  return { dir, file: path.join(dir, "master"), stage: path.join(dir, "master.next") };
}

/**
 * Sync validated read of the master root (default) or the staged root
 * (`which = "stage"`). Same safety rules as the async loader; never throws on
 * a missing file — returns `{ status: "missing" }`.
 * @returns {{status:"ok",kid:string,key:Buffer}|{status:"missing"|"error",error?:Error}}
 */
export function readMasterKeyFileSync(which = "master") {
  const paths = masterKeyPaths();
  const file = which === "stage" ? paths.stage : paths.file;
  const label = which === "stage" ? "staged master key file" : "master key file";
  const seen = readValidatedKeyFileSync(file, label);
  if (seen.status !== "ok") return seen;
  return { status: "ok", kid: masterKeyId(seen.key), key: seen.key };
}

/**
 * Exclusive-create the staged next master: 0600 (umask-proof), fsynced file
 * plus keys/ and DATA_DIR directory entries. Never overwrites an existing
 * stage (EEXIST propagates) and never touches the live master.
 * @returns {string} the stage path.
 */
export function stageMasterKeySync(key) {
  assertMaster(key);
  const paths = masterKeyPaths();
  ensureKeysDirSync(paths.dir);
  const fd = fsSync.openSync(paths.stage, "wx", 0o600);
  try {
    if (!IS_WINDOWS) fsSync.fchmodSync(fd, 0o600);
    fsSync.writeFileSync(fd, key);
    fsSync.fsyncSync(fd);
  } finally {
    fsSync.closeSync(fd);
  }
  dropRootEntry();
  syncDirSync(paths.dir);
  syncDirSync(path.dirname(paths.dir));
  return paths.stage;
}

/** Remove the staged next master (pre-commit abort, or post-proof leftover). */
export function removeStagedMasterSync() {
  const paths = masterKeyPaths();
  // Same parent-dir validation as the read: a symlinked/loose keys dir is a
  // config attack, never something we mutate into.
  const dirSeen = assertKeysDirSync(paths.stage);
  if (dirSeen.status === "error") throw dirSeen.error;
  try {
    fsSync.unlinkSync(paths.stage);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return;
  }
  syncDirSync(paths.dir);
}

/** Publish the staged root over master: atomic rename + durable dir sync. */
export function promoteStagedMasterSync() {
  const paths = masterKeyPaths();
  const dirSeen = assertKeysDirSync(paths.stage);
  if (dirSeen.status === "error") throw dirSeen.error;
  fsSync.renameSync(paths.stage, paths.file);
  dropRootEntry();
  syncDirSync(paths.dir);
  syncDirSync(path.dirname(paths.dir));
}
