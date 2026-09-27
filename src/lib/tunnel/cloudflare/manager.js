import { loadState, saveState, generateShortId } from "../shared/state.js";
import {
  spawnQuickTunnel,
  killCloudflared,
  isCloudflaredRunning,
  setUnexpectedExitHandler,
} from "./cloudflared.js";
import { clearPid } from "./pid.js";
import { waitForHealth, probeUrlAlive } from "./healthCheck.js";
import { getTunnelRelay } from "./config.js";
import { buildPublicUrl } from "./relay.js";
import { getSettings, updateSettings } from "@/lib/localDb";

const svc = {
  cancelToken: { cancelled: false },
  spawnInProgress: false,
  lastRestartAt: 0,
  activeLocalPort: null,
};

export function getTunnelService() {
  return svc;
}
export function isTunnelManuallyDisabled() {
  return svc.cancelToken.cancelled;
}
export function isTunnelReconnecting() {
  return svc.spawnInProgress;
}

let onUnexpectedExit = null;
export function setTunnelUnexpectedExitCallback(cb) {
  onUnexpectedExit = cb;
}

// Only talks to a relay you configured yourself (TUNNEL_WORKER_URL); no-op otherwise.
// Best-effort: called after local state is saved, and a failure is logged, not thrown.
export async function registerTunnelUrl(shortId, tunnelUrl, relay = getTunnelRelay()) {
  if (!relay) return;
  try {
    const res = await fetch(`${relay.origin}/api/tunnel/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shortId, tunnelUrl }),
    });
    if (!res.ok) console.warn(`[Tunnel] relay register failed: HTTP ${res.status}`);
  } catch (e) {
    console.warn(`[Tunnel] relay register failed: ${e.message}`);
  }
}

function throwIfCancelled(token) {
  if (token.cancelled) throw new Error("tunnel cancelled");
}

export async function enableTunnel(localPort = 20128) {
  console.log(`[Tunnel] enable start (port=${localPort})`);
  const relay = getTunnelRelay();
  svc.cancelToken = { cancelled: false };
  svc.activeLocalPort = localPort;
  svc.spawnInProgress = true;
  const token = svc.cancelToken;

  try {
    if (isCloudflaredRunning()) {
      const existing = loadState();
      if (existing?.tunnelUrl && existing?.shortId) {
        const publicUrl = buildPublicUrl({
          shortId: existing.shortId,
          tunnelUrl: existing.tunnelUrl,
          relay,
        });
        // Reuse only if BOTH direct + public URL alive (avoid stale socket after network change)
        const [directOk, publicOk] = await Promise.all([
          probeUrlAlive(existing.tunnelUrl),
          publicUrl === existing.tunnelUrl ? true : probeUrlAlive(publicUrl),
        ]);
        if (directOk && publicOk) {
          console.log(`[Tunnel] already running, reuse: ${existing.tunnelUrl}`);
          return {
            success: true,
            tunnelUrl: existing.tunnelUrl,
            shortId: existing.shortId,
            publicUrl,
            alreadyRunning: true,
          };
        }
        console.log(`[Tunnel] stale (direct=${directOk} public=${publicOk}), respawn`);
      }
    }

    killCloudflared(localPort);
    console.log("[Tunnel] killed existing cloudflared");
    throwIfCancelled(token);

    const existing = loadState();
    const shortId = existing?.shortId || generateShortId();

    const onUrlUpdate = async (url) => {
      if (token.cancelled) return;
      console.log(`[Tunnel] url updated: ${url}`);
      saveState({ shortId, tunnelUrl: url });
      await updateSettings({ tunnelEnabled: true, tunnelUrl: url });
      await registerTunnelUrl(shortId, url, relay);
    };

    // Register exit handler BEFORE spawn so it fires even on early exit
    setUnexpectedExitHandler(() => {
      console.warn("[Tunnel] cloudflared exited unexpectedly, scheduling respawn");
      if (onUnexpectedExit) onUnexpectedExit();
    });

    const { tunnelUrl } = await spawnQuickTunnel(localPort, onUrlUpdate);
    console.log(`[Tunnel] spawned: ${tunnelUrl}`);
    throwIfCancelled(token);

    const publicUrl = buildPublicUrl({ shortId, tunnelUrl, relay });
    saveState({ shortId, tunnelUrl });
    await updateSettings({ tunnelEnabled: true, tunnelUrl });
    await registerTunnelUrl(shortId, tunnelUrl, relay);
    console.log(`[Tunnel] ready shortId=${shortId} publicUrl=${publicUrl}`);

    try {
      await waitForHealth(publicUrl, token);
      console.log("[Tunnel] public URL healthy");
    } catch (e) {
      // Without a relay this probes *.trycloudflare.com from the server, whose DNS
      // can lag or be filtered even when clients reach the tunnel fine. Keep the
      // tunnel up and let the dashboard's browser-side ping report reachability.
      if (relay || token.cancelled) throw e;
      console.warn(
        `[Tunnel] direct URL not confirmed from this host (${e.message}); keeping tunnel up`,
      );
    }
    // With a relay, the direct probe is best-effort: *.trycloudflare.com DNS can lag
    if (publicUrl !== tunnelUrl) {
      if (!(await probeUrlAlive(tunnelUrl))) {
        console.warn("[Tunnel] direct URL not reachable yet, continuing via publicUrl");
      } else {
        console.log("[Tunnel] direct URL healthy");
      }
    }

    console.log("[Tunnel] enable success");
    return { success: true, tunnelUrl, shortId, publicUrl };
  } catch (e) {
    // Suppress noise when spawn was deliberately killed (restart/disable superseded it)
    if (!/cloudflared killed|tunnel cancelled/.test(e.message)) {
      console.error(`[Tunnel] enable error: ${e.message}`);
    }
    throw e;
  } finally {
    svc.spawnInProgress = false;
  }
}

export async function disableTunnel() {
  console.log("[Tunnel] disable");
  // Abort any in-flight enable so it cannot resurrect state after we clear it
  svc.cancelToken.cancelled = true;
  setUnexpectedExitHandler(null);

  try {
    killCloudflared(svc.activeLocalPort);
  } catch (e) {
    console.warn(`[Tunnel] kill warn: ${e.message}`);
  }
  clearPid();

  const state = loadState();
  if (state) saveState({ shortId: state.shortId, tunnelUrl: null });

  await updateSettings({ tunnelEnabled: false, tunnelUrl: "" });
  // Force-clear flags so a subsequent enable is not blocked by a stuck spawnInProgress
  svc.spawnInProgress = false;
  svc.activeLocalPort = null;
  return { success: true };
}

export async function getTunnelStatus() {
  const settings = await getSettings();
  const settingsEnabled = settings.tunnelEnabled === true;
  const state = loadState();
  const shortId = state?.shortId || "";
  const tunnelUrl = state?.tunnelUrl || "";
  const publicUrl = buildPublicUrl({ shortId, tunnelUrl, relay: getTunnelRelay() });

  // Lazy: skip PID probe entirely when user disabled tunnel
  const running = settingsEnabled ? isCloudflaredRunning() : false;

  return {
    enabled: settingsEnabled && running,
    settingsEnabled,
    tunnelUrl,
    shortId,
    publicUrl,
    running,
  };
}
