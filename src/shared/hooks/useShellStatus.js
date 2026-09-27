"use client";

import { useEffect, useState } from "react";
import { summarizeProviders } from "@/shared/utils/providerHealth";

const REFRESH_MS = 60_000;
const LOW_QUOTA_THRESHOLD = 20;

/**
 * Count distinct connected providers (not raw connections), using the shared
 * provider-health rule: a provider is connected when it has at least one
 * enabled connection, even if that connection needs attention.
 * @param {Array<object>} connections
 */
export function countConnectedProviders(connections) {
  if (!Array.isArray(connections)) return 0;
  return summarizeProviders([], connections).connected;
}

/**
 * Providers that need attention under the shared health rule, plus the worst
 * status among them, for the Providers badge tint and label.
 * @param {Array<object>} connections
 * @returns {{ count: number, status: "warn"|"err"|null }}
 */
export function providerAttention(connections) {
  if (!Array.isArray(connections)) return { count: 0, status: null };
  const flagged = summarizeProviders([], connections).providers.filter((p) => p.needsAttention);
  const status = flagged.some((p) => p.status === "err")
    ? "err"
    : flagged.length > 0
      ? "warn"
      : null;
  return { count: flagged.length, status };
}

/**
 * Count accounts whose lowest visible quota is at or below `threshold` percent.
 * Reads the same localStorage cache the quota page writes (`quotaCacheData`),
 * so the badge matches what the quota page shows without extra polling.
 * @param {Record<string, { quotas?: Array<object> }>} quotaData
 * @param {number} [threshold=20]
 */
export function countLowQuotaAccounts(quotaData, threshold = LOW_QUOTA_THRESHOLD) {
  if (!quotaData || typeof quotaData !== "object") return 0;
  let count = 0;
  for (const entry of Object.values(quotaData)) {
    const quotas = Array.isArray(entry?.quotas) ? entry.quotas : [];
    if (quotas.length === 0) continue;
    const remaining = quotas.map((quota) => {
      if (typeof quota?.remaining === "number") return quota.remaining;
      if (typeof quota?.remainingPercentage === "number") return quota.remainingPercentage;
      if (quota?.total > 0) {
        return Math.round(((quota.total - (quota.used || 0)) / quota.total) * 100);
      }
      return Number.POSITIVE_INFINITY;
    });
    if (Math.min(...remaining) <= threshold) count += 1;
  }
  return count;
}

/**
 * Gateway reachability from the status fetch. A network failure (no response)
 * or a 5xx means offline; any other response proves the gateway answered.
 * Only a 2xx carries uptime/port data.
 * @param {Response|null} res
 */
function readGatewayStatus(res) {
  if (!res || res.status >= 500) {
    return { gatewayOnline: false, startedAt: null, serverPort: null };
  }
  return {
    gatewayOnline: true,
    startedAt: null,
    serverPort: null,
    statusBody: res.ok ? res.json().catch(() => null) : null,
  };
}

/**
 * Two-way translator gate: a successful settings fetch sets the flag from the
 * payload (on or off); a failed fetch keeps the previous value.
 * @param {PromiseSettledResult<Response>|undefined} settingsRes
 * @param {boolean} prev
 * @returns {Promise<boolean>}
 */
export async function readTranslatorGate(settingsRes, prev) {
  if (settingsRes?.status === "fulfilled" && settingsRes.value?.ok) {
    const data = await settingsRes.value.json().catch(() => null);
    return Boolean(data?.enableTranslator);
  }
  return prev;
}

function readQuotaCache() {
  if (typeof window === "undefined") return {};
  try {
    const cached = window.localStorage.getItem("quotaCacheData");
    return cached ? JSON.parse(cached) : {};
  } catch {
    return {};
  }
}

// Module-level shared store: one poller for all hook instances (desktop
// sidebar + mobile drawer), so fetches are deduped across mounts.
const store = {
  state: {
    loading: true,
    gatewayOnline: null,
    startedAt: null,
    serverPort: null,
    badges: { providers: null, combos: null, quota: null },
    providerAttention: { count: 0, status: null },
    enableTranslator: false,
  },
  listeners: new Set(),
  timer: null,
  inFlight: false,
};

function notify() {
  for (const listener of store.listeners) listener(store.state);
}

function setState(partial) {
  store.state = { ...store.state, ...partial };
  notify();
}

async function refreshShellStatus() {
  if (typeof window === "undefined" || store.inFlight) return;
  store.inFlight = true;
  try {
    const [statusRes, settingsRes, providersRes, combosRes] = await Promise.allSettled([
      fetch("/api/gateway/status", { cache: "no-store" }),
      fetch("/api/settings", { cache: "no-store" }),
      fetch("/api/providers", { cache: "no-store" }),
      fetch("/api/combos", { cache: "no-store" }),
    ]);

    const next = {
      ...readGatewayStatus(statusRes.status === "fulfilled" ? statusRes.value : null),
      badges: { ...store.state.badges },
      providerAttention: store.state.providerAttention,
    };
    if (next.statusBody) {
      const body = await next.statusBody;
      next.startedAt = typeof body?.startedAt === "string" ? body.startedAt : null;
      next.serverPort = Number.isInteger(body?.port) ? body.port : null;
    }
    delete next.statusBody;

    next.enableTranslator = await readTranslatorGate(settingsRes, store.state.enableTranslator);

    // Quota badge: only active connections count toward the low-quota total.
    let activeProviderIds = null;
    if (providersRes.status === "fulfilled" && providersRes.value.ok) {
      const data = await providersRes.value.json();
      if (Array.isArray(data?.connections)) {
        next.badges.providers = countConnectedProviders(data.connections);
        next.providerAttention = providerAttention(data.connections);
        activeProviderIds = new Set(
          data.connections.filter((c) => c?.isActive !== false).map((c) => c.id),
        );
      }
    }

    if (combosRes.status === "fulfilled" && combosRes.value.ok) {
      const data = await combosRes.value.json();
      if (Array.isArray(data?.combos)) {
        next.badges.combos = data.combos.filter((c) => !c.kind || c.kind === "llm").length;
      }
    }

    // The quota cache is only trustworthy once we know which connections are
    // active; until then the badge stays hidden (null) instead of guessing.
    if (activeProviderIds) {
      const cached = readQuotaCache();
      next.badges.quota = countLowQuotaAccounts(
        Object.fromEntries(Object.entries(cached).filter(([id]) => activeProviderIds.has(id))),
      );
    }
    setState({ ...next, loading: false });
  } finally {
    store.inFlight = false;
  }
}

function startPolling() {
  if (store.timer || typeof window === "undefined") return;
  store.timer = window.setInterval(() => {
    if (!document.hidden) refreshShellStatus();
  }, REFRESH_MS);
}

function stopPolling() {
  if (store.timer) {
    window.clearInterval(store.timer);
    store.timer = null;
  }
}

function onVisibilityChange() {
  if (!document.hidden) refreshShellStatus();
}

/**
 * Shared shell status: gateway reachability, uptime start and listen port
 * (authenticated GET /api/gateway/status), the translator
 * gate (GET /api/settings), and nav badge counts. Polls every 60s (the quota
 * page cadence), pauses while the tab is hidden, and dedupes concurrent
 * refreshes via a module-level store.
 *
 * Badge counts:
 * - providers: distinct providers with at least one enabled connection
 *   (shared provider-health rule)
 * - combos: LLM combos from GET /api/combos
 * - quota: active connections whose lowest quota is ≤ 20% remaining,
 *   computed from the quota page's localStorage cache (no new polling)
 *
 * @returns {{
 *   loading: boolean,
 *   gatewayOnline: boolean|null,
 *   startedAt: string|null,
 *   port: number|null,
 *   badges: { providers: number|null, combos: number|null, quota: number|null },
 *   providerAttention: { count: number, status: "warn"|"err"|null },
 *   enableTranslator: boolean,
 * }}
 */
export default function useShellStatus() {
  const [state, setLocalState] = useState(store.state);

  useEffect(() => {
    const listener = (next) => setLocalState(next);
    store.listeners.add(listener);
    if (store.listeners.size === 1) {
      refreshShellStatus();
      startPolling();
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    return () => {
      store.listeners.delete(listener);
      if (store.listeners.size === 0) {
        stopPolling();
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, []);

  const { serverPort, ...rest } = state;
  const port =
    serverPort ??
    (typeof window !== "undefined" && window.location?.port ? Number(window.location.port) : null);

  return { ...rest, port };
}
