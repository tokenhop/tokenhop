"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { isLoginUnsafe as unsafeLogin, canExposeRemote } from "../endpointLogic";
import { readTunnelStatus } from "../remoteAccessLogic";
import { useCloudflareTunnel } from "./useCloudflareTunnel";
import { useTailscale } from "./useTailscale";
import { useDegradedStatusPoll, useReachableSync } from "./useReachableSync";
import { useSettingsScope } from "@/shared/hooks/useSettingsScope";

/**
 * Coordinator for remote access: Cloudflare Tunnel + Tailscale Funnel plus
 * the settings flags that gate remote exposure (requireApiKey, requireLogin,
 * tunnelDashboardAccess). Owns the shared reachable tracking (miss-debounced
 * flips fed by the browser ping), the degraded status poll, and the initial
 * settings + status load. Transport lifecycles live in `useCloudflareTunnel`
 * and `useTailscale`; this hook wires them together and preserves the exact
 * public shape the endpoint page consumes.
 *
 * Data discipline (fetch-storm guard): the initial load fires exactly once
 * per mount (StrictMode dev double-invoke aside) — one `loadSettings` call
 * that fetches settings + status in parallel. Afterwards only the documented
 * degraded poll (`STATUS_POLL_FAST_MS`, transports enabled but unreachable)
 * and the browser ping (`CLIENT_PING_FAST_MS`) hit the network. No polling
 * loop and no effect re-fires while idle.
 *
 * Capability gate (YAN-769): `/api/settings` needs `instance.settings.manage`
 * (`canManageInstance`); `/api/tunnel/*` needs `instance.hostOps`
 * (`canHostOps`). Both are 403 for members. Nothing is fetched, polled, or
 * patched until the auth scope has resolved AND the matching capability is
 * held; switch off (one user) resolves to both, so those calls are
 * unchanged. A load that finishes after access was lost is discarded.
 *
 * Trust user intent (`settingsEnabled`): UI stays "enabled" while the
 * watchdog restarts the backend process.
 *
 * @returns {object} All tunnel/tailscale/settings state, modal booleans,
 * handlers, and the `canEnableRemote` / `isLoginUnsafe` / gate-note derivations.
 */
export function useTunnelControls() {
  const [requireApiKey, setRequireApiKey] = useState(false);
  const [requireLogin, setRequireLogin] = useState(true);
  const [hasPassword, setHasPassword] = useState(true);
  const [tunnelDashboardAccess, setTunnelDashboardAccess] = useState(false);

  const { ready, canManageInstance, canHostOps } = useSettingsScope();
  const settingsAllowed = ready && canManageInstance;
  const hostAllowed = ready && canHostOps;
  const settingsRef = useRef(settingsAllowed);
  settingsRef.current = settingsAllowed;
  const hostRef = useRef(hostAllowed);
  hostRef.current = hostAllowed;
  // Bumped whenever either capability changes: loads started before are stale.
  const epochRef = useRef(0);

  const isHostAllowed = useCallback(() => hostRef.current, []);
  const tunnel = useCloudflareTunnel(isHostAllowed);
  const ts = useTailscale(isHostAllowed);

  // Latest-value refs: effects below run once on mount / on primitive deps.
  // Refs always point at the current closures so stable callbacks never go
  // stale; no whole-object deps (new identity per render = fetch storm).
  const tunnelRef = useRef(tunnel);
  tunnelRef.current = tunnel;
  const tsRef = useRef(ts);
  tsRef.current = ts;

  // Security gate derivations (shared pure logic).
  const isLoginUnsafe = unsafeLogin({ requireLogin, hasPassword });
  const canEnableRemote = canExposeRemote({ requireLogin, hasPassword, requireApiKey });
  const unsafeReason = !requireLogin
    ? 'Enable "Require login" and set a custom password before activating the tunnel.'
    : "Change the default dashboard password before activating the tunnel.";
  const gateNote = !requireApiKey ? "Requires API key to be on." : unsafeReason;

  // Trust user intent (settingsEnabled): UI stays "enabled" while watchdog restarts process
  const syncTunnelStatus = useCallback(async () => {
    if (!hostRef.current) return;
    const epoch = epochRef.current;
    const { tunnel: t, ts: s } = { tunnel: tunnelRef.current, ts: tsRef.current };
    try {
      const statusRes = await fetch("/api/tunnel/status", { cache: "no-store" });
      if (!statusRes.ok) return;
      const data = await statusRes.json();
      if (epoch !== epochRef.current || !hostRef.current) return;
      const parsed = readTunnelStatus(data);
      t.setUrl(parsed.tunnel.url);
      t.setPublicUrl(parsed.tunnel.publicUrl);
      t.setEnabled(parsed.tunnel.enabled);
      s.setUrl(parsed.tailscale.url);
      s.setEnabled(parsed.tailscale.enabled);
    } catch {
      /* ignore poll errors */
    }
  }, []);

  const loadSettings = useCallback(async () => {
    const wantSettings = settingsRef.current;
    const wantStatus = hostRef.current;
    if (!wantSettings && !wantStatus) return;
    const epoch = epochRef.current;
    const { tunnel: t, ts: s } = { tunnel: tunnelRef.current, ts: tsRef.current };
    t.setChecking(true);
    try {
      const [settingsRes, statusRes] = await Promise.all([
        wantSettings ? fetch("/api/settings") : null,
        wantStatus ? fetch("/api/tunnel/status", { cache: "no-store" }) : null,
      ]);
      const settingsData = settingsRes?.ok ? await settingsRes.json() : null;
      const statusData = statusRes?.ok ? await statusRes.json() : null;
      if (epoch !== epochRef.current) return;
      if (settingsData && settingsRef.current) {
        const data = settingsData;
        setRequireApiKey(data.requireApiKey || false);
        setRequireLogin(data.requireLogin !== false);
        setHasPassword(data.hasPassword || false);
        setTunnelDashboardAccess(data.tunnelDashboardAccess || false);
      }
      if (statusData && hostRef.current) {
        const parsed = readTunnelStatus(statusData);
        t.setUrl(parsed.tunnel.url);
        t.setPublicUrl(parsed.tunnel.publicUrl);
        t.setEnabled(parsed.tunnel.enabled);
        s.setUrl(parsed.tailscale.url);
        s.setEnabled(parsed.tailscale.enabled);
      }
    } catch (error) {
      console.log("Error loading settings:", error);
    } finally {
      t.setChecking(false);
    }
  }, []);

  // Load once when access resolves (v1: once on mount). No whole-object deps.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the two capabilities only; latest closures via refs.
  useEffect(() => {
    epochRef.current += 1;
    if (settingsAllowed || hostAllowed) loadSettings();
    else if (ready) tunnelRef.current.setChecking(false);
  }, [settingsAllowed, hostAllowed]);

  // Shared reachable tracking + browser ping (one tracker per transport).
  // Stable patch callbacks → no interval resets from the coordinator.
  useReachableSync({
    tunnel: {
      enabled: hostAllowed && tunnel.enabled,
      reachable: tunnel.reachable,
      url: tunnel.url,
      publicUrl: tunnel.publicUrl,
    },
    setTunnel: tunnel.applyReachablePatch,
    tailscale: { enabled: hostAllowed && ts.enabled, reachable: ts.reachable, url: ts.url },
    setTailscale: ts.applyReachablePatch,
  });

  // Status poll only while degraded; stops once healthy. syncTunnelStatus is
  // stable (refs inside), so the interval survives re-renders.
  useDegradedStatusPoll({
    anyEnabled: hostAllowed && (tunnel.enabled || ts.enabled),
    allHealthy: (!tunnel.enabled || tunnel.reachable) && (!ts.enabled || ts.reachable),
    onSync: syncTunnelStatus,
  });

  const handleTunnelDashboardAccess = async (value) => {
    if (!settingsRef.current) return;
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tunnelDashboardAccess: value }),
      });
      if (res.ok) setTunnelDashboardAccess(value);
    } catch (error) {
      console.log("Error updating tunnelDashboardAccess:", error);
    }
  };

  const handleRequireApiKey = async (value) => {
    if (!settingsRef.current) return;
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireApiKey: value }),
      });
      if (res.ok) setRequireApiKey(value);
    } catch (error) {
      console.log("Error updating requireApiKey:", error);
    }
  };

  const handleRequireLogin = async (value) => {
    if (!settingsRef.current) return;
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireLogin: value }),
      });
      if (res.ok) setRequireLogin(value);
    } catch (error) {
      console.log("Error updating requireLogin:", error);
    }
  };

  return {
    // false: hide instance settings controls / host-level remote access
    canManage: settingsAllowed,
    canHost: hostAllowed,
    // settings
    requireApiKey,
    requireLogin,
    hasPassword,
    tunnelDashboardAccess,
    handleRequireApiKey,
    handleRequireLogin,
    handleTunnelDashboardAccess,
    loadSettings,
    // derivations
    isLoginUnsafe,
    canEnableRemote,
    unsafeReason,
    gateNote,
    // tunnel
    tunnelChecking: tunnel.checking,
    setTunnelChecking: tunnel.setChecking,
    tunnelEnabled: tunnel.enabled,
    tunnelReachable: tunnel.reachable,
    tunnelEverReachable: tunnel.everReachable,
    tunnelUrl: tunnel.url,
    tunnelPublicUrl: tunnel.publicUrl,
    tunnelLoading: tunnel.loading,
    setTunnelLoading: tunnel.setTunnelLoading,
    tunnelProgress: tunnel.progress,
    setTunnelProgress: tunnel.setTunnelProgress,
    tunnelStatus: tunnel.status,
    setTunnelStatus: tunnel.setStatus,
    showEnableTunnelModal: tunnel.showEnableModal,
    setShowEnableTunnelModal: tunnel.setShowEnableModal,
    showDisableTunnelModal: tunnel.showDisableModal,
    setShowDisableTunnelModal: tunnel.setShowDisableModal,
    syncTunnelStatus,
    handleEnableTunnel: tunnel.enableTunnel,
    handleDisableTunnel: tunnel.disableTunnel,
    // tailscale
    tsEnabled: ts.enabled,
    tsReachable: ts.reachable,
    tsEverReachable: ts.everReachable,
    tsUrl: ts.url,
    tsLoading: ts.loading,
    setTsLoading: ts.setTsLoading,
    tsProgress: ts.progress,
    setTsProgress: ts.setTsProgress,
    tsStatus: ts.status,
    setTsStatus: ts.setStatus,
    tsAuthUrl: ts.authUrl,
    tsAuthLabel: ts.authLabel,
    tsInstalled: ts.installed,
    tsInstalling: ts.installing,
    tsInstallLog: ts.installLog,
    tsSudoPassword: ts.sudoPassword,
    setTsSudoPassword: ts.setSudoPassword,
    tsConnecting: ts.connecting,
    setTsConnecting: ts.setTsConnecting,
    showTsModal: ts.showModal,
    setShowTsModal: ts.setShowModal,
    showDisableTsModal: ts.showDisableModal,
    setShowDisableTsModal: ts.setShowDisableModal,
    tsLogRef: ts.logRef,
    checkTailscaleInstalled: ts.checkInstalled,
    handleInstallTailscale: ts.installTailscale,
    handleConnectTailscale: ts.connectTailscale,
    handleDisableTailscale: ts.disableTailscale,
    handleOpenTsModal: ts.openModal,
    pollFunnelEnable: () => Promise.resolve(),
    requestUserAuth: ts.requestUserAuth,
    clearUserAuth: ts.clearUserAuth,
    updateReachable: () => {},
  };
}
