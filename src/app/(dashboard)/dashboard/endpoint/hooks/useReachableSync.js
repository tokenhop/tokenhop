"use client";

import { useEffect, useState } from "react";
import { createReachableTracker } from "../remoteAccessLogic";
import { REACHABLE_MISS_THRESHOLD } from "../endpointConstants";
import {
  STATUS_POLL_FAST_MS,
  CLIENT_PING_FAST_MS,
  TUNNEL_PING_INTERVAL_MS,
  TUNNEL_PING_MAX_MS,
} from "../endpointConstants";
import { clientPingUrl, clientPingAny } from "../endpointPing";

/**
 * Status poll: refresh `onSync` only while degraded (not yet reachable).
 * Stops once healthy to avoid spam; re-checks once when the tab is visible.
 *
 * @param {object} params
 * @param {boolean} params.anyEnabled At least one transport enabled.
 * @param {boolean} params.allHealthy Every enabled transport reachable.
 * @param {() => void} params.onSync Refresh from `/api/tunnel/status`.
 */
export function useDegradedStatusPoll({ anyEnabled, allHealthy, onSync }) {
  useEffect(() => {
    if (!anyEnabled) return undefined;
    const onVisible = () => {
      if (!document.hidden) onSync();
    };
    document.addEventListener("visibilitychange", onVisible);
    if (allHealthy) return () => document.removeEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => {
      if (!document.hidden) onSync();
    }, STATUS_POLL_FAST_MS);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [anyEnabled, allHealthy, onSync]);
}

/**
 * Shared remote-access state: the miss-debounced reachable trackers plus the
 * browser-side ping that probes enabled transports directly (immune to
 * backend DNS quirks). Tab-hidden pauses; the interval only runs while a
 * transport is enabled but not yet reachable. A `null` tracker verdict means
 * "below the miss threshold" — keep the previous reachable value.
 *
 * @param {object} params
 * @param {object} params.tunnel { enabled, reachable, url, publicUrl }
 * @param {(patch: { reachable: boolean|null, everReachable: boolean }) => void} params.setTunnel
 * @param {object} params.tailscale { enabled, reachable, url }
 * @param {(patch: { reachable: boolean|null, everReachable: boolean }) => void} params.setTailscale
 */
export function useReachableSync({ tunnel, setTunnel, tailscale, setTailscale }) {
  const [trackers] = useState(() => ({
    tunnel: createReachableTracker(REACHABLE_MISS_THRESHOLD),
    tailscale: createReachableTracker(REACHABLE_MISS_THRESHOLD),
  }));

  // Browser-side periodic ping while degraded; pause when tab hidden.
  useEffect(() => {
    let cancelled = false;
    const probeBoth = async () => {
      if (document.hidden || cancelled) return;
      if (tunnel.enabled && (tunnel.url || tunnel.publicUrl)) {
        const ok = await clientPingAny(tunnel.publicUrl, tunnel.url);
        if (!cancelled) setTunnel(trackers.tunnel.track(ok));
      } else {
        trackers.tunnel.forget();
      }
      if (tailscale.enabled && tailscale.url) {
        const ok = await clientPingUrl(tailscale.url);
        if (!cancelled) setTailscale(trackers.tailscale.track(ok));
      } else {
        trackers.tailscale.forget();
      }
    };
    const anyEnabled =
      (tunnel.enabled && (tunnel.url || tunnel.publicUrl)) || (tailscale.enabled && tailscale.url);
    if (!anyEnabled) return undefined;
    probeBoth();
    const tunnelHealthy = !tunnel.enabled || tunnel.reachable;
    const tsHealthy = !tailscale.enabled || tailscale.reachable;
    if (tunnelHealthy && tsHealthy) return undefined;
    const id = setInterval(probeBoth, CLIENT_PING_FAST_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [
    tunnel.enabled,
    tunnel.url,
    tunnel.publicUrl,
    tunnel.reachable,
    tailscale.enabled,
    tailscale.url,
    tailscale.reachable,
    setTunnel,
    setTailscale,
    trackers,
  ]);

  return trackers;
}

/**
 * Ping tunnel health until reachable. Races multiple URLs (shortlink +
 * direct) — 1 OK is enough. Every ~10s, checks whether the backend process
 * is still alive and bails early if it died.
 *
 * @param {object} deps
 * @param {(v: boolean) => void} deps.setLoading
 * @param {(v: string) => void} deps.setProgress
 * @param {(v: object|null) => void} deps.setStatus
 * @param {(v: boolean) => void} deps.setEnabled
 * @returns {(...urls: Array<string>) => Promise<boolean>}
 */
export function makePingTunnelHealth({ setLoading, setProgress, setStatus, setEnabled }) {
  return async (...urls) => {
    setLoading(true);
    setProgress("Waiting for tunnel ready...");
    const targets = urls.filter(Boolean).map((u) => `${u}/api/health`);
    const start = Date.now();
    while (Date.now() - start < TUNNEL_PING_MAX_MS) {
      await new Promise((r) => setTimeout(r, TUNNEL_PING_INTERVAL_MS));
      const ok = await Promise.any(
        targets.map(async (h) => {
          const p = await fetch(h, { mode: "cors", cache: "no-store" });
          if (p.ok) return true;
          throw new Error("not ready");
        }),
      ).catch(() => false);
      if (ok) {
        setEnabled(true);
        setLoading(false);
        setProgress("");
        return true;
      }
      // Every ~10s, check if backend process still alive
      if ((Date.now() - start) % 10000 < TUNNEL_PING_INTERVAL_MS) {
        try {
          const statusRes = await fetch("/api/tunnel/status");
          if (statusRes.ok) {
            const status = await statusRes.json();
            if (!status.tunnel?.enabled) {
              setStatus({ type: "error", message: "Tunnel process stopped unexpectedly." });
              setLoading(false);
              setProgress("");
              return false;
            }
          }
        } catch {
          /* ignore */
        }
      }
    }
    setStatus({
      type: "error",
      message: "Tunnel created but not reachable. Please try again.",
    });
    setLoading(false);
    setProgress("");
    return false;
  };
}

/**
 * Ping Tailscale health until reachable.
 *
 * @param {(v: string) => void} setProgress
 * @returns {(url: string) => Promise<boolean>}
 */
export function makePingTsHealth(setProgress) {
  return async (url) => {
    setProgress("Waiting for Tailscale ready...");
    const healthUrl = `${url}/api/health`;
    const start = Date.now();
    while (Date.now() - start < TUNNEL_PING_MAX_MS) {
      await new Promise((r) => setTimeout(r, TUNNEL_PING_INTERVAL_MS));
      try {
        const ping = await fetch(healthUrl, { mode: "no-cors", cache: "no-store" });
        if (ping.ok || ping.type === "opaque") return true;
      } catch {
        /* not ready yet */
      }
    }
    return false;
  };
}
