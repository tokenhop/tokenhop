// Palette action verbs. Each calls an existing dashboard API with its
// existing contract and resolves to { level, message } for toast + live region.
import { readTunnelStatus } from "@/app/(dashboard)/dashboard/endpoint/remoteAccessLogic";
import { canExposeRemote } from "@/app/(dashboard)/dashboard/endpoint/endpointLogic";

const ok = (message) => ({ level: "success", message });
const fail = (message) => ({ level: "error", message });

async function readJson(res) {
  return res.json().catch(() => ({}));
}

/** POST /api/providers/test-batch { mode: "all" } */
export async function testAllProviders(fetchImpl = fetch) {
  try {
    const res = await fetchImpl("/api/providers/test-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "all" }),
    });
    const data = await readJson(res);
    if (!res.ok) return fail(data.error || "Provider test failed");
    const { passed = 0, failed = 0, total = 0 } = data.summary || {};
    if (failed > 0) return { level: "warning", message: `${passed} of ${total} tests passed` };
    return ok(total ? `All ${total} tests passed` : "No providers to test");
  } catch {
    return fail("Provider test failed");
  }
}

/** DELETE /api/translator/console-logs */
export async function clearConsoleLog(fetchImpl = fetch) {
  try {
    const res = await fetchImpl("/api/translator/console-logs", { method: "DELETE" });
    return res.ok ? ok("Console log cleared") : fail("Could not clear the console log");
  } catch {
    return fail("Could not clear the console log");
  }
}

/** POST /api/auth/logout; the caller redirects on success. */
export async function signOut(fetchImpl = fetch) {
  try {
    const res = await fetchImpl("/api/auth/logout", { method: "POST" });
    return res.ok ? ok("Signed out") : fail("Sign out failed");
  } catch {
    return fail("Sign out failed");
  }
}

/** GET /api/tunnel/status → true/false, or null when unknown. */
export async function readTunnelEnabled(fetchImpl = fetch) {
  try {
    const res = await fetchImpl("/api/tunnel/status", { cache: "no-store" });
    if (!res.ok) return null;
    return readTunnelStatus(await readJson(res)).tunnel.enabled;
  } catch {
    return null;
  }
}

/**
 * Start or stop the Cloudflare tunnel. Starting keeps the Endpoint page
 * security gate: require API key on, login on, custom password set.
 */
export async function setTunnel(enable, fetchImpl = fetch) {
  try {
    if (!enable) {
      const res = await fetchImpl("/api/tunnel/disable", { method: "POST" });
      const data = await readJson(res);
      return res.ok ? ok("Tunnel stopped") : fail(data.error || "Could not stop the tunnel");
    }
    const settingsRes = await fetchImpl("/api/settings");
    if (!settingsRes.ok) return fail("Could not read security settings");
    const settings = await readJson(settingsRes);
    if (!canExposeRemote(settings)) {
      return fail("Turn on Require API key and secure login before starting the tunnel");
    }
    const res = await fetchImpl("/api/tunnel/enable", { method: "POST" });
    const data = await readJson(res);
    if (!res.ok || !data.tunnelUrl) return fail(data.error || "Could not start the tunnel");
    return ok("Tunnel started");
  } catch {
    return fail(enable ? "Could not start the tunnel" : "Could not stop the tunnel");
  }
}
