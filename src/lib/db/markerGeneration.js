// YAN-1106 per-adapter write-generation tracker, shared by the marker readers
// (apiKeyState.js, credentialEncryptionState.js, apiKeyHashKey.js). No imports:
// this module must stay cycle-free like apiKeyState.js.
//
// The marker readers are hot (several per gateway request). Each adapter
// carries a counter that moves on EVERY
// write that passes through it (run/exec/transaction), so a memoized read is
// valid exactly while no write has happened since it was taken. The counter is
// a pure invalidation signal: any write, marker or not, moves it, and a moved
// counter always means "read the database again". One DATA_DIR has exactly one
// writer process (processLock), so no out-of-process write can bypass it.
// Adapters we cannot observe (no run(), frozen) are never memoized, so they
// still read live. Writes are only ever issued through run/exec/transaction;
// tests/unit/marker-generation.test.js scans src for any other write path.

const TRACK_KEY = Symbol.for("tokenhop.markerGeneration");
globalThis[TRACK_KEY] ??= new WeakMap(); // db -> tracker (shared across bundles)
const trackers = globalThis[TRACK_KEY];
const MUTATORS = ["run", "exec", "transaction"];
const MAX_REWRAPS = 8;

// The wrapper bumps AFTER the call (and on throw): a read taken inside a
// transaction callback is invalidated when the transaction ends or rolls back.
function wrapMutator(tracker, orig) {
  return function wrapped(...args) {
    try {
      return orig.apply(this, args);
    } finally {
      tracker.gen++;
    }
  };
}

function hook(db, tracker, name) {
  const wrapped = wrapMutator(tracker, db[name]);
  db[name] = wrapped;
  tracker.hooks[name] = wrapped;
}

function trackerOf(db) {
  if (db === null || typeof db !== "object") return null;
  let tracker = trackers.get(db);
  if (tracker === null) return null; // known-unobservable
  if (!tracker) {
    if (typeof db.run !== "function") {
      trackers.set(db, null); // read-only handle: not ours to observe
      return null;
    }
    tracker = { gen: 0, hooks: {}, memo: new Map(), rewraps: 0 };
    try {
      for (const name of MUTATORS) if (typeof db[name] === "function") hook(db, tracker, name);
    } catch {
      trackers.set(db, null);
      return null;
    }
    trackers.set(db, tracker);
    return tracker;
  }
  // A mutator we installed was replaced (a spy, a maintenance gate wrapped over
  // us): re-wrap and treat the swap itself as a write. Fail toward re-reading.
  for (const name of MUTATORS) {
    if (typeof db[name] === "function" && db[name] !== tracker.hooks[name]) {
      // Bounded: a mutator that keeps being replaced would stack wrappers
      // without limit, so past the bound the adapter is simply never memoized.
      if (++tracker.rewraps > MAX_REWRAPS) {
        trackers.set(db, null);
        return null;
      }
      try {
        hook(db, tracker, name);
      } catch {
        trackers.set(db, null);
        return null;
      }
      tracker.gen++;
    }
  }
  return tracker;
}

/**
 * Current write generation, or null when the adapter cannot be observed.
 * @internal Tests and diagnostics only; runtime code uses memoizeUntilWrite.
 */
export function markerGeneration(db) {
  return trackerOf(db)?.gen ?? null;
}

/**
 * Force every memoized marker read for this adapter to re-read.
 * @internal In-process invalidation hooks (key rotation, import) and tests only.
 */
export function invalidateMarkerCache(db) {
  const tracker = trackerOf(db);
  if (tracker) tracker.gen++;
}

/**
 * Memoize a sync, side-effect-free read while no write has passed through the
 * adapter. Throws are never cached. Untracked adapters always recompute.
 * Callers hand out copies: the cached value is shared.
 */
export function memoizeUntilWrite(db, name, compute) {
  const tracker = trackerOf(db);
  if (!tracker) return compute();
  const hit = tracker.memo.get(name);
  if (hit && hit.gen === tracker.gen) return hit.value;
  const gen = tracker.gen;
  const value = compute();
  if (tracker.gen === gen) tracker.memo.set(name, { gen, value });
  return value;
}
