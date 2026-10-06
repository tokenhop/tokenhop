// YAN-365 maintenance admission and poisoning (adapter-level, sync).
//
// Imports nothing from the driver, barrel, switch, readiness or session: the
// driver installs this on its adapter, never the reverse. State is per
// adapter object, in a WeakMap.
//
// - runCredentialMaintenanceSync(db, fn): the ONLY privilege. The callback is
//   synchronous and lexical: privilege lasts exactly for the duration of `fn`.
//   A callback that returns a thenable is rejected (an await would yield with
//   privilege dropped, so the commit could not be non-yielding).
// - poisonCredentialMaintenance(db, error): uncertain commit/publication. From
//   then on every raw adapter mutation (run/exec/transaction) and every
//   credential use (assertCredentialOperationAllowed) throws until restart.
//   There is no un-poison and no request-reachable bypass flag.
// Module state keyed on globalThis: Next dev HMR module re-evaluation must
// not drop poisoned state (same pattern as driver.js's adapter registry).
const STATES_KEY = Symbol.for("tokenhop.credMaintenance");
if (!globalThis[STATES_KEY]) globalThis[STATES_KEY] = new WeakMap();
const states = globalThis[STATES_KEY]; // adapter -> { depth, poisoned: Error|null, installed }

function fail(code, message, cause) {
  const err = Object.assign(new Error(`[credential-maintenance] ${message}`), { code });
  if (cause !== undefined) {
    err.message = `${err.message}: ${cause.message}`;
    err.cause = cause;
  }
  return err;
}

function stateOf(db) {
  if (db === null || typeof db !== "object") throw fail("ADAPTER_REQUIRED", "adapter required");
  let s = states.get(db);
  if (!s) {
    s = { depth: 0, poisoned: null, installed: false };
    states.set(db, s);
  }
  return s;
}

/** True after poisonCredentialMaintenance; sticky until process restart. */
export function isCredentialMaintenancePoisoned(db) {
  return stateOf(db).poisoned !== null;
}

/** True only inside runCredentialMaintenanceSync's callback. */
export function isInCredentialMaintenance(db) {
  return stateOf(db).depth > 0;
}

/** Throws CREDENTIAL_MAINTENANCE_POISONED once poisoned. Credential use must call this. */
export function assertCredentialOperationAllowed(db) {
  const s = stateOf(db);
  if (s.poisoned) {
    throw fail(
      "CREDENTIAL_MAINTENANCE_POISONED",
      "credential operations are blocked until restart",
      s.poisoned,
    );
  }
}

/**
 * Poison the adapter: uncertain commit/publication. Idempotent; the first
 * cause is kept. Never throws. Installs the admission gate first so adapters
 * created outside the driver's init path (direct createSqlJsAdapter opens in
 * backup/restore/import paths) get their raw mutators wrapped too.
 */
export function poisonCredentialMaintenance(db, error) {
  const s = stateOf(db);
  installCredentialMaintenanceAdmission(db);
  if (!s.poisoned)
    s.poisoned = error instanceof Error ? error : new Error(String(error ?? "poisoned"));
}

/**
 * Run `fn` synchronously with maintenance privilege. Non-reentrant across
 * poison: a poisoned adapter refuses to start new maintenance. The callback
 * must not start floating promises either — async continuations would run
 * after privilege ended, so they must not commit key state.
 */
export function runCredentialMaintenanceSync(db, fn) {
  if (typeof fn !== "function") throw fail("CALLBACK_REQUIRED", "synchronous callback required");
  const s = stateOf(db);
  assertCredentialOperationAllowed(db);
  s.depth++;
  let result;
  try {
    result = fn();
  } finally {
    s.depth--;
  }
  if (result !== null && (typeof result === "object" || typeof result === "function")) {
    if (typeof result.then === "function") {
      // The privileged section already ended; the work is unsafe to trust.
      const err = fail("CALLBACK_NOT_SYNC", "maintenance callback must be synchronous");
      poisonCredentialMaintenance(db, err);
      throw err;
    }
  }
  return result;
}

function guard(_db, s, name, orig) {
  return function guarded(...args) {
    if (s.poisoned && s.depth === 0) {
      throw fail(
        "CREDENTIAL_MAINTENANCE_POISONED",
        `adapter ${name} blocked until restart`,
        s.poisoned,
      );
    }
    return orig.apply(this, args);
  };
}

/**
 * Wrap the adapter's raw mutators so poison blocks them. Idempotent; the
 * driver calls this once per adapter. Reads (get/all) stay available so
 * diagnosis and readiness can still observe state.
 */
export function installCredentialMaintenanceAdmission(db) {
  const s = stateOf(db);
  if (s.installed) return db;
  for (const name of ["run", "exec", "transaction"]) {
    if (typeof db[name] === "function") db[name] = guard(db, s, name, db[name].bind(db));
  }
  s.installed = true;
  return db;
}
