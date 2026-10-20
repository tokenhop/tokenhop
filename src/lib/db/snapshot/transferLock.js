// In-process serialization of whole-instance transfers. Only one writer per
// DATA_DIR exists (processLock), so a promise chain is sufficient and makes
// any fixed-name staging resource safe.
//
// Chain tails live on globalThis: Next dev/HMR can instantiate this module
// more than once in one process, and a module-local tail would then let two
// imports share the fixed `xstage` attach name (or two exports pile up).
const IMPORT_KEY = Symbol.for("tokenhop.instanceImportLock");
const EXPORT_KEY = Symbol.for("tokenhop.instanceExportLock");

function chain(key) {
  return (fn) => {
    const run = (globalThis[key] ?? Promise.resolve()).then(fn, fn);
    globalThis[key] = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

export const withInstanceImportLock = chain(IMPORT_KEY);
/** One export at a time: each stages a full copy of the DB on disk. */
export const withInstanceExportLock = chain(EXPORT_KEY);
