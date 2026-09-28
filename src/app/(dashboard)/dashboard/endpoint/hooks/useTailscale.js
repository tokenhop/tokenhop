"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { makePingTsHealth } from "./useReachableSync";
import { parseSseFrames } from "../remoteAccessLogic";

/**
 * Tailscale Funnel state machine: install (SSE progress log), connect (with
 * login/Funnel-enable wait loops that surface an explicit auth button instead
 * of popups), disconnect. Popups open only from explicit user clicks —
 * `requestUserAuth` stashes the URL and the view renders the button.
 *
 * @returns {object} Tailscale state, modal booleans, and handlers.
 */
export function useTailscale() {
  const [enabled, setEnabled] = useState(false);
  const [reachable, setReachable] = useState(false);
  const [everReachable, setEverReachable] = useState(false);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [status, setStatus] = useState(null);
  const [authUrl, setAuthUrl] = useState("");
  const [authLabel, setAuthLabel] = useState("");
  const [installed, setInstalled] = useState(null); // null=checking, true/false
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState([]);
  const [sudoPassword, setSudoPassword] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [showDisableModal, setShowDisableModal] = useState(false);
  const logRef = useRef(null);

  // Auto-scroll install log
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll effect only; ref reads are DOM sync, not reactive inputs.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [installLog]);

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

  const pingTsHealth = makePingTsHealth(setProgress);

  const requestUserAuth = (url, label) => {
    setAuthUrl(url);
    setAuthLabel(label);
  };

  const clearUserAuth = useCallback(() => {
    setAuthUrl("");
    setAuthLabel("");
  }, []);

  const checkInstalled = async () => {
    setInstalled(null);
    try {
      const res = await fetch("/api/tunnel/tailscale-check");
      if (res.ok) {
        const data = await res.json();
        setInstalled(data.installed);
        return data;
      }
    } catch {
      /* ignore */
    }
    setInstalled(false);
    return { installed: false };
  };

  const markConnected = async (tunnelUrl) => {
    setUrl(tunnelUrl || "");
    const ok = await pingTsHealth(tunnelUrl);
    setEnabled(true);
    setStatus(ok ? null : { type: "warning", message: "Connected but not reachable yet." });
  };

  const pollFunnelEnable = async (enableUrl) => {
    requestUserAuth(enableUrl, "Open Funnel Settings");
    setProgress('Click "Open Funnel Settings" to enable Funnel...');
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const res = await fetch("/api/tunnel/tailscale-enable", { method: "POST" });
        const data = await res.json();
        if (res.ok && data.success) {
          clearUserAuth();
          await markConnected(data.tunnelUrl);
          return;
        }
        if (data.funnelNotEnabled) continue;
        if (data.error) {
          clearUserAuth();
          setStatus({ type: "error", message: data.error });
          return;
        }
      } catch {
        /* retry */
      }
    }
    clearUserAuth();
    setStatus({ type: "error", message: "Timed out waiting for Funnel to be enabled." });
  };

  const installTailscale = async () => {
    setInstalling(true);
    setStatus(null);
    setInstallLog([]);
    try {
      const res = await fetch("/api/tunnel/tailscale-install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sudoPassword }),
      });
      setSudoPassword("");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = parseSseFrames(buffer);
        buffer = rest;
        for (const { event, data } of frames) {
          if (event === "progress") {
            setInstallLog((prev) => [...prev.slice(-50), data.message]);
          } else if (event === "done") {
            setInstalled(true);
            setInstalling(false);
            setShowModal(false);
            connectTailscale();
            return;
          } else if (event === "error") {
            setStatus({ type: "error", message: data.error || "Install failed" });
          }
        }
      }
    } catch (e) {
      setStatus({ type: "error", message: e.message });
    } finally {
      setInstalling(false);
    }
  };

  const connectTailscale = async () => {
    setShowModal(false);
    setConnecting(true);
    setLoading(true);
    setStatus(null);
    setProgress("Connecting...");
    clearUserAuth();
    try {
      const res = await fetch("/api/tunnel/tailscale-enable", { method: "POST" });
      const data = await res.json();

      if (res.ok && data.success) {
        await markConnected(data.tunnelUrl);
        return;
      }

      if (data.needsLogin && data.authUrl) {
        requestUserAuth(data.authUrl, "Open Login Page");
        setProgress('Login required — click "Open Login Page" to continue');
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          try {
            const r2 = await fetch("/api/tunnel/tailscale-check");
            if (r2.ok) {
              const check = await r2.json();
              if (check.loggedIn) {
                clearUserAuth();
                setProgress("Starting funnel...");
                const res2 = await fetch("/api/tunnel/tailscale-enable", { method: "POST" });
                const data2 = await res2.json();
                if (res2.ok && data2.success) {
                  await markConnected(data2.tunnelUrl);
                } else if (data2.funnelNotEnabled && data2.enableUrl) {
                  await pollFunnelEnable(data2.enableUrl);
                } else {
                  setStatus({ type: "error", message: data2.error || "Failed to start funnel" });
                }
                return;
              }
            }
          } catch {
            /* retry */
          }
        }
        clearUserAuth();
        setStatus({ type: "error", message: "Login timed out. Please try again." });
        return;
      }

      if (data.funnelNotEnabled && data.enableUrl) {
        await pollFunnelEnable(data.enableUrl);
        return;
      }

      setStatus({ type: "error", message: data.error || "Failed to connect" });
    } catch (error) {
      setStatus({ type: "error", message: error.message });
    } finally {
      setLoading(false);
      setConnecting(false);
      setProgress("");
      clearUserAuth();
    }
  };

  const disableTailscale = async () => {
    setLoading(true);
    setStatus(null);
    try {
      const res = await fetch("/api/tunnel/tailscale-disable", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setEnabled(false);
        setUrl("");
        setShowDisableModal(false);
        setStatus({ type: "success", message: "Tailscale disabled" });
      } else {
        setStatus({ type: "error", message: data.error || "Failed to disable Tailscale" });
      }
    } catch (e) {
      setStatus({ type: "error", message: e.message });
    } finally {
      setLoading(false);
    }
  };

  const openModal = async () => {
    setStatus(null);
    setInstallLog([]);
    const data = await checkInstalled();
    if (data?.installed && data?.hasCachedPassword) {
      await connectTailscale();
    } else {
      setShowModal(true);
    }
  };

  const stopWork = useCallback(() => {
    setLoading(false);
    setConnecting(false);
    setProgress("");
    clearUserAuth();
  }, [clearUserAuth]);

  const setTsLoading = useCallback(
    (next) => {
      // Parent "Stop" affordance passes `false`; a truthy value starts loading.
      if (next) setLoading(true);
      else stopWork();
    },
    [stopWork],
  );

  const setTsConnecting = useCallback(
    (next) => {
      if (next) setConnecting(true);
      else stopWork();
    },
    [stopWork],
  );

  const setTsProgress = useCallback(
    (next) => {
      // Parent "Stop" affordance passes `""`; anything else sets progress text.
      if (!next) stopWork();
      else setProgress(next);
    },
    [stopWork],
  );

  return {
    enabled,
    setEnabled,
    reachable,
    applyReachablePatch,
    everReachable,
    setEverReachable,
    url,
    setUrl,
    loading,
    progress,
    status,
    setStatus,
    authUrl,
    authLabel,
    installed,
    installing,
    installLog,
    sudoPassword,
    setSudoPassword,
    connecting,
    showModal,
    setShowModal,
    showDisableModal,
    setShowDisableModal,
    logRef,
    checkInstalled,
    installTailscale,
    connectTailscale,
    disableTailscale,
    openModal,
    stopWork,
    setTsLoading,
    setTsConnecting,
    setTsProgress,
    requestUserAuth,
    clearUserAuth,
  };
}
