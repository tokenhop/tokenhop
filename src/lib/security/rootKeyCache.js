// YAN-1106 root-file memo for loadMasterKey (masterKey.js owns the validated
// read; this module owns only the cache). The validated 32-byte root is reused
// only while fresh lstat fingerprints of the keys directory AND the file are
// unchanged (dev, ino, size, mode, mtime, ctime; bigint stats so 64-bit inodes
// and nanosecond times compare exactly). An atomic rename publishes a new inode
// and any in-place write moves mtime/ctime, so a rotated or replaced root is
// never served. Racy-clean rule: a file modified within RACY_MS of the read is
// not cached (a same-tick rewrite could keep an identical fingerprint). Any
// symlink, type, mode or stat failure drops the entry and the caller takes the
// full validating path, which keeps the original fail-closed errors. The entry
// lives at most ROOT_CACHE_TTL_MS: an unref'd timer zeroes it at expiry even
// when no further request arrives. Callers always receive private copies.
//
// The entry, its timer and the listener registry live in ONE process-wide slot
// (Symbol.for, like markerGeneration.js), so every bundled or HMR-reloaded copy
// of this module shares invalidation and zeroing: a stage/promote in one copy
// drops the root another copy cached. Listeners register under an id so a
// re-evaluated module replaces its previous listener instead of stacking.
import fsSync from "node:fs";
import path from "node:path";

const IS_WINDOWS = process.platform === "win32";
const ROOT_CACHE_TTL_MS = 30_000;
const ROOT_RACY_MS = 2_000;

const CACHE_KEY = Symbol.for("tokenhop.masterKeyCache");
globalThis[CACHE_KEY] ??= { entry: null, timer: null, listeners: new Map() };
const cache = globalThis[CACHE_KEY];

// Derived caches (the unwrapped API-key hash key) depend on the root. They
// register here and are told whenever a cached root is dropped, and on every
// explicit root change (stage, promote, clear), cached or not.
/**
 * Register a callback run when the root may have changed.
 * @param {() => void} listener
 * @param {unknown} [id] registration id; the same id replaces the previous listener
 * @returns {() => void} unregister function
 * @internal Used by derived caches (apiKeyHashKey.js) and tests only.
 */
export function onMasterKeyChange(listener, id = listener) {
  cache.listeners.set(id, listener);
  return () => {
    if (cache.listeners.get(id) === listener) cache.listeners.delete(id);
  };
}

function notifyRootChange() {
  for (const listener of [...cache.listeners.values()]) listener();
}

/** Zero and drop the cached root (and tell listeners if one was held). */
export function dropRootEntry() {
  if (cache.timer) clearTimeout(cache.timer);
  cache.timer = null;
  const had = cache.entry !== null;
  if (cache.entry) cache.entry.key.fill(0);
  cache.entry = null;
  if (had) notifyRootChange();
}

/**
 * Explicit change (stage/promote/clear): derived caches drop even when the
 * racy-clean rule kept the root itself out of the cache.
 */
export function rootChanged() {
  dropRootEntry();
  notifyRootChange();
}

/**
 * Drop the memoized root and notify derived caches.
 * @internal In-process rotation/staging and tests only; not a runtime API.
 */
export function clearMasterKeyCache() {
  rootChanged();
}

const fingerprintOf = (s) => `${s.dev}:${s.ino}:${s.size}:${s.mode}:${s.mtimeNs}:${s.ctimeNs}`;

/** Null when the keys dir + file pair cannot be proven plain (missing, symlink, wrong type). */
export function rootFingerprint(file) {
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

/** The live cache entry for `file` if its fingerprint still matches, else null (and dropped). */
export function cachedRoot(file) {
  const entry = cache.entry;
  if (!entry) return null;
  if (entry.path !== file || Date.now() - entry.at >= ROOT_CACHE_TTL_MS) {
    dropRootEntry();
    return null;
  }
  const now = rootFingerprint(file);
  if (!now || now.dir !== entry.dir || now.file !== entry.file) {
    dropRootEntry();
    return null;
  }
  return entry;
}

/** Remember a root read under `before`'s fingerprint, unless the file changed or is too fresh. */
export function rememberRoot(file, before, kid, key) {
  const after = rootFingerprint(file);
  if (!before || !after || before.dir !== after.dir || before.file !== after.file) return;
  const at = Date.now();
  if (at - after.changedAt < ROOT_RACY_MS) return;
  dropRootEntry();
  cache.entry = { path: file, at, kid, dir: after.dir, file: after.file, key: Buffer.from(key) };
  cache.timer = setTimeout(dropRootEntry, ROOT_CACHE_TTL_MS);
  cache.timer.unref?.();
}
