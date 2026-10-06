// YAN-363: startup ownership + readiness coordinator for gateway keys.
// YAN-365 extends the same single-owner startup chain (see defaultActivation)
// Production order, all before timers/model sync/layout initializeApp and any
// request handling: DATA_DIR writer lock -> adapter open/migrate (driver.js
// claims the lock itself) -> pending credential-key rotation recovery ->
// strict state + root prep for established encryption -> resolve multi-user
// exactly once (env override else stored setting) -> strict owner bootstrap
// when enabled -> gateway-key activation -> credential-encryption activation.
// A rejection is sticky: this process must serve nothing and start no
// background writers until the next process start.
//
// credentialSinksVetted: true is the startup-only integration contract from
// the YAN-363 credential-sink review — an attestation of this call site, never
// a request-time flag. There is no config switch that can flip activation on.
//
// Import graph (no cycles, no self-readiness): instrumentation ->
// startupReadiness -> {processLock, dataDir} at module scope; driver,
// featureSwitch, users/bootstrap, masterKey, the credential state reader and
// both activators are imported lazily inside the run and none of them import
// startupReadiness.
import { DATA_DIR } from "../dataDir.js";
import { acquireExclusiveWriterLock, isStartupExcludedBuildPhase } from "./processLock.js";

// Symbol-keyed global: survives Next dev HMR and separately bundled copies.
const SYM = Symbol.for("tokenhop.gatewayKeyStartup");
globalThis[SYM] ??= { promise: null, ready: false, activation: null };
const state = globalThis[SYM];

// Production activation path (YAN-363 final wiring, YAN-365 ordering). Runs
// under the lock.
async function defaultActivation(db) {
  // 1. Credential-key rotation recovery first (D12): pending file/DB rotation
  //    states resolve before any other startup work. Recovery is DB-marker
  //    first; failures poison and retain the recovery artifacts.
  const { readCredentialEncryptionState } = await import("./credentialEncryptionState.js");
  // Encrypted storage always runs recovery: it finishes a pending rotation
  // from the DB marker, or removes an unreferenced pre-commit stage. Failure
  // poisons admission and rejects this boot stickily. Never-enabled installs
  // skip it entirely (no key duty).
  if (readCredentialEncryptionState(db, { strict: true }).storage === "encrypted") {
    const { recoverKeyRotation } = await import("../security/keyRotation.js");
    await recoverKeyRotation(db);
  }
  const preState = readCredentialEncryptionState(db, { strict: true });

  // 2. Strict state + root prep for established storage, before the switch
  //    read: a missing/wrong root rejects stickily here (no regeneration, no
  //    owner/bootstrap work first). Never-enabled installs stay untouched.
  if (preState.storage === "encrypted") {
    const { loadMasterKey } = await import("../security/masterKey.js");
    await loadMasterKey({ create: false, expectedKid: preState.kekKid });
  }

  // 3. Raw switch read, resolved once per boot: env override else setting.
  const { isMultiUserEnabled } = await import("../users/featureSwitch.js");
  const enabled = await isMultiUserEnabled();
  if (enabled) {
    // 4. Strict: creates/verifies the actual owner & Default workspace and
    //    throws on failure (permissive request callers keep the swallow).
    const { ensureOwnerBootstrap } = await import("../users/bootstrap.js");
    await ensureOwnerBootstrap({ throwOnError: true });
  }

  // 5. Gateway-key activation.
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

  // 6. Credential-encryption activation. Established storage stays
  //    established and finishes pending cleanup whatever the switch says;
  //    a pristine install with the switch off stays pristine (zero mutation).
  const { activateCredentialEncryption } = await import("./activateCredentialEncryption.js");
  await activateCredentialEncryption(db, { enabled, beforeServing: true });
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
