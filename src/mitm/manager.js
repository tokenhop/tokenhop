const { exec, spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const https = require("https");
const crypto = require("crypto");
const {
  addDNSEntry,
  removeDNSEntry,
  removeAllDNSEntries,
  removeAllDNSEntriesSync,
  checkAllDNSStatus,
  TOOL_HOSTS,
  isSudoAvailable,
  isSudoPasswordRequired,
} = require("./dns/dnsConfig");
const { isAdmin } = require("./winElevated.js");
const { ACTIVE } = require("../shared/brand/index.cjs");

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const { generateCert } = require("./cert/generate");
const { installCert, uninstallCert } = require("./cert/install");
const { isCertExpired } = require("./cert/rootCA");
const { DATA_DIR, MITM_DIR } = require("./paths");
const { log, err } = require("./logger");
const { LSOF_BIN } = require("./config");
const runtimeCredentials = require("./runtimeCredentials");

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";

function shellQuoteSingle(str) {
  if (str == null || str === "") return "''";
  return `'${String(str).replace(/'/g, "'\\''")}'`;
}

async function resolveMitmRouterBaseUrl() {
  if (!_getSettings) return DEFAULT_MITM_ROUTER_BASE;
  try {
    const s = await _getSettings();
    const raw = s && s.mitmRouterBaseUrl != null ? String(s.mitmRouterBaseUrl).trim() : "";
    if (!raw) return DEFAULT_MITM_ROUTER_BASE;
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return DEFAULT_MITM_ROUTER_BASE;
    return raw.replace(/\/+$/, "");
  } catch {
    return DEFAULT_MITM_ROUTER_BASE;
  }
}

const MITM_PORT = 443;
const MITM_WIN_NODE_PORT = 8443;
const PID_FILE = path.join(MITM_DIR, ".mitm.pid");
const LOCK_FILE = path.join(MITM_DIR, ".mitm.lock");

const MITM_MAX_RESTARTS = 5;
const MITM_RESTART_DELAYS_MS = [5000, 10000, 20000, 30000, 60000];
const MITM_RESTART_RESET_MS = 60000;

let mitmRestartCount = 0;
let mitmLastStartTime = 0;
let mitmIsRestarting = false;

// YAN-363 lifecycle credential seam. Manager owns timing + in-memory custody:
// the raw bearer lives only in these locals or the child's env, never in argv,
// settings, logs, status, or export. Mode classification + verifier DB logic
// live in src/lib/auth/mitmCredential.js (injected via hooks to dodge CJS/ESM
// DB cycles); gateway acceptance of the local credential lands with
// gatewayAuth.js. Legacy callers passing a raw key keep today's behavior.
let _credentialHooks = null; // { installLocalVerifier, clearLocalVerifierIfMatch, isLocalRouter }
let _remoteCredential = null; // operator secret, parent memory only
let _mitmLifecycleState = null; // { mode, verifierHash } for current/last child
let _activeRawCredential = null; // raw bearer for log redaction only, never exported
// Manual remote binding (YAN-363 spec202): browser-supplied credential held in
// parent memory, bound to one normalized router URL. No file/DB/argv copy;
// endpoint change discards it (must re-supply or use startup source).
let _manualRemoteBinding = null; // { apiKey, routerBaseUrl } or null

function isValidManualCredential(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= 4096 &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject controls at credential boundary.
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)
  );
}

// Parent-process secrets the MITM child never needs: the operator remote
// source vars and the root master key. Stripped from every spawn path
// (legacy sudo too — argv contract preserved) so a local/other-destination
// child can never read the remote credential or DB root key. Managed children
// receive only the selected ROUTER_API_KEY slot.
const CHILD_STRIPPED_ENV_KEYS = [
  "TOKENHOP_MITM_REMOTE_API_KEY",
  "TOKENHOP_MITM_REMOTE_API_KEY_FILE",
  "TOKENHOP_MASTER_KEY",
];

function buildChildEnv(overrides) {
  const env = { ...process.env };
  for (const key of CHILD_STRIPPED_ENV_KEYS) delete env[key];
  return Object.assign(env, overrides);
}

async function getMitmCredentialStatus(routerBaseUrl, storage) {
  const base = runtimeCredentials.normalizeRouterBaseUrl(routerBaseUrl);
  // Read-only view for GET status: never mutates bindings, exposes no secrets.
  const startup = await _remoteCredential;
  const local = Boolean(_credentialHooks) && _credentialHooks.isLocalRouter(base);
  const credentialSource =
    storage !== "hashed"
      ? "legacy"
      : local
        ? "internal"
        : _manualRemoteBinding && _manualRemoteBinding.routerBaseUrl === base
          ? "manual"
          : startup && startup.routerBaseUrl === base
            ? startup.source
            : "none";
  const credentialConfigured = credentialSource !== "none";
  return {
    storage,
    credentialSource,
    credentialConfigured,
    needsCredential: !credentialConfigured,
  };
}

// Endpoint change discards the stale manual binding; startup source stays.
function dropManualBindingUnless(routerBase) {
  if (_manualRemoteBinding && _manualRemoteBinding.routerBaseUrl !== routerBase) {
    _manualRemoteBinding = null;
  }
}

/** Read-only manual-binding probe for tests/diagnostics; exposes no secret. */
function hasManualRemoteBinding(routerBaseUrl) {
  const base = runtimeCredentials.normalizeRouterBaseUrl(routerBaseUrl);
  return Boolean(_manualRemoteBinding && _manualRemoteBinding.routerBaseUrl === base);
}

function resolveBundledServerPath() {
  if (process.env.MITM_SERVER_PATH) return process.env.MITM_SERVER_PATH;
  const sibling = path.join(__dirname, "server.js");
  if (fs.existsSync(sibling)) return sibling;
  const fromCwd = path.join(process.cwd(), "src", "mitm", "server.js");
  if (fs.existsSync(fromCwd)) return fromCwd;
  const fromNext = path.join(process.cwd(), "..", "src", "mitm", "server.js");
  if (fs.existsSync(fromNext)) return fromNext;
  return fromCwd;
}

// Copy bundled server.js into DATA_DIR so MITM doesn't lock node_modules
// (prevents EBUSY on `npm i -g` of the CLI while MITM is running).
function ensureRuntimeServer(bundledPath) {
  try {
    if (!bundledPath || !fs.existsSync(bundledPath)) return bundledPath;

    // Dev mode: source file has relative requires (./logger, ./config...),
    // only the bundled file inside node_modules is self-contained + safe to copy.
    if (!bundledPath.includes(`${path.sep}node_modules${path.sep}`)) {
      return bundledPath;
    }

    const runtimeDir = path.join(DATA_DIR, "runtime", "mitm");
    const runtimeServer = path.join(runtimeDir, "server.js");

    // Skip copy if sizes match (bundle unchanged since last run)
    if (fs.existsSync(runtimeServer)) {
      try {
        if (fs.statSync(bundledPath).size === fs.statSync(runtimeServer).size) return runtimeServer;
      } catch {
        /* recopy */
      }
    }

    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.copyFileSync(bundledPath, runtimeServer);
    return runtimeServer;
  } catch (e) {
    try {
      log(`[MITM] runtime copy failed: ${e.message}`);
    } catch {
      /* ignore */
    }
    return bundledPath;
  }
}

const SERVER_PATH = ensureRuntimeServer(resolveBundledServerPath());
const ENCRYPT_ALGO = "aes-256-gcm";
const ENCRYPT_SALT = "9router-mitm-pwd"; // legacy(9router): stored-data salt, keep

function getProcessUsingPort443() {
  try {
    if (IS_WIN) {
      const psCmd =
        `powershell -NonInteractive -WindowStyle Hidden -Command ` +
        `"$c = Get-NetTCPConnection -LocalPort 443 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $c.OwningProcess } else { 0 }"`;
      const pidStr = execSync(psCmd, { encoding: "utf8", windowsHide: true }).trim();
      const pid = parseInt(pidStr, 10);
      if (pid && pid > 4) {
        const tasklistResult = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
          encoding: "utf8",
          windowsHide: true,
        });
        const processMatch = tasklistResult.match(/"([^"]+)"/);
        if (processMatch) return processMatch[1].replace(".exe", "");
      }
    } else {
      const result = execSync(`${LSOF_BIN} -i :443`, { encoding: "utf8", windowsHide: true });
      const lines = result.trim().split("\n");
      if (lines.length > 1) return lines[1].split(/\s+/)[0];
    }
  } catch {
    return null;
  }
  return null;
}

let serverProcess = null;
let serverPid = null;

function getCachedPassword() {
  return globalThis.__mitmSudoPassword || null;
}
function setCachedPassword(pwd) {
  globalThis.__mitmSudoPassword = pwd;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EACCES";
  }
}

function killProcess(pid, force = false, sudoPassword = null) {
  if (IS_WIN) {
    const flag = force ? "/F " : "";
    exec(`taskkill ${flag}/PID ${pid}`, { windowsHide: true }, () => {});
  } else {
    const sig = force ? "SIGKILL" : "SIGTERM";
    const cmd = `pkill -${sig} -P ${pid} 2>/dev/null; kill -${sig} ${pid} 2>/dev/null`;
    if (sudoPassword || isSudoAvailable()) {
      const { execWithPassword } = require("./dns/dnsConfig");
      execWithPassword(cmd, sudoPassword || "").catch(() =>
        exec(cmd, { windowsHide: true }, () => {}),
      );
    } else {
      exec(cmd, { windowsHide: true }, () => {});
    }
  }
}

function deriveKey() {
  try {
    const { machineIdSync } = require("node-machine-id");
    const raw = machineIdSync();
    return crypto
      .createHash("sha256")
      .update(raw + ENCRYPT_SALT)
      .digest();
  } catch {
    return crypto.createHash("sha256").update(ENCRYPT_SALT).digest();
  }
}

function encryptPassword(plaintext) {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPT_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptPassword(stored) {
  try {
    const [ivHex, tagHex, dataHex] = stored.split(":");
    if (!ivHex || !tagHex || !dataHex) return null;
    const key = deriveKey();
    const decipher = crypto.createDecipheriv(ENCRYPT_ALGO, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return decipher.update(Buffer.from(dataHex, "hex")) + decipher.final("utf8");
  } catch {
    return null;
  }
}

let _getSettings = null;
let _updateSettings = null;

function initDbHooks(getSettingsFn, updateSettingsFn) {
  _getSettings = getSettingsFn;
  _updateSettings = updateSettingsFn;
}

/**
 * YAN-363 lifecycle hooks (parent wiring, optional).
 * credentialHooks: subset of { installLocalVerifier, clearLocalVerifierIfMatch,
 * isLocalRouter } from src/lib/auth/mitmCredential.js.
 * remoteCredential: optional operator secret read at parent startup (memory only).
 */
function initMitmCredentialHooks(credentialHooks, remoteCredential = null) {
  _credentialHooks = credentialHooks;
  // Capture the destination at initialization, not at the later spawn. Existing
  // startup callers pass raw bytes; descriptor callers may supply source + URL.
  _remoteCredential = remoteCredential
    ? Promise.resolve(_getSettings ? _getSettings() : {})
        .then((settings) => ({
          apiKey: typeof remoteCredential === "string" ? remoteCredential : remoteCredential.apiKey,
          routerBaseUrl: runtimeCredentials.normalizeRouterBaseUrl(
            remoteCredential.routerBaseUrl ||
              settings.mitmRouterBaseUrl ||
              DEFAULT_MITM_ROUTER_BASE,
          ),
          source:
            remoteCredential.source ||
            (process.env.TOKENHOP_MITM_REMOTE_API_KEY_FILE ? "file" : "env"),
        }))
        .catch(() => null)
    : null;
}

async function saveMitmSettings(enabled, password) {
  if (!_updateSettings) return;
  try {
    const updates = { mitmEnabled: enabled };
    if (password) updates.mitmSudoEncrypted = encryptPassword(password);
    await _updateSettings(updates);
  } catch (e) {
    err(`Failed to save settings: ${e.message}`);
  }
}

async function clearEncryptedPassword() {
  if (!_updateSettings) return;
  try {
    await _updateSettings({ mitmSudoEncrypted: null });
  } catch (e) {
    err(`Failed to clear encrypted password: ${e.message}`);
  }
}

async function loadEncryptedPassword() {
  if (!_getSettings) return null;
  try {
    const settings = await _getSettings();
    if (!settings.mitmSudoEncrypted) return null;
    return decryptPassword(settings.mitmSudoEncrypted);
  } catch {
    return null;
  }
}

async function saveDnsToolState(tool, enabled) {
  if (!_updateSettings || !_getSettings) return;
  try {
    const s = await _getSettings();
    const next = { ...(s.dnsToolEnabled || {}), [tool]: enabled };
    await _updateSettings({ dnsToolEnabled: next });
  } catch (e) {
    err(`Failed to save DNS state: ${e.message}`);
  }
}

async function loadDnsToolState() {
  if (!_getSettings) return {};
  try {
    const s = await _getSettings();
    return s.dnsToolEnabled || {};
  } catch {
    return {};
  }
}

/**
 * Re-apply DNS for tools previously enabled — called on app startup after MITM running.
 */
async function restoreToolDNS(sudoPassword) {
  const state = await loadDnsToolState();
  const password = sudoPassword || getCachedPassword() || (await loadEncryptedPassword());
  for (const [tool, enabled] of Object.entries(state)) {
    if (!enabled || !TOOL_HOSTS[tool]) continue;
    try {
      await addDNSEntry(tool, password);
    } catch (e) {
      err(`DNS ${tool}: restore failed — ${e.message}`);
    }
  }
}

/**
 * Check if user has privilege to mutate hosts file.
 * Win: needs admin. Mac/Linux: root OR cached/encrypted sudo password.
 */
async function hasDnsPrivilege() {
  if (IS_WIN) return isAdmin();
  if (isAdmin()) return true;
  if (!isSudoPasswordRequired()) return true;
  const pwd = getCachedPassword() || (await loadEncryptedPassword());
  return !!pwd;
}

function checkPort443Free() {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", (err) => {
      if (err.code === "EADDRINUSE") resolve("in-use");
      else resolve("no-permission");
    });
    tester.once("listening", () => {
      tester.close(() => resolve("free"));
    });
    tester.listen(MITM_PORT, "127.0.0.1");
  });
}

function getPort443Owner(sudoPassword) {
  return new Promise((resolve) => {
    if (IS_WIN) {
      const psCmd =
        `powershell -NonInteractive -WindowStyle Hidden -Command "` +
        `$c = Get-NetTCPConnection -LocalPort 443 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
        `if ($c) { $c.OwningProcess } else { 0 }"`;
      exec(psCmd, { windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        const pid = parseInt(stdout.trim(), 10);
        if (!pid || pid <= 4) return resolve(null);
        exec(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { windowsHide: true }, (e2, out2) => {
          const m = out2?.match(/"([^"]+)"/);
          resolve({ pid, name: m ? m[1] : "unknown" });
        });
      });
    } else {
      // Only find process actually LISTENING on TCP port 443
      exec(`${LSOF_BIN} -nP -iTCP:443 -sTCP:LISTEN -t`, { windowsHide: true }, (err, stdout) => {
        if (err || !stdout?.trim()) return resolve(null);
        const pid = parseInt(stdout.trim().split("\n")[0], 10);
        if (!pid || isNaN(pid)) return resolve(null);
        exec(`ps -p ${pid} -o comm=`, { windowsHide: true }, (e2, out2) => {
          resolve({ pid, name: out2?.trim() || "unknown" });
        });
      });
    }
  });
}

async function killLeftoverMitm(sudoPassword) {
  if (serverProcess && !serverProcess.killed) {
    try {
      serverProcess.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    serverProcess = null;
    serverPid = null;
  }
  try {
    if (fs.existsSync(PID_FILE)) {
      const savedPid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
      if (savedPid && isProcessAlive(savedPid)) {
        killProcess(savedPid, true, sudoPassword);
        await new Promise((r) => setTimeout(r, 500));
      }
      fs.unlinkSync(PID_FILE);
    }
  } catch {
    /* ignore */
  }
  if (!IS_WIN && SERVER_PATH) {
    try {
      const escaped = SERVER_PATH.replace(/'/g, "'\\''");
      if (sudoPassword || isSudoAvailable()) {
        const { execWithPassword } = require("./dns/dnsConfig");
        await execWithPassword(
          `pkill -SIGKILL -f "${escaped}" 2>/dev/null || true`,
          sudoPassword || "",
        ).catch(() => {});
      } else {
        exec(`pkill -SIGKILL -f "${escaped}" 2>/dev/null || true`, { windowsHide: true }, () => {});
      }
      await new Promise((r) => setTimeout(r, 500));
    } catch {
      /* ignore */
    }
  }
}

function pollMitmHealth(timeoutMs, port = MITM_PORT) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const req = https.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/_mitm_health",
          method: "GET",
          rejectUnauthorized: false,
        },
        (res) => {
          let body = "";
          res.on("data", (d) => {
            body += d;
          });
          res.on("end", () => {
            try {
              const json = JSON.parse(body);
              resolve(json.ok === true ? { ok: true, pid: json.pid || null } : null);
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on("error", () => {
        if (Date.now() < deadline) setTimeout(check, 500);
        else resolve(null);
      });
      req.end();
    };
    check();
  });
}

/**
 * Get full MITM status including per-tool DNS status
 */
async function getMitmStatus() {
  let running = serverProcess !== null && !serverProcess.killed;
  let pid = serverPid;

  if (!running) {
    try {
      if (fs.existsSync(PID_FILE)) {
        const savedPid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
        if (savedPid && isProcessAlive(savedPid)) {
          running = true;
          pid = savedPid;
        } else {
          fs.unlinkSync(PID_FILE);
        }
      }
    } catch {
      /* ignore */
    }
  }

  const dnsStatus = checkAllDNSStatus();
  const rootCACertPath = path.join(MITM_DIR, "rootCA.crt");
  const certExists = fs.existsSync(rootCACertPath);
  const { checkCertInstalled } = require("./cert/install");
  const certTrusted = certExists ? await checkCertInstalled(rootCACertPath) : false;

  return { running, pid, certExists, certTrusted, dnsStatus };
}

function redactLifecycleSecret(text) {
  const str = String(text);
  if (!_activeRawCredential) return str;
  return str.split(_activeRawCredential).join("[REDACTED]");
}

async function assertMitmStartupSourceCompatible(routerBase, apiKey) {
  if (
    apiKey == null ||
    apiKey === "" ||
    !_credentialHooks ||
    _credentialHooks.isLocalRouter(routerBase)
  )
    return;
  const startup = await _remoteCredential;
  if (startup && startup.routerBaseUrl === routerBase) {
    const conflict = new Error(
      "MITM remote credential uses the operator startup source. Omit apiKey to use that source, or clear the startup source and restart the parent to use a typed credential.",
    );
    conflict.code = "MITM_STARTUP_SOURCE_LOCKED";
    throw conflict;
  }
}

async function resolveMitmLifecycleCredential(routerBase, explicitApiKey = undefined) {
  const hooks = _credentialHooks;
  if (!hooks || typeof hooks.isLocalRouter !== "function") return { mode: "legacy" };
  dropManualBindingUnless(routerBase);
  if (!hooks.isLocalRouter(routerBase)) {
    // Approved startup source (env/file) outranks any browser-supplied value —
    // a configured operator secret can never be overridden from the dashboard.
    // A nonempty typed credential against the same endpoint is an explicit
    // conflict, surfaced before spawn instead of silently ignored.
    const startup = await _remoteCredential;
    if (startup && startup.routerBaseUrl === routerBase) {
      await assertMitmStartupSourceCompatible(routerBase, explicitApiKey);
      return { mode: "remote", apiKey: startup.apiKey };
    }
    if (explicitApiKey !== undefined) {
      if (!isValidManualCredential(explicitApiKey)) throw new Error("Invalid MITM credential");
      _manualRemoteBinding = { apiKey: explicitApiKey, routerBaseUrl: routerBase };
    }
    if (_manualRemoteBinding) return { mode: "remote", apiKey: _manualRemoteBinding.apiKey };
    throw new Error("Remote MITM router needs an operator-supplied credential");
  }
  const local = runtimeCredentials.createLocalCredential();
  if (typeof hooks.installLocalVerifier === "function") {
    await hooks.installLocalVerifier(local.verifierHash);
  }
  return { mode: "local", apiKey: local.apiKey, verifierHash: local.verifierHash };
}

async function clearMitmLifecycleCredential(state) {
  if (!state) return;
  if (state.mode === "remote") {
    // Operator secret stays in parent memory for explicit-configured restarts;
    // never written anywhere. Drop nothing here (endpoint/source stop clears).
    return;
  }
  if (state.mode === "local" && state.verifierHash && _credentialHooks) {
    try {
      if (typeof _credentialHooks.clearLocalVerifierIfMatch === "function") {
        await _credentialHooks.clearLocalVerifierIfMatch(state.verifierHash);
      }
    } catch {
      /* best effort: verifier cleanup must not mask spawn errors */
    }
  }
}

// Incremental stream redaction: a secret split across chunk boundaries must
// never reach the parent console. Holds back key.length-1 chars un-redacted
// in memory until the next chunk completes or drops them at exit.
// ponytail: exit-time tail chars are dropped, not flushed — revisit only if
// truncated trailing log lines ever matter.
function createSecretRedactingWriter(writeFn, secret) {
  let pending = "";
  return (chunk) => {
    pending += chunk;
    if (!secret) {
      writeFn(pending);
      pending = "";
      return;
    }
    const safe = pending.split(secret).join("[REDACTED]");
    const keep = secret.length - 1;
    if (safe.length > keep) {
      writeFn(safe.slice(0, safe.length - keep));
      pending = safe.slice(safe.length - keep);
    }
  };
}

async function scheduleMitmRestart(apiKey) {
  if (mitmIsRestarting) return;
  // Set guard synchronously before any await to prevent concurrent calls
  // from passing the check above.
  mitmIsRestarting = true;

  const aliveMs = Date.now() - mitmLastStartTime;
  if (aliveMs >= MITM_RESTART_RESET_MS) mitmRestartCount = 0;

  if (mitmRestartCount >= MITM_MAX_RESTARTS) {
    err("Max restart attempts reached. Giving up.");
    mitmIsRestarting = false;
    return;
  }

  const attempt = mitmRestartCount;
  const delay = MITM_RESTART_DELAYS_MS[Math.min(attempt, MITM_RESTART_DELAYS_MS.length - 1)];
  mitmRestartCount++;

  log(`Restarting in ${delay / 1000}s... (${mitmRestartCount}/${MITM_MAX_RESTARTS})`);
  await new Promise((r) => setTimeout(r, delay));

  try {
    const settings = _getSettings ? await _getSettings() : null;
    if (settings && !settings.mitmEnabled) {
      log("MITM disabled, skipping restart");
      mitmIsRestarting = false;
      return;
    }
    const password = getCachedPassword() || (await loadEncryptedPassword());
    if (!password && !IS_WIN) {
      err("No cached password, cannot auto-restart");
      mitmIsRestarting = false;
      return;
    }
    // Legacy callers keep their original raw key across restarts. Managed mode
    // (hashed storage) resolves fresh inside startServer: local re-mints per
    // spawn, remote reuses the parent-memory binding or startup source.
    // Exit-driven restarts arrive with null so no stale typed value is
    // ever re-applied.
    await startServer(apiKey, password);
    log("🔄 Restarted successfully");
    mitmRestartCount = 0;
    mitmIsRestarting = false;
  } catch (e) {
    err(`Restart attempt ${mitmRestartCount}/${MITM_MAX_RESTARTS} failed: ${e.message}`);
    mitmIsRestarting = false;
    // Schedule next retry
    scheduleMitmRestart(apiKey);
  }
}

/**
 * Start MITM server only (cert + server, no DNS)
 */
async function killPort443Owner(owner, sudoPassword) {
  if (!owner || !owner.pid) return;
  if (IS_WIN) {
    try {
      execSync(
        `powershell -NonInteractive -WindowStyle Hidden -Command "Stop-Process -Id ${owner.pid} -Force -ErrorAction SilentlyContinue"`,
        { windowsHide: true },
      );
    } catch {
      /* best effort */
    }
  } else {
    try {
      const { execWithPassword } = require("./dns/dnsConfig");
      if (sudoPassword || isSudoAvailable()) {
        await execWithPassword(`kill -9 ${owner.pid}`, sudoPassword || "");
      } else {
        execSync(`kill -9 ${owner.pid}`, { windowsHide: true });
      }
    } catch {
      /* best effort */
    }
  }
  await new Promise((r) => setTimeout(r, 800));
}

async function startServer(apiKey, sudoPassword, forceKillPort443 = false) {
  // Managed local: browser input never reaches the gateway. Managed remote:
  // an explicit typed credential may bind on manual start only (endpoint-bound,
  // parent memory); autonomous restarts reuse the binding or startup source.
  const managed = Boolean(_credentialHooks && typeof _credentialHooks.isLocalRouter === "function");
  const callerApiKey = apiKey === undefined || apiKey === null ? null : apiKey;
  if (managed) {
    const router = runtimeCredentials.normalizeRouterBaseUrl(
      (_getSettings ? await _getSettings() : {}).mitmRouterBaseUrl || DEFAULT_MITM_ROUTER_BASE,
    );
    await assertMitmStartupSourceCompatible(router, apiKey);
  }
  let spawnCredential = null;
  if (!managed && (!serverProcess || serverProcess.killed)) {
    try {
      if (fs.existsSync(PID_FILE)) {
        const savedPid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
        if (savedPid && isProcessAlive(savedPid)) {
          serverPid = savedPid;
          log(`♻️ Reusing existing process (PID: ${savedPid})`);
          await saveMitmSettings(true, sudoPassword);
          if (sudoPassword) setCachedPassword(sudoPassword);
          return { running: true, pid: savedPid };
        } else {
          fs.unlinkSync(PID_FILE);
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (!managed && serverProcess && !serverProcess.killed) {
    throw new Error("MITM server is already running");
  }

  // Atomically claim lock to prevent concurrent startServer across processes.
  // O_EXCL (flag: "wx") fails with EEXIST if the file already exists.
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
  } catch (e) {
    if (e.code === "EEXIST") {
      let stale = false;
      try {
        const pid = parseInt(fs.readFileSync(LOCK_FILE, "utf-8").trim(), 10);
        stale = !pid || !isProcessAlive(pid);
      } catch {
        stale = true;
      } // unreadable lock → treat as stale
      if (!stale) throw new Error("MITM server is already starting (lock contention)");
      try {
        fs.unlinkSync(LOCK_FILE);
      } catch {
        /* ignore */
      }
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
    } else throw e;
  }

  try {
    // Wait for managed child exit before replacing its verifier.
    mitmIsRestarting = true;
    if (managed && serverProcess && !serverProcess.killed) {
      const old = serverProcess;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("MITM child did not stop")), 5000);
        old.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        if (!old.kill("SIGKILL")) {
          clearTimeout(timeout);
          reject(new Error("MITM child did not stop"));
        }
      });
    }
    await killLeftoverMitm(sudoPassword);
    await clearMitmLifecycleCredential(_mitmLifecycleState);
    _mitmLifecycleState = null;

    if (!IS_WIN) {
      const portStatus = await checkPort443Free();
      if (portStatus === "in-use" || portStatus === "no-permission") {
        const owner = await getPort443Owner(sudoPassword);
        if (owner) {
          const shortName = owner.name.includes("/")
            ? owner.name.split("/").filter(Boolean).pop()
            : owner.name;
          if (forceKillPort443) {
            log(`Killing process on port 443 (PID ${owner.pid}, name=${shortName})...`);
            await killPort443Owner(owner, sudoPassword);
          } else {
            const e = new Error(`Port 443 is already in use by "${shortName}" (PID ${owner.pid}).`);
            e.code = "PORT_443_BUSY";
            e.portOwner = { pid: owner.pid, name: shortName };
            throw e;
          }
        }
      }
    }

    // Step 1: Generate Root CA if missing or expired
    const rootCACertPath = path.join(MITM_DIR, "rootCA.crt");
    const rootCAKeyPath = path.join(MITM_DIR, "rootCA.key");
    const certExists = fs.existsSync(rootCACertPath) && fs.existsSync(rootCAKeyPath);

    if (!certExists || isCertExpired(rootCACertPath)) {
      if (certExists) {
        // Uninstall expired cert from system store before regenerating
        log("🔐 Cert expired — uninstalling old cert...");
        const password = sudoPassword || getCachedPassword() || (await loadEncryptedPassword());
        try {
          await uninstallCert(password, rootCACertPath);
        } catch {
          /* best effort */
        }
      }
      log("🔐 Generating Root CA...");
      await generateCert();
    }

    // Step 1.5: Auto-install Root CA if not trusted yet
    const { checkCertInstalled } = require("./cert/install");
    const rootCATrusted = await checkCertInstalled(rootCACertPath);
    const linuxNoSystemTrust = !IS_WIN && !IS_MAC && !isSudoAvailable();
    if (!rootCATrusted) {
      log("🔐 Cert: not trusted → installing...");
      const password = sudoPassword || getCachedPassword() || (await loadEncryptedPassword());
      if (linuxNoSystemTrust) {
        log(
          `🔐 Cert: skipping system trust (no sudo). Install ${rootCACertPath} as a trusted CA on machines that use this proxy.`,
        );
      } else {
        if (!password && isSudoPasswordRequired()) {
          throw new Error("Sudo password required to install Root CA certificate");
        }
        try {
          await installCert(password, rootCACertPath);
          log("🔐 Cert: ✅ trusted");
        } catch (e) {
          throw new Error(`Failed to trust certificate: ${e.message}`);
        }
      }
    } else {
      log("🔐 Cert: already trusted ✅");
    }

    // Step 2: Spawn server (Root CA already installed in Step 1.5)
    // Verify server.js exists — recopy if runtime file was deleted (antivirus/cleanup)
    let effectiveServerPath = SERVER_PATH;
    if (!effectiveServerPath || !fs.existsSync(effectiveServerPath)) {
      log(`[MITM] server.js missing at ${effectiveServerPath} → recopying`);
      effectiveServerPath = ensureRuntimeServer(resolveBundledServerPath());
      if (!effectiveServerPath || !fs.existsSync(effectiveServerPath)) {
        throw new Error(
          `MITM server.js not found at ${effectiveServerPath}. Reinstall ${ACTIVE.npmPackage}.`,
        );
      }
    }
    const mitmRouterBase = managed
      ? runtimeCredentials.normalizeRouterBaseUrl(
          (_getSettings ? await _getSettings() : {}).mitmRouterBaseUrl || DEFAULT_MITM_ROUTER_BASE,
        )
      : await resolveMitmRouterBaseUrl();
    spawnCredential = managed
      ? await resolveMitmLifecycleCredential(
          mitmRouterBase,
          callerApiKey === null ? undefined : callerApiKey,
        )
      : { mode: "legacy", apiKey: callerApiKey };
    if (managed && !spawnCredential.apiKey) throw new Error("Missing MITM credential");
    _activeRawCredential = managed ? spawnCredential.apiKey : null;
    _mitmLifecycleState = {
      mode: spawnCredential.mode,
      verifierHash: spawnCredential.verifierHash,
    };
    log(`🚀 Starting server... (router: ${mitmRouterBase})`);
    if (IS_WIN) {
      // Check port 443 — ask user before killing
      const winOwner = await getPort443Owner(sudoPassword);
      if (winOwner) {
        if (forceKillPort443) {
          log(`Killing process on port 443 (PID ${winOwner.pid}, name=${winOwner.name})...`);
          await killPort443Owner(winOwner, sudoPassword);
        } else {
          const e = new Error(
            `Port 443 is already in use by "${winOwner.name}" (PID ${winOwner.pid}).`,
          );
          e.code = "PORT_443_BUSY";
          e.portOwner = { pid: winOwner.pid, name: winOwner.name };
          throw e;
        }
      }

      // Spawn directly — process already has admin rights
      // cwd=tmpdir so process doesn't lock the install dir on Windows (EBUSY on update)
      serverProcess = spawn(process.execPath, [effectiveServerPath], {
        detached: false,
        windowsHide: true,
        cwd: os.tmpdir(),
        stdio: ["ignore", "pipe", "pipe"],
        env: buildChildEnv({
          ROUTER_API_KEY: spawnCredential.apiKey,
          NODE_ENV: "production",
          MITM_ROUTER_BASE: mitmRouterBase,
        }),
      });

      if (_updateSettings) await _updateSettings({ mitmCertInstalled: true }).catch(() => {});
    } else if (isSudoAvailable() && !managed) {
      // Legacy branch unchanged (pre-YAN-363 invocation).
      const inlineCmd = [
        `HOME=${shellQuoteSingle(os.homedir())}`,
        `ROUTER_API_KEY=${shellQuoteSingle(apiKey)}`,
        `MITM_ROUTER_BASE=${shellQuoteSingle(mitmRouterBase)}`,
        "NODE_ENV=production",
        shellQuoteSingle(process.execPath),
        shellQuoteSingle(effectiveServerPath),
      ].join(" ");
      serverProcess = spawn("sudo", ["-S", "-E", "sh", "-c", inlineCmd], {
        detached: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        // Safe secret stripping only: argv contract preserved, but the child
        // env drops operator source vars and the root master key.
        env: buildChildEnv({}),
      });
      serverProcess.stdin.write(`${sudoPassword}\n`);
      serverProcess.stdin.end();
    } else if (isSudoAvailable()) {
      // HOME + credential travel via env only: raw token never appears in
      // argv, sudo command line, shell string, or logs. Sanitized: operator
      // startup vars and root key never reach the child.
      serverProcess = spawn("sudo", ["-S", "-E", process.execPath, effectiveServerPath], {
        detached: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: buildChildEnv({
          HOME: os.homedir(),
          ROUTER_API_KEY: spawnCredential.apiKey,
          NODE_ENV: "production",
          MITM_ROUTER_BASE: mitmRouterBase,
        }),
      });
      serverProcess.stdin.write(`${sudoPassword}\n`);
      serverProcess.stdin.end();
    } else {
      // Docker/minimal images: no sudo — same as Windows-style direct spawn
      serverProcess = spawn(process.execPath, [effectiveServerPath], {
        detached: false,
        windowsHide: true,
        cwd: os.tmpdir(),
        stdio: ["ignore", "pipe", "pipe"],
        env: buildChildEnv({
          ROUTER_API_KEY: spawnCredential.apiKey,
          NODE_ENV: "production",
          MITM_ROUTER_BASE: mitmRouterBase,
        }),
      });
    }

    if (serverProcess) {
      serverPid = serverProcess.pid;
      fs.writeFileSync(PID_FILE, String(serverPid));
      mitmLastStartTime = Date.now();
    }

    // Set NODE_EXTRA_CA_CERTS so Node-based GUI apps (Electron/AG language_server) trust MITM cert
    if (IS_MAC) {
      const rootCAPath = path.join(MITM_DIR, "rootCA.crt");
      if (fs.existsSync(rootCAPath)) {
        exec(`launchctl setenv NODE_EXTRA_CA_CERTS "${rootCAPath}"`, { windowsHide: true }, (e) => {
          if (e) log(`[launchctl] Failed to set NODE_EXTRA_CA_CERTS: ${e.message}`);
          else log(`[launchctl] NODE_EXTRA_CA_CERTS set to ${rootCAPath}`);
        });
      }
    } else if (IS_WIN) {
      const rootCAPath = path.join(MITM_DIR, "rootCA.crt");
      if (fs.existsSync(rootCAPath)) {
        exec(`setx NODE_EXTRA_CA_CERTS "${rootCAPath}"`, { windowsHide: true }, (e) => {
          if (e) log(`[setx] Failed to set NODE_EXTRA_CA_CERTS: ${e.message}`);
          else log(`[setx] NODE_EXTRA_CA_CERTS set for current user`);
        });
      }
    }

    let startError = null;
    if (serverProcess) {
      const stdoutWriter = createSecretRedactingWriter(
        (s) => process.stdout.write(s),
        _activeRawCredential,
      );
      serverProcess.stdout.on("data", (data) => {
        // server.js already formats its own logs — print as-is
        stdoutWriter(data.toString());
      });
      const stderrWriter = createSecretRedactingWriter((chunk) => {
        const msg = chunk.trim();
        if (msg && (IS_WIN || (!msg.includes("Password:") && !msg.includes("password for")))) {
          err(msg);
          startError = msg;
        }
        if (
          !IS_WIN &&
          (msg.includes("incorrect password") || msg.includes("no password was provided"))
        ) {
          setCachedPassword(null);
          clearEncryptedPassword();
          mitmIsRestarting = true;
        }
      }, _activeRawCredential);
      serverProcess.stderr.on("data", (data) => stderrWriter(data.toString()));
      serverProcess.on("error", () => {
        // OS spawn errors can contain argv/env; expose fixed text only.
        startError = "MITM child spawn failed";
      });
      serverProcess.on("exit", (code) => {
        log(`Server exited (code: ${code})`);
        serverProcess = null;
        serverPid = null;
        try {
          fs.unlinkSync(PID_FILE);
        } catch {
          /* ignore */
        }
        try {
          fs.unlinkSync(LOCK_FILE);
        } catch {
          /* ignore */
        }
        // Auto-restart on unexpected exit. Managed mode reuses the parent-memory
        // binding / startup source (pass null); legacy reuses the caller key.
        if (code !== 0 && !mitmIsRestarting) scheduleMitmRestart(managed ? null : callerApiKey);
      });
    }

    const health = await pollMitmHealth(8000, MITM_PORT);
    if (!health) {
      if (serverProcess && !serverProcess.killed) {
        try {
          serverProcess.kill();
        } catch {
          /* ignore */
        }
        serverProcess = null;
      }
      const processUsing443 = getProcessUsingPort443();
      const portInfo = processUsing443 ? ` Port 443 already in use by ${processUsing443}.` : "";
      const reason = startError || `Check sudo password or port 443 access.${portInfo}`;
      throw new Error(`MITM server failed to start. ${reason}`);
    }

    if (_updateSettings) await _updateSettings({ mitmCertInstalled: true }).catch(() => {});

    log(`✅ Server healthy (PID: ${serverPid || health.pid})`);

    // Log DNS status per tool
    const dnsStatus = checkAllDNSStatus();
    for (const [tool, active] of Object.entries(dnsStatus)) {
      log(`🌐 DNS ${tool}: ${active ? "✅ active" : "❌ inactive"}`);
    }

    await saveMitmSettings(true, sudoPassword);
    if (sudoPassword) setCachedPassword(sudoPassword);

    // Server is healthy — remove lock file (PID file persists as the marker)
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {
      /* ignore */
    }

    // Healthy child owns the verifier; reopen the exit-driven restart path.
    mitmIsRestarting = false;
    return { running: true, pid: serverPid };
  } catch (spawnErr) {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill();
      serverProcess = null;
      serverPid = null;
    }
    if (managed) spawnErr.message = redactLifecycleSecret(spawnErr.message);
    // Failed spawn rolls back its verifier — never a newer replacement's.
    if (spawnCredential && spawnCredential.mode === "local") {
      const state = _mitmLifecycleState;
      _mitmLifecycleState = null;
      await clearMitmLifecycleCredential(state);
    }
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {
      /* ignore */
    }
    throw spawnErr;
  }
}

/**
 * Stop MITM server — removes ALL tool DNS entries first, then kills server
 */
async function stopServer(sudoPassword) {
  // Prevent auto-restart from triggering on intentional stop
  mitmIsRestarting = true;
  mitmRestartCount = 0;
  log("⏹ Stopping server...");

  // Kill server process
  const proc = serverProcess;
  const pidToKill =
    proc && !proc.killed
      ? proc.pid
      : (() => {
          try {
            return parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
          } catch {
            return null;
          }
        })();

  if (pidToKill && isProcessAlive(pidToKill)) {
    log(`Killing server (PID: ${pidToKill})...`);
    killProcess(pidToKill, false, sudoPassword);
    await new Promise((r) => setTimeout(r, 1000));
    if (isProcessAlive(pidToKill)) killProcess(pidToKill, true, sudoPassword);
  }
  serverProcess = null;
  serverPid = null;

  if (IS_WIN) {
    const hostsFile = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "drivers",
      "etc",
      "hosts",
    );
    const allHosts = Object.values(TOOL_HOSTS).flat();
    try {
      const { isAdmin, runElevatedPowerShell, quotePs } = require("./winElevated.js");
      if (isAdmin()) {
        // Direct fs write — bypass PowerShell to avoid parser pitfalls
        const content = fs.readFileSync(hostsFile, "utf8");
        const filtered = content
          .split(/\r?\n/)
          .filter((l) => !allHosts.some((h) => l.includes(h)))
          .join("\r\n");
        const next = filtered.replace(/[\r\n\s]+$/g, "") + "\r\n";
        if (next !== content) fs.writeFileSync(hostsFile, next, "utf8");
        try {
          require("child_process").execSync("ipconfig /flushdns", {
            windowsHide: true,
            stdio: "ignore",
          });
        } catch {
          /* ignore */
        }
        log("🌐 DNS: ✅ all tool hosts removed");
      } else {
        const hostsList = allHosts.map(quotePs).join(",");
        const script = `
          $hosts = @(${hostsList})
          $lines = Get-Content -LiteralPath ${quotePs(hostsFile)}
          $filtered = $lines | Where-Object {
            $line = $_
            -not ($hosts | Where-Object { $line -match [regex]::Escape($_) })
          }
          Set-Content -LiteralPath ${quotePs(hostsFile)} -Value $filtered
          ipconfig /flushdns | Out-Null
        `;
        await runElevatedPowerShell(script);
      }
    } catch (e) {
      err(`Failed to clean hosts: ${e.message}`);
    }
  } else {
    await removeAllDNSEntries(sudoPassword);
  }

  // Unset NODE_EXTRA_CA_CERTS so apps don't keep trusting stale MITM cert
  if (IS_MAC) {
    exec(`launchctl unsetenv NODE_EXTRA_CA_CERTS`, { windowsHide: true }, (e) => {
      if (e) log(`[launchctl] Failed to unset NODE_EXTRA_CA_CERTS: ${e.message}`);
      else log(`[launchctl] NODE_EXTRA_CA_CERTS unset`);
    });
  } else if (IS_WIN) {
    exec(`reg delete HKCU\\Environment /F /V NODE_EXTRA_CA_CERTS`, { windowsHide: true }, (e) => {
      if (e) log(`[reg] Failed to unset NODE_EXTRA_CA_CERTS: ${e.message}`);
      else log(`[reg] NODE_EXTRA_CA_CERTS unset`);
    });
  }

  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    /* ignore */
  }
  await clearMitmLifecycleCredential(_mitmLifecycleState);
  _mitmLifecycleState = null;
  _activeRawCredential = null;
  await saveMitmSettings(false, null);
  mitmIsRestarting = false;

  return { running: false, pid: null };
}

/**
 * Enable DNS for a specific tool (requires server running)
 */
async function enableToolDNS(tool, sudoPassword) {
  const status = await getMitmStatus();
  if (!status.running) throw new Error("MITM server is not running. Start the server first.");

  const password = sudoPassword || getCachedPassword() || (await loadEncryptedPassword());
  await addDNSEntry(tool, password);
  await saveDnsToolState(tool, true);
  return { success: true };
}

/**
 * Disable DNS for a specific tool
 */
async function disableToolDNS(tool, sudoPassword) {
  const password = sudoPassword || getCachedPassword() || (await loadEncryptedPassword());
  await removeDNSEntry(tool, password);
  await saveDnsToolState(tool, false);
  return { success: true };
}

/**
 * Install Root CA to system trust store (standalone, no server start)
 */
async function trustCert(sudoPassword) {
  const rootCACertPath = path.join(MITM_DIR, "rootCA.crt");
  if (!fs.existsSync(rootCACertPath))
    throw new Error("Root CA not found. Start server first to generate it.");
  const { installCert } = require("./cert/install");
  if (!IS_WIN && !IS_MAC && !isSudoAvailable()) {
    log(`🔐 Cert: system trust unavailable (no sudo). Use file: ${rootCACertPath}`);
    return;
  }
  const password = sudoPassword || getCachedPassword() || (await loadEncryptedPassword());
  if (!password && isSudoPasswordRequired())
    throw new Error("Sudo password required to trust certificate");
  await installCert(password, rootCACertPath);
  if (password) setCachedPassword(password);
}

// Legacy aliases for backward compatibility
const startMitm = startServer;
const stopMitm = stopServer;

module.exports = {
  getMitmStatus,
  startServer,
  stopServer,
  enableToolDNS,
  disableToolDNS,
  trustCert,
  // Legacy
  startMitm,
  stopMitm,
  getCachedPassword,
  setCachedPassword,
  loadEncryptedPassword,
  clearEncryptedPassword,
  isSudoPasswordRequired,
  initDbHooks,
  initMitmCredentialHooks,
  isValidManualCredential,
  assertMitmStartupSourceCompatible,
  getMitmCredentialStatus,
  hasManualRemoteBinding,
  restoreToolDNS,
  hasDnsPrivilege,
  removeAllDNSEntriesSync,
};
