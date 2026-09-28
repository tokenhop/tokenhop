"use client";

import { useState, useCallback } from "react";
import { makePingTunnelHealth } from "./useReachableSync";

/**
 * Cloudflare Tunnel state machine: enable (with cloudflared download
 * progress), disable, health ping, and the reachable tracking shared with
 * the status poll. Server is the source of truth for enabled/URLs; the
 * browser ping decides reachable.
 *
 * @returns {object} Tunnel state, modal booleans, handlers, and
 * `applyStatusData` (consumed by the coordinator after `/api/tunnel/status`).
 */
export function useCloudflareTunnel() {
  const [checking, setChecking] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [reachable, setReachable] = useState(false);
  const [everReachable, setEverReachable] = useState(false);
  const [url, setUrl] = useState("");
  const [publicUrl, setPublicUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [status, setStatus] = useState(null);
  const [showEnableModal, setShowEnableModal] = useState(false);
  const [showDisableModal, setShowDisableModal] = useState(false);

  // Reachable flips arrive from the shared tracker via the coordinator
  // (`applyReachablePatch`); a `null` verdict keeps the current value.
  // Stable identity (used as effect deps in the coordinator) via useCallback.
  const applyReachablePatch = useCallback((patch) => {
    if (patch && typeof patch === "object" && "reachable" in patch) {
      if (patch.reachable !== null) setReachable(patch.reachable);
      if (patch.everReachable) setEverReachable(true);
    } else {
      setReachable(patch);
    }
  }, []);

  const pingTunnelHealth = makePingTunnelHealth({
    setLoading,
    setProgress,
    setStatus,
    setEnabled,
  });

  const enableTunnel = async () => {
    setShowEnableModal(false);
    setLoading(true);
    setStatus(null);
    setProgress("Creating tunnel...");

    // Poll download progress while enable request is pending
    let polling = true;
    const pollProgress = async () => {
      while (polling) {
        try {
          const r = await fetch("/api/tunnel/status");
          if (r.ok) {
            const s = await r.json();
            if (s.download?.downloading) {
              setProgress(`Downloading cloudflared... ${s.download.progress}%`);
            } else if (polling) {
              setProgress("Creating tunnel...");
            }
          }
        } catch {
          /* ignore */
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    };
    pollProgress();

    try {
      const res = await fetch("/api/tunnel/enable", { method: "POST" });
      polling = false;
      const data = await res.json();
      if (!res.ok) {
        setStatus({ type: "error", message: data.error || "Failed to enable tunnel" });
        return;
      }
      const nextUrl = data.tunnelUrl;
      if (!nextUrl) {
        setStatus({ type: "error", message: "No tunnel URL returned" });
        return;
      }
      setUrl(nextUrl);
      setPublicUrl(data.publicUrl || "");
      await pingTunnelHealth(data.publicUrl, nextUrl);
    } catch (error) {
      setStatus({ type: "error", message: error.message });
    } finally {
      polling = false;
      setLoading(false);
      setProgress("");
    }
  };

  const disableTunnel = async () => {
    setLoading(true);
    setStatus(null);
    try {
      const res = await fetch("/api/tunnel/disable", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setEnabled(false);
        setUrl("");
        setPublicUrl("");
        setShowDisableModal(false);
        setStatus({ type: "success", message: "Tunnel disabled" });
      } else {
        setStatus({ type: "error", message: data.error || "Failed to disable tunnel" });
      }
    } catch (error) {
      setStatus({ type: "error", message: error.message });
    } finally {
      setLoading(false);
    }
  };

  const stopWork = useCallback(() => {
    setLoading(false);
    setProgress("");
    setChecking(false);
  }, []);

  const setTunnelLoading = useCallback(
    (next) => {
      // Parent "Stop" affordance passes `false`; a truthy value starts loading.
      if (next) setLoading(true);
      else stopWork();
    },
    [stopWork],
  );

  const setTunnelProgress = useCallback(
    (next) => {
      // Parent "Stop" affordance passes `""`; anything else sets progress text.
      if (!next) stopWork();
      else setProgress(next);
    },
    [stopWork],
  );

  return {
    checking,
    setChecking,
    enabled,
    setEnabled,
    reachable,
    applyReachablePatch,
    everReachable,
    setEverReachable,
    url,
    setUrl,
    publicUrl,
    setPublicUrl,
    loading,
    progress,
    status,
    setStatus,
    showEnableModal,
    setShowEnableModal,
    showDisableModal,
    setShowDisableModal,
    enableTunnel,
    disableTunnel,
    stopWork,
    setTunnelLoading,
    setTunnelProgress,
  };
}
