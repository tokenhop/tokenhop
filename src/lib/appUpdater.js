import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";
import { clearPid, loadPid } from "@/lib/tunnel/cloudflare/pid.js";
import { ACTIVE, LEGACY } from "@/shared/brand";

const MITM_PID_FILE = path.join(DATA_DIR, "mitm", ".mitm.pid");
// Written by the CLI launcher (cli/src/cli/utils/processControl.js). The active
// file first, then the legacy one — an old launcher may still be recorded there.
// legacy(9router): remove in v2
const LAUNCHER_PID_FILES = [...new Set([ACTIVE.pidFile, LEGACY.pidFile])].map((name) =>
  path.join(DATA_DIR, name),
);

const isPid = (pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid;

function readPid(file) {
  try {
    return parseInt(fs.readFileSync(file, "utf8").trim(), 10);
  } catch {
    return null;
  }
}

function forceKill(pid) {
  if (!isPid(pid)) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore", windowsHide: true, timeout: 3000 });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    /* already dead */
  }
}

// MITM may run as admin/sudo, so fall back to privileged kills.
function killMitmByPidFile() {
  const pid = readPid(MITM_PID_FILE);
  if (!isPid(pid)) return;
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore", windowsHide: true, timeout: 3000 });
    } catch {
      try {
        execSync(
          `powershell -NonInteractive -WindowStyle Hidden -Command "Stop-Process -Id ${pid} -Force"`,
          {
            stdio: "ignore",
            windowsHide: true,
            timeout: 3000,
          },
        );
      } catch {
        /* best effort */
      }
    }
  } else {
    try {
      execSync(`sudo -n kill -9 ${pid} 2>/dev/null`, { stdio: "ignore", timeout: 3000 });
    } catch {
      forceKill(pid);
    }
  }
  try {
    fs.unlinkSync(MITM_PID_FILE);
  } catch {
    /* best effort */
  }
}

function killCloudflaredByPidFile() {
  const pid = loadPid();
  if (!isPid(pid)) return;
  forceKill(pid);
  clearPid(pid);
}

// Stop only processes this install recorded in PID files — never match by name,
// which would kill unrelated Next.js apps, cloudflared tunnels, npm/npx, editors.
export async function killAppProcesses() {
  killMitmByPidFile();
  killCloudflaredByPidFile();
}

function readLauncherPid(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))?.launcher;
  } catch {
    return null;
  }
}

// Ask the CLI launcher that spawned this server to shut down, so its own cleanup
// (tray, MITM, tunnel, server) runs and it does not restart us. Only signals our
// direct parent, and only when the launcher PID file confirms it is the launcher.
export function stopLauncher() {
  const launcher = LAUNCHER_PID_FILES.map(readLauncherPid).find(
    (pid) => isPid(pid) && pid === process.ppid,
  );
  if (!launcher) return false;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /F /T /PID ${launcher}`, {
        stdio: "ignore",
        windowsHide: true,
        timeout: 3000,
      });
    } else {
      process.kill(launcher, "SIGTERM");
    }
    return true;
  } catch {
    return false;
  }
}
