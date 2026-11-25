// Chrome startup for the workspace-move browser E2E (YAN-2451).
//
// Chrome prints `DevTools listening on ws://HOST:PORT/devtools/browser/ID` to
// stderr once its DevTools endpoint accepts connections. Waiting on that line is
// deterministic, unlike polling for DevToolsActivePort under a short deadline:
// on a cold, loaded CI runner Chrome can take well over 15 s to get there.

// Cold CI runners have needed more than the old 15 s; 60 s leaves headroom
// without letting a wedged Chrome hang the job.
export const CHROME_STARTUP_TIMEOUT_MS = 60000;
const LOG_TAIL = 10000;
const LISTENING = /DevTools listening on (ws:\/\/[^\s]+)/;

/**
 * Resolve once `child` (a spawned Chrome with piped stderr) reports its DevTools
 * endpoint. Rejects, with Chrome's stderr tail, if Chrome fails to launch, exits
 * first, or stays silent past `timeout`.
 *
 * @returns {Promise<{ port: number, browserWsUrl: string }>}
 */
export function waitForDevTools(child, { timeout = CHROME_STARTUP_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let log = "";
    let pending = "";
    const started = Date.now();
    const fail = (reason) => {
      finish();
      const tail = log.trim() || "(no stderr output)";
      reject(new Error(`${reason}\n--- Chrome log (stderr tail) ---\n${tail}`));
    };
    const onData = (chunk) => {
      const text = String(chunk);
      log = (log + text).slice(-LOG_TAIL);
      // Match whole lines only: the URL can arrive split across chunks.
      const lines = (pending + text).split("\n");
      pending = lines.pop();
      for (const line of lines) {
        const match = LISTENING.exec(line);
        if (!match) continue;
        const port = Number(new URL(match[1]).port);
        if (!port) return fail(`Chrome reported an unusable DevTools URL: ${match[1]}`);
        finish();
        return resolve({ port, browserWsUrl: match[1] });
      }
    };
    const onError = (error) =>
      fail(`Chrome unavailable: ${error.message}. Set CHROME_BIN (no silent skip).`);
    const onExit = (code, signal) =>
      fail(`Chrome exited before DevTools was ready (code=${code}, signal=${signal})`);
    const timer = setTimeout(
      () => fail(`Timed out after ${Date.now() - started} ms: isolated Chrome startup`),
      timeout,
    );
    function finish() {
      clearTimeout(timer);
      child.stderr.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      // Keep draining stderr so a chatty Chrome never blocks on a full pipe.
      child.stderr.resume();
    }
    child.stderr.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    if (child.exitCode != null || child.signalCode != null)
      onExit(child.exitCode, child.signalCode);
  });
}
