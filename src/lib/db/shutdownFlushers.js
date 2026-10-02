// Process-wide sync flushers run by adapters before closing the DB on
// SIGTERM/SIGINT/beforeExit. Plain object slots (not a Set) so Next.js dev
// hot-reload replaces the closure instead of accumulating listeners.
// Kept in its own module so adapters and repos can import it without cycles.
const flushers = (globalThis.__dbShutdownFlushers ??= {});

export function registerShutdownFlusher(name, fn) {
  flushers[name] = fn;
}

export function runShutdownFlushers() {
  for (const fn of Object.values(flushers)) {
    try {
      fn();
    } catch {}
  }
}
