// One sql.js WASM module per process, shared by the sql.js adapter, the backup
// verifier and the snapshot import stage. A second `initSqlJs()` is a second
// async WASM compile: while it is pending the event loop can go idle, and on
// Node 22 an idle loop parks the main thread in NodePlatform::DrainTasks while
// a concurrent TurboFan job waits for the main thread to run a GC — a
// deadlock that hangs the process (seen as 45s test timeouts in the KEK
// rotation crash matrix). Sharing the instance keeps that window to one init.
let pending = null;

export function loadSqlJs() {
  pending ??= import("sql.js")
    .then(({ default: initSqlJs }) => initSqlJs())
    .catch((err) => {
      pending = null;
      throw err;
    });
  return pending;
}
