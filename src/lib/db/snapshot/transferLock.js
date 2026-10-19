// In-process serialization of whole-instance imports. Only one writer per
// DATA_DIR exists (processLock), so a promise chain is sufficient and makes
// any fixed-name staging resource safe.
let tail = Promise.resolve();

export function withInstanceImportLock(fn) {
  const run = tail.then(fn, fn);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
