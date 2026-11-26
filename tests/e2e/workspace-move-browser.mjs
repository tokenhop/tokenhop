#!/usr/bin/env node
// Component-browser E2E: installed Vite + native CDP/WebSocket; no npm additions.
// CHROME_BIN=/usr/bin/google-chrome node tests/e2e/workspace-move-browser.mjs
// --only=delayed-middle selects one case. CHROME_STARTUP_TIMEOUT_MS overrides the
// 60 s Chrome startup budget. This is NOT a full dashboard-routing E2E.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { connect } from "./workspace-move/cdp.mjs";
import { CHROME_STARTUP_TIMEOUT_MS, waitForDevTools } from "./workspace-move/chrome.mjs";
import { BEHAVIOUR_CASES, ENTRY_CASES } from "./workspace-move/cases.mjs";
import { runCase } from "./workspace-move/driver.mjs";

// CI runners don't pre-create /tmp/opencode; mkdtemp needs the parent to exist.
await mkdir("/tmp/opencode", { recursive: true });
const scratch = await mkdtemp("/tmp/opencode/yan-1052-browser-");
const inherited = { ...process.env };
let server;
let chrome;
let cdp;
let cleaning;
async function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    cdp?.close();
    if (chrome?.pid) {
      // Chrome leads its own process group (detached spawn). Signal the whole
      // group: helper processes keep writing to the profile after the main
      // process exits, and rm then fails with ENOTEMPTY (YAN-2441).
      const killGroup = (signal) => {
        try {
          process.kill(-chrome.pid, signal);
        } catch {
          chrome.kill(signal); // Group already gone (ESRCH) or no group signals.
        }
      };
      if (chrome.exitCode === null && chrome.signalCode === null) {
        const exited = new Promise((done) => chrome.once("exit", done));
        killGroup("SIGTERM");
        const sigkill = setTimeout(() => killGroup("SIGKILL"), 3000);
        let giveUp;
        await Promise.race([exited, new Promise((done) => (giveUp = setTimeout(done, 6000)))]);
        clearTimeout(sigkill);
        clearTimeout(giveUp);
      }
      killGroup("SIGKILL");
    }
    await server?.close();
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  })();
  return cleaning;
}
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(code));
  });
}
try {
  assert.equal(typeof WebSocket, "function", "Node with native WebSocket required (Node 22+)");
  // No inherited credentials or dotenv. All browser/Vite/Next/cache writes isolated.
  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const key of ["PATH", "LANG", "LD_LIBRARY_PATH"])
    if (inherited[key]) process.env[key] = inherited[key];
  for (const key of [
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "DATA_DIR",
    "TMPDIR",
  ]) {
    process.env[key] = resolve(scratch, key.toLowerCase());
    assert.ok(process.env[key].startsWith(`${scratch}/`));
    await mkdir(process.env[key], { recursive: true });
  }
  assert.equal(homedir(), process.env.HOME);
  // Node-side network guard too: fixture needs only its loopback Vite/CDP server.
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.ok(url.hostname === "127.0.0.1", `External Node fetch forbidden: ${url}`);
    return nativeFetch(input, init);
  };
  const { startServer } = await import("./workspace-move/browser-server.mjs");
  server = await startServer(scratch);
  chrome = spawn(
    inherited.CHROME_BIN || inherited.CHROMIUM_BIN || "/usr/bin/google-chrome",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-default-apps",
      "--disable-domain-reliability",
      "--metrics-recording-only",
      "--no-proxy-server",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${resolve(scratch, "chrome")}`,
      "about:blank",
    ],
    { env: process.env, stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  // waitForDevTools detaches its own listeners once settled; this one stays so
  // a late child "error" (e.g. a failed kill) can never crash the runner.
  chrome.on("error", () => {});
  const { port } = await waitForDevTools(chrome, {
    timeout: Number(inherited.CHROME_STARTUP_TIMEOUT_MS) || CHROME_STARTUP_TIMEOUT_MS,
  });
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  cdp = await connect(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  const browserErrors = [];
  const blocked = [];
  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => browserErrors.push(exceptionDetails));
  cdp.on("Runtime.consoleAPICalled", ({ type, args }) => {
    if (type === "error") browserErrors.push(args.map((arg) => arg.value ?? arg.description));
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  cdp.on("Fetch.requestPaused", ({ requestId, request }) => {
    const allowed = new URL(request.url).origin === new URL(server.url).origin;
    if (!allowed) blocked.push(request.url);
    void cdp
      .send(
        allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
        allowed ? { requestId } : { requestId, errorReason: "BlockedByClient" },
      )
      .catch(() => {});
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  const filter = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7);
  const selected = [...BEHAVIOUR_CASES, ...ENTRY_CASES].filter(
    (entry) => !filter || entry.name === filter,
  );
  assert.ok(selected.length, `Unknown case: ${filter}`);
  const failures = [];
  for (const definition of selected) {
    browserErrors.length = 0;
    try {
      const result = await runCase(cdp, server.url, definition);
      // Vite is not running HMR; do not confuse its optional websocket diagnostic
      // with a component exception. Every other browser error fails the scenario,
      // including React unknown-prop warnings (a leaked focus ref is a real bug).
      const unexpected = browserErrors.filter((entry) => !JSON.stringify(entry).includes("[vite]"));
      assert.deepEqual(unexpected, [], "Unexpected browser errors");
      console.log(`PASS ${definition.name} focus=${result.active}`);
    } catch (error) {
      failures.push(definition.name);
      console.error(`FAIL ${definition.name}: ${error.message.split("\n")[0]}`);
      if (inherited.WM_DEBUG)
        console.error(error.stack, JSON.stringify(browserErrors).slice(0, 4000));
    }
  }
  assert.deepEqual(blocked, [], "Unexpected external browser request");
  if (failures.length)
    throw new Error(`${failures.length}/${selected.length} cases failed: ${failures.join(", ")}`);
  console.log(`PASS ${selected.length} workspace move browser cases`);
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
} finally {
  await cleanup();
}
