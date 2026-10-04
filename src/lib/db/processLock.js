import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const WRITER_LOCK_NAME = "db-writer.lock";
// Symbol-keyed so separately bundled modules and dev HMR share one registry.
const key = Symbol.for(`tokenhop.writerLocks.${process.pid}`);
globalThis[key] ??= { owners: new Map(), exitHook: false };
const state = globalThis[key];

function fail(code, message) {
  throw Object.assign(new Error(`[db-writer-lock] ${message}`), { code });
}

/** True during Next build/prerender: the writer lock is never created there. */
export function isStartupExcludedBuildPhase() {
  return ["phase-production-build", "phase-export", "phase-static"].includes(
    process.env.NEXT_PHASE,
  );
}

function readOwner(file) {
  let owner;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      fail("DATA_DIR_UNVERIFIABLE_LOCK", "Lock must be a regular file");
    owner = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    fail("DATA_DIR_UNVERIFIABLE_LOCK", "Lock owner unreadable; manual inspection required");
  }
  if (
    !Number.isSafeInteger(owner?.pid) ||
    owner.pid <= 0 ||
    typeof owner.token !== "string" ||
    !owner.token
  )
    fail("DATA_DIR_UNVERIFIABLE_LOCK", "Lock owner invalid; manual inspection required");
  return owner;
}

function sameOwner(a, b) {
  return Boolean(a && b && a.pid === b.pid && a.token === b.token);
}

// Process start time (clock ticks since boot, /proc stat field 22): pins a pid to
// one incarnation. ponytail: Linux-only; null elsewhere falls back to kill -0.
function startTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null; // comm may hold spaces
  } catch {
    return null;
  }
}

// A new container reuses small pids, so a lock left by a killed predecessor can
// name a live stranger (or this very process). Pid alone proves nothing there.
function dead(owner) {
  const { pid } = owner;
  const now = owner.start && startTime(pid);
  if (now && now !== owner.start) return true; // pid recycled by a different process
  try {
    process.kill(pid, 0); // Existence probe only. Never terminate another process.
    return false;
  } catch (err) {
    // EPERM/unknown errors are unverifiable, never evidence of death.
    return err.code === "ESRCH";
  }
}

/** Mutations serialize behind a short-lived mkdir guard on one filesystem.
 * ponytail: a crash mid-mutation leaves a guard requiring manual inspection.
 * A same-host PID namespace is assumed; this is not a distributed lock.
 */
function guarded(file, fn) {
  const guard = `${file}.guard`;
  try {
    fs.mkdirSync(guard, { mode: 0o700 });
  } catch (err) {
    if (err.code === "EEXIST")
      fail(
        "DB_WRITER_LOCK_HELD",
        `Ownership guard busy at ${guard}; retry startup or remove it manually after verifying no process is starting (rmdir ${guard})`,
      );
    throw err;
  }
  try {
    return fn();
  } finally {
    fs.rmdirSync(guard);
  }
}

/**
 * Exclusive one-writer claim over a DATA_DIR, held for the caller's process
 * lifetime (not readiness): acquired before any adapter open/migrate and
 * released at process exit (and never on startup failure). Returns a handle
 * { pid, token, path } or null during build/prerender phases.
 *
 * Read-only handles opened outside this driver need no claim; this function
 * gates writable use only. Idempotent per process: a second call returns the
 * same handle. A stale lock (owner PID verifiably dead via kill -0 ESRCH) is
 * replaced under the guard; an owner that cannot be verified is never deleted
 * or bypassed — the call fails (DATA_DIR_UNVERIFIABLE_LOCK / DB_WRITER_LOCK_HELD).
 */
export function acquireExclusiveWriterLock(dataDir) {
  if (isStartupExcludedBuildPhase()) return null;
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(fs.realpathSync(dataDir), WRITER_LOCK_NAME);
  const existing = state.owners.get(file);
  if (existing) {
    if (!sameOwner(readOwner(file), existing))
      fail("DB_WRITER_LOCK_FOREIGN", "Lock no longer owned by this process");
    return existing;
  }
  const owner = guarded(file, () => {
    const current = readOwner(file);
    if (current) {
      if (!dead(current))
        fail("DB_WRITER_LOCK_HELD", `DATA_DIR already owned by pid ${current.pid}`);
      // Unlink is safe only with a verifiably dead owner and under the guard,
      // so two contenders cannot both replace each other's fresh claim.
      fs.unlinkSync(file);
    }
    const claim = {
      pid: process.pid,
      start: startTime(process.pid),
      token: randomUUID(),
      path: file,
    };
    fs.writeFileSync(file, JSON.stringify(claim), { flag: "wx", mode: 0o600 });
    state.owners.set(file, claim);
    return claim;
  });
  if (!state.exitHook) {
    state.exitHook = true;
    // 'exit' runs after beforeExit/signal flushers. Not released on SIGTERM:
    // sql.js signal listeners may keep the process alive and still writing.
    process.on("exit", () => {
      for (const held of state.owners.values()) {
        try {
          releaseExclusiveWriterLock(held);
        } catch {} // Leave a foreign/unverifiable lock file intact, never delete.
      }
    });
  }
  return owner;
}

/**
 * Explicit release for callers that fully stop writing before exit. Throws
 * DB_WRITER_LOCK_FOREIGN when the on-disk owner is not exactly this handle's
 * claim; never deletes a lock this process cannot prove it owns.
 */
export function releaseExclusiveWriterLock(handle) {
  if (!handle) return false;
  const held = state.owners.get(handle.path);
  if (!held || !sameOwner(held, handle)) fail("DB_WRITER_LOCK_FOREIGN", "Not this process's claim");
  return guarded(handle.path, () => {
    if (!sameOwner(readOwner(handle.path), held))
      fail("DB_WRITER_LOCK_FOREIGN", "Lock owner changed; leaving file intact");
    fs.unlinkSync(handle.path);
    state.owners.delete(handle.path);
    return true;
  });
}

/** Whether this process holds the claim for a data dir. */
export function holdsExclusiveWriterLock(dataDir) {
  try {
    return state.owners.has(path.join(fs.realpathSync(dataDir), WRITER_LOCK_NAME));
  } catch {
    return false;
  }
}
