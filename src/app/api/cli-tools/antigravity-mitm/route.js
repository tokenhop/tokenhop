import { NextResponse } from "next/server";
import {
  getMitmStatus,
  startServer,
  stopServer,
  enableToolDNS,
  disableToolDNS,
  trustCert,
  getCachedPassword,
  setCachedPassword,
  loadEncryptedPassword,
  isSudoPasswordRequired,
  initDbHooks,
  isValidManualCredential,
  assertMitmStartupSourceCompatible,
  getMitmCredentialStatus,
} from "@/mitm/manager";
import { isCredentialEncryptionEstablished } from "@/lib/db/repos/settingsRepo.js";
import { getSettings, updateSettings } from "@/lib/localDb";
import runtimeCredentials from "@/mitm/runtimeCredentials";
import { ACTIVE } from "@/shared/brand";
import { audit } from "@/lib/users/audit.js";
import { getClientIp } from "@/lib/auth/loginLimiter.js";

initDbHooks(getSettings, updateSettings, isCredentialEncryptionEstablished);

// User-facing restart hint on Windows; names the product under the active brand.
const ADMIN_RESTART_MESSAGE = `Administrator required — restart ${ACTIVE.name} as Administrator`;

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";

function normalizeMitmRouterBaseUrlInput(input) {
  return runtimeCredentials.normalizeRouterBaseUrl(
    input == null || input === "" ? DEFAULT_MITM_ROUTER_BASE : input,
  );
}

const isWin = process.platform === "win32";

function getPassword(provided) {
  return provided || getCachedPassword() || null;
}

function requiresSudoPassword(pwd) {
  return !isWin && !pwd && isSudoPasswordRequired();
}

function checkIsAdmin() {
  if (isWin) {
    try {
      require("child_process").execSync("net session >nul 2>&1", { windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function checkPrivilege(pwd) {
  if (checkIsAdmin()) return true;
  if (isWin) return false;
  if (!isSudoPasswordRequired()) return true;
  return !!pwd;
}

// GET - Full MITM status (server + per-tool DNS)
export async function GET() {
  try {
    const status = await getMitmStatus();
    const settings = await getSettings();
    const { readStorageState } = await import("@/lib/auth/mitmCredential");
    const router = normalizeMitmRouterBaseUrlInput(settings.mitmRouterBaseUrl);
    const credentials = await getMitmCredentialStatus(router, (await readStorageState()).storage);
    const hasCachedPassword = !!getCachedPassword() || !!(await loadEncryptedPassword());
    return NextResponse.json({
      ...credentials,
      running: status.running,
      pid: status.pid || null,
      certExists: status.certExists || false,
      certTrusted: status.certTrusted || false,
      dnsStatus: status.dnsStatus || {},
      hasCachedPassword,
      isWin,
      needsSudoPassword: !isWin && !hasCachedPassword && isSudoPasswordRequired(),
      isAdmin: checkIsAdmin(),
      mitmRouterBaseUrl: router,
    });
  } catch (error) {
    if (error?.message === "Invalid MITM router base URL")
      return NextResponse.json({ error: "Invalid MITM router URL" }, { status: 400 });
    return NextResponse.json({ error: "Failed to get MITM status" }, { status: 500 });
  }
}

// POST - Start MITM using the manager's reviewed credential custody contract.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return NextResponse.json({ error: "Invalid MITM request" }, { status: 400 });
    const { apiKey, sudoPassword, mitmRouterBaseUrl, forceKillPort443 } = body;
    const { readStorageState, isLocalRouterBaseUrl } = await import("@/lib/auth/mitmCredential");
    const hashed = (await readStorageState()).storage === "hashed";
    const settings = await getSettings();
    let router;
    try {
      router = normalizeMitmRouterBaseUrlInput(mitmRouterBaseUrl ?? settings.mitmRouterBaseUrl);
    } catch {
      // Never echo the malformed destination back to the browser.
      return NextResponse.json({ error: "Invalid MITM router URL" }, { status: 400 });
    }
    if (!hashed && !apiKey) return NextResponse.json({ error: "Missing apiKey" }, { status: 400 });
    const remote = hashed && !isLocalRouterBaseUrl(router);
    // Bounded single-line validation before anything touches bindings or DB.
    if (remote && apiKey !== undefined && apiKey !== null && !isValidManualCredential(apiKey)) {
      return NextResponse.json({ error: "Invalid MITM credential" }, { status: 400 });
    }
    if (remote) await assertMitmStartupSourceCompatible(router, apiKey);
    const pwd = getPassword(sudoPassword) || (await loadEncryptedPassword()) || "";
    if (requiresSudoPassword(pwd))
      return NextResponse.json({ error: "Missing sudoPassword" }, { status: 400 });
    if (!checkPrivilege(pwd)) {
      return NextResponse.json(
        { error: isWin ? ADMIN_RESTART_MESSAGE : "Root or sudo password required to start MITM" },
        { status: 403 },
      );
    }
    if (mitmRouterBaseUrl !== undefined && mitmRouterBaseUrl !== null) {
      await updateSettings({ mitmRouterBaseUrl: router });
    }
    // Local managed starts ignore caller keys; only explicit remote starts bind.
    const result = await startServer(
      hashed && !remote ? undefined : apiKey,
      pwd,
      !!forceKillPort443,
    );
    if (!isWin) setCachedPassword(pwd);
    // YAN-367: audit the host op — never the apiKey/sudoPassword body fields.
    await audit(
      { ip: getClientIp(request) },
      "hostOps.mitm",
      { type: "hostOp", id: "mitm/start" },
      {
        after: { op: "start", running: result.running },
      },
    );
    return NextResponse.json({ success: true, running: result.running, pid: result.pid });
  } catch (error) {
    if (error?.code === "API_KEY_STATE_INVALID")
      return NextResponse.json({ error: "Key storage unavailable" }, { status: 503 });
    if (error?.code === "MITM_STARTUP_SOURCE_LOCKED")
      // Explicit precedence conflict — static guidance only, never the typed
      // value or any operator secret. Not 500-success masquerading as installed.
      return NextResponse.json(
        {
          error:
            "MITM remote credential uses the operator startup source. Omit apiKey to use that source, or clear the startup source and restart the parent to use a typed credential.",
          code: "MITM_STARTUP_SOURCE_LOCKED",
        },
        { status: 409 },
      );
    if (error.code === "PORT_443_BUSY")
      return NextResponse.json(
        { error: error.message, code: "PORT_443_BUSY", portOwner: error.portOwner },
        { status: 409 },
      );
    if (
      [
        "Invalid MITM credential",
        "Invalid MITM router base URL",
        "Remote MITM router needs an operator-supplied credential",
      ].includes(error?.message)
    )
      return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "Failed to start MITM server" }, { status: 500 });
  }
}

// DELETE - Stop MITM server (removes all DNS first, then kills server)
export async function DELETE(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { sudoPassword } = body;
    const pwd = getPassword(sudoPassword) || (await loadEncryptedPassword()) || "";

    if (requiresSudoPassword(pwd)) {
      return NextResponse.json({ error: "Missing sudoPassword" }, { status: 400 });
    }

    await stopServer(pwd);
    if (!isWin && sudoPassword) setCachedPassword(sudoPassword);

    // YAN-367: audit the host op.
    await audit(
      { ip: getClientIp(request) },
      "hostOps.mitm",
      { type: "hostOp", id: "mitm/stop" },
      {
        after: { op: "stop" },
      },
    );
    return NextResponse.json({ success: true, running: false });
  } catch (error) {
    console.log("Error stopping MITM server:", error.message);
    return NextResponse.json(
      { error: error.message || "Failed to stop MITM server" },
      { status: 500 },
    );
  }
}

// PATCH - Toggle DNS for a specific tool (enable/disable)
export async function PATCH(request) {
  try {
    const { tool, action, sudoPassword } = await request.json();
    const pwd = getPassword(sudoPassword) || (await loadEncryptedPassword()) || "";

    if (!tool || !action) {
      return NextResponse.json({ error: "tool and action required" }, { status: 400 });
    }
    if (requiresSudoPassword(pwd)) {
      return NextResponse.json({ error: "Missing sudoPassword" }, { status: 400 });
    }
    if (!checkPrivilege(pwd)) {
      return NextResponse.json(
        {
          error: isWin ? ADMIN_RESTART_MESSAGE : "Root or sudo password required to modify DNS",
        },
        { status: 403 },
      );
    }

    if (action === "enable") {
      await enableToolDNS(tool, pwd);
    } else if (action === "disable") {
      await disableToolDNS(tool, pwd);
    } else if (action === "trust-cert") {
      await trustCert(pwd);
      if (!isWin && sudoPassword) setCachedPassword(sudoPassword);
      const status = await getMitmStatus();
      return NextResponse.json({ success: true, certTrusted: status.certTrusted });
    } else {
      return NextResponse.json(
        { error: "action must be enable, disable, or trust-cert" },
        { status: 400 },
      );
    }

    if (!isWin && sudoPassword) setCachedPassword(sudoPassword);

    const status = await getMitmStatus();
    // YAN-367: audit the host op (tool DNS toggle / trust-cert).
    await audit(
      { ip: getClientIp(request) },
      "hostOps.mitm",
      { type: "hostOp", id: `mitm/${action}` },
      { after: { op: action, tool: typeof tool === "string" ? tool : null } },
    );
    return NextResponse.json({ success: true, dnsStatus: status.dnsStatus });
  } catch (error) {
    console.log("Error toggling DNS:", error.message);
    return NextResponse.json({ error: error.message || "Failed to toggle DNS" }, { status: 500 });
  }
}
