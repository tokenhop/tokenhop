"use client";

import { useEffect, useState } from "react";

const REFRESH_MS = 60_000;
// Tab focus refreshes only when the last summary is older than this.
export const FOCUS_THROTTLE_MS = 15_000;

const INITIAL_STATE = {
  loading: true,
  gatewayOnline: null,
  startedAt: null,
  serverPort: null,
  badges: { providers: null, combos: null, quota: null },
  providerAttention: { count: 0, status: null },
  enableTranslator: false,
  // YAN-408: heartbeat sparkline series and pending savings milestone toast.
  traffic: null,
  savingsMilestone: null,
};

const count = (value, prev) => (Number.isInteger(value) && value >= 0 ? value : prev);

/**
 * Next shell state from a GET /api/shell/summary result. A network failure
 * (null) or a 5xx means the gateway is offline; any other response proves it
 * answered. Badges, heartbeat traffic and the milestone keep their previous
 * values unless a 2xx body carries them, so a failed poll never flashes fake
 * zeros.
 * @param {object} prev Current shell state.
 * @param {number|null} status HTTP status, or null on network failure.
 * @param {object|null} body Parsed 2xx body.
 */
export function applyShellSummary(prev, status, body) {
  const next = { ...prev, loading: false };
  if (status === null || status >= 500) {
    return { ...next, gatewayOnline: false, startedAt: null, serverPort: null };
  }
  next.gatewayOnline = true;
  if (!body || typeof body !== "object") return next;
  const gateway = body.gateway || {};
  next.startedAt = typeof gateway.startedAt === "string" ? gateway.startedAt : null;
  next.serverPort = Number.isInteger(gateway.port) ? gateway.port : null;
  next.badges = {
    providers: count(body.providers?.connected, prev.badges.providers),
    combos: count(body.combos, prev.badges.combos),
    quota: count(body.lowQuota, prev.badges.quota),
  };
  const attention = body.providers?.attention;
  if (attention && Number.isInteger(attention.count)) {
    next.providerAttention = {
      count: attention.count,
      status: attention.status === "warn" || attention.status === "err" ? attention.status : null,
    };
  }
  if (typeof body.enableTranslator === "boolean") next.enableTranslator = body.enableTranslator;
  // Heartbeat: keep the last series unless the body carries a fresh one, so a
  // failed poll never drops the sparkline.
  const traffic = body.traffic ?? null;
  if (
    traffic !== null &&
    Array.isArray(traffic.series) &&
    Number.isInteger(traffic.total) &&
    traffic.total >= 0
  ) {
    next.traffic = {
      series: traffic.series.map((value) =>
        Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0,
      ),
      total: traffic.total,
    };
  }
  const pendingMilestone = body.savings?.pendingMilestone ?? null;
  if (pendingMilestone === null) {
    next.savingsMilestone = null;
  } else if (Number.isInteger(pendingMilestone) && pendingMilestone > 0) {
    next.savingsMilestone = pendingMilestone;
  }
  return next;
}

// Module-level shared store: one poller for all hook instances (desktop
// sidebar + mobile drawer), so fetches are deduped across mounts.
const store = {
  state: INITIAL_STATE,
  listeners: new Set(),
  timer: null,
  inFlight: null,
  queued: false,
  lastRefreshAt: 0,
};

async function fetchSummary() {
  let status = null;
  let body = null;
  // Stamped at attempt time: an in-flight request already carries fresh data,
  // so tab-focus bursts during it add nothing (mutations still queue one).
  store.lastRefreshAt = Date.now();
  try {
    const res = await fetch("/api/shell/summary", { cache: "no-store" });
    status = res.status;
    if (res.ok) body = await res.json().catch(() => null);
  } catch {
    /* network failure: status stays null (offline) */
  }
  store.state = applyShellSummary(store.state, status, body);
  for (const listener of store.listeners) listener(store.state);
}

/**
 * Refresh the shell badges and gateway status now. Call after any mutation
 * that changes provider, combo, quota or translator state. A call during an
 * in-flight request queues exactly one follow-up so the result is never stale.
 * @returns {Promise<void>}
 */
export function refreshShellStatus() {
  if (typeof window === "undefined") return Promise.resolve();
  if (store.inFlight) {
    store.queued = true;
    return store.inFlight;
  }
  store.inFlight = fetchSummary().finally(() => {
    store.inFlight = null;
    if (store.queued) {
      store.queued = false;
      refreshShellStatus();
    }
  });
  return store.inFlight;
}

function onVisibilityChange() {
  if (
    !document.hidden &&
    !store.inFlight &&
    Date.now() - store.lastRefreshAt >= FOCUS_THROTTLE_MS
  ) {
    refreshShellStatus();
  }
}

function start() {
  refreshShellStatus();
  store.timer = window.setInterval(() => {
    if (!document.hidden) refreshShellStatus();
  }, REFRESH_MS);
  document.addEventListener("visibilitychange", onVisibilityChange);
}

function stop() {
  window.clearInterval(store.timer);
  store.timer = null;
  document.removeEventListener("visibilitychange", onVisibilityChange);
}

/**
 * Shared shell status from one authenticated GET /api/shell/summary: gateway
 * reachability, uptime start and listen port, nav badge counts (connected
 * providers and their attention status, LLM combos, accounts at ≤ 20% quota
 * from server snapshots), the translator gate, the 15-minute heartbeat series
 * and the pending savings milestone. Polls every 60s while visible; tab focus
 * refreshes at most once per FOCUS_THROTTLE_MS; mutations call
 * refreshShellStatus() for an immediate update.
 *
 * @returns {{
 *   loading: boolean,
 *   gatewayOnline: boolean|null,
 *   startedAt: string|null,
 *   port: number|null,
 *   badges: { providers: number|null, combos: number|null, quota: number|null },
 *   providerAttention: { count: number, status: "warn"|"err"|null },
 *   enableTranslator: boolean,
 *   traffic: { series: number[], total: number }|null,
 *   savingsMilestone: number|null,
 * }}
 */
export default function useShellStatus() {
  const [state, setLocalState] = useState(store.state);

  useEffect(() => {
    const listener = (next) => setLocalState(next);
    store.listeners.add(listener);
    if (store.listeners.size === 1) start();
    return () => {
      store.listeners.delete(listener);
      if (store.listeners.size === 0) stop();
    };
  }, []);

  const { serverPort, ...rest } = state;
  const port =
    serverPort ??
    (typeof window !== "undefined" && window.location?.port ? Number(window.location.port) : null);

  return { ...rest, port };
}
