// Process helpers for the launcher. Everything here targets processes by PID
// (PID file or exact listening port), never by substring-matching `ps` output,
// which used to SIGKILL unrelated Next.js apps, shells, and port clients.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { getDataDir } = require("../../../hooks/sqliteRuntime");

// The CLI build packs the brand module into cli/src/shared/; a repo checkout uses the source.
const PACKED_BRAND_MODULE = path.join(__dirname, "..", "..", "shared", "brand", "index.cjs");
const { ACTIVE, LEGACY } = require(
  fs.existsSync(PACKED_BRAND_MODULE)
    ? PACKED_BRAND_MODULE
    : path.join(__dirname, "..", "..", "..", "..", "src", "shared", "brand", "index.cjs"),
);

const isPid = (pid) => Number.isInteger(pid) && pid > 0;

// Resolved per call so DATA_DIR changes (tests, env) are honoured.
function getPidFilePath() {
  return path.join(getDataDir(), ACTIVE.pidFile);
}

// legacy(9router): remove in v2
// An old launcher may still be running and recording itself here; null under the 9router brand.
function getLegacyPidFilePath() {
  const file = path.join(getDataDir(), LEGACY.pidFile);
  return file === getPidFilePath() ? null : file;
}

function readPidRecord(file) {
  try {
    const { launcher, server } = JSON.parse(fs.readFileSync(file, "utf8"));
    return { launcher: isPid(launcher) ? launcher : null, server: isPid(server) ? server : null };
  } catch {
    return null;
  }
}

// Valid records from the active file, then the legacy one, without duplicates.
function readPidFiles() {
  const records = [];
  for (const file of [getPidFilePath(), getLegacyPidFilePath()]) {
    const rec = file && readPidRecord(file);
    if (rec && !records.some((r) => r.launcher === rec.launcher && r.server === rec.server)) {
      records.push(rec);
    }
  }
  return records;
}

function readPidFile() {
  return readPidFiles()[0] ?? null;
}

function writePidFile({ launcher, server }) {
  const file = getPidFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ launcher, server }));
  // legacy(9router): remove in v2
  // Drop the legacy file once the launcher it recorded is gone.
  const legacyFile = getLegacyPidFilePath();
  const legacy = legacyFile && readPidRecord(legacyFile);
  if (legacy && !(legacy.launcher && isAlive(legacy.launcher))) {
    try {
      fs.unlinkSync(legacyFile);
    } catch {
      /* best effort */
    }
  }
}

// Only the launcher that wrote the file may remove it (a newer launcher may own it now).
function removePidFileIfOwner(pid) {
  if (readPidFile()?.launcher !== pid) return false;
  try {
    fs.unlinkSync(getPidFilePath());
    return true;
  } catch {
    return false;
  }
}

function getCommandLine(pid) {
  if (!isPid(pid)) return null;
  try {
    if (process.platform === "linux") {
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim() || null;
    }
    const out =
      process.platform === "win32"
        ? execFileSync(
            "powershell",
            [
              "-NonInteractive",
              "-Command",
              `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
            ],
            { encoding: "utf8", windowsHide: true, timeout: 5000 },
          )
        : execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
            encoding: "utf8",
            timeout: 5000,
          });
    return out.trim() || null;
  } catch {
    return null;
  }
}

// A 9router launcher is node running a script whose path ends in `9router` (npm bin
// shim) or `9router/cli.js`. A bare "9router" substring is not enough: shells, editors
// and test runners inside a 9router checkout contain it too.
function isLauncherCommandLine(cmd) {
  if (!cmd) return false;
  const runsNode = /^"?(?:[^"]*[\\/])?node(?:\.exe)?"?(?:\s|$)/i.test(cmd.trim());
  const runs9router = /[\\/]9router(?:[\\/]cli\.js)?"?(?:\s|$)/i.test(cmd);
  return runsNode && runs9router;
}

function getParentPid(pid) {
  if (!isPid(pid)) return null;
  try {
    let out;
    if (process.platform === "linux") {
      // /proc/<pid>/stat: "pid (comm) state ppid ..."; comm may contain spaces/parens.
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      out = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1];
    } else if (process.platform === "win32") {
      out = execFileSync(
        "powershell",
        [
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 5000 },
      );
    } else {
      out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 5000,
      });
    }
    const ppid = Number(String(out).trim());
    return isPid(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

// `netstat -ano` rows: Proto  Local  Foreign  State  PID. Match the local port exactly
// (`findstr :80` also matched :8080) and only LISTENING rows (not connected clients).
function parseListeningPidsWindows(output, port) {
  const pids = new Set();
  for (const line of String(output).split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0].toUpperCase() !== "TCP" || cols[3] !== "LISTENING") continue;
    const local = cols[1];
    const pid = Number(cols[4]);
    if (local.slice(local.lastIndexOf(":") + 1) === String(port) && isPid(pid)) pids.add(pid);
  }
  return [...pids];
}

function findListeningPids(port) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
      });
      return parseListeningPidsWindows(out, port);
    }
    // -sTCP:LISTEN: `lsof -ti:PORT` also returns clients connected to that port.
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return [...new Set(out.split("\n").map(Number).filter(isPid))];
  } catch {
    return []; // lsof exits 1 when nothing listens
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// SIGTERM first (graceful) so the target can run its own cleanup, then SIGKILL.
function killPid(pid, { graceful = true } = {}) {
  if (!isPid(pid) || pid === process.pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 3000,
      });
      return;
    }
    if (graceful) {
      process.kill(pid, "SIGTERM");
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline && isAlive(pid)) sleepSync(100);
      if (!isAlive(pid)) return;
    }
    process.kill(pid, "SIGKILL");
  } catch {
    /* already dead or not ours */
  }
}

module.exports = {
  getPidFilePath,
  getLegacyPidFilePath,
  readPidFile,
  readPidFiles,
  writePidFile,
  removePidFileIfOwner,
  getCommandLine,
  getParentPid,
  isLauncherCommandLine,
  parseListeningPidsWindows,
  findListeningPids,
  isAlive,
  killPid,
};
