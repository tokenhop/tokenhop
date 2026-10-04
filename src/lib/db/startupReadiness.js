// YAN-363: startup ownership + readiness coordinator for gateway keys.
// Production order, all before timers/model sync/layout initializeApp and any
// request handling: DATA_DIR writer lock -> adapter open/migrate (driver.js
// claims the lock itself) -> resolve multi-user exactly once (env override
// else stored setting) -> strict owner bootstrap when enabled -> activate.
// A rejection is sticky: this process must serve nothing and start no
// background writers until the next process start.
//
// credentialSinksVetted: true is the startup-only integration contract from
// the YAN-363 credential-sink review — an attestation of this call site, never
// a request-time flag. There is no config switch that can flip activation on.
//
// Import graph (no cycles, no self-readiness): instrumentation ->
// startupReadiness -> {processLock, dataDir} at module scope; driver,
// featureSwitch, users/bootstrap and activateGatewayKeys are imported lazily
// inside the run and none of them import startupReadiness.
import { DATA_DIR } from "../dataDir.js";
import { acquireExclusiveWriterLock, isStartupExcludedBuildPhase } from "./processLock.js";

// Symbol-keyed global: survives Next dev HMR and separately bundled copies.
const SYM = Symbol.for("tokenhop.gatewayKeyStartup");
globalThis[SYM] ??= { promise: null, ready: false, activation: null };
const state = globalThis[SYM];

/** Production activation path (YAN-363 final wiring). Runs under the lock. */
async function defaultActivation(db) {
  // Resolved once per boot: runtime env override, else stored setting.
  const { isMultiUserEnabled } = await import("../users/featureSwitch.js");
  const enabled = await isMultiUserEnabled();
  if (enabled) {
    // Strict: creates/verifies the actual owner + Default workspace and
    // throws on failure (permissive request callers keep the swallow).
    const { ensureOwnerBootstrap } = await import("../users/bootstrap.js");
    await ensureOwnerBootstrap({ throwOnError: true });
  }
  const { activateGatewayKeys } = await import("./activateGatewayKeys.js");
  // enabled=false on legacy: skipped-off — no owner, master key or backup.
  // enabled=true on legacy: hash migration (irreversible) with the validated
  // pre-mutation backup. Already hashed: validates the durable root + schema
  // and returns already-hashed ready, whatever the switch says.
  const result = await activateGatewayKeys(db, {
    enabled,
    beforeServing: true,
    credentialSinksVetted: true,
  });
  state.activation = result;
  return result;
}

/**
 * @param {{ activate?: (db: object) => Promise<unknown>, dataDir?: string,
 *   acquireLock?: (dir: string) => unknown, openDb?: () => Promise<object> }} [hooks]
 *   Test seams; production passes none and gets defaultActivation above.
 * @returns {Promise<void>} sticky per process; no-op during build/prerender.
 */
export function ensureGatewayKeyStartup(hooks = {}) {
  if (isStartupExcludedBuildPhase()) return Promise.resolve();
  if (state.promise) return state.promise;
  const acquire = hooks.acquireLock ?? acquireExclusiveWriterLock;
  const openDb = hooks.openDb ?? (async () => (await import("./driver.js")).getAdapter());
  const activate = hooks.activate ?? defaultActivation;
  state.promise = (async () => {
    await acquire(hooks.dataDir ?? DATA_DIR); // hold the lock before any open
    const db = await openDb();
    await activate(db);
    state.ready = true;
  })();
  state.promise.catch(() => {}); // sticky reject must never be an unhandled rejection
  return state.promise;
}

/** Sticky promise; rejects with STARTUP_NOT_INITIALIZED if never started. */
export function whenGatewayKeyStartupReady() {
  if (isStartupExcludedBuildPhase()) return Promise.resolve();
  return (
    state.promise ??
    Promise.reject(
      Object.assign(new Error("[gateway-key-startup] ensureGatewayKeyStartup() never called"), {
        code: "STARTUP_NOT_INITIALIZED",
      }),
    )
  );
}

/** True only after lock + open + activation all succeeded. */
export function isGatewayKeyStartupReady() {
  return state.ready;
}

/** Last activation result ({ status, isReady, ... }) or null. */
export function getGatewayKeyActivation() {
  return state.activation;
}

/** Test seam only. */
export function resetGatewayKeyStartupForTests() {
  state.promise = null;
  state.ready = false;
  state.activation = null;
}
