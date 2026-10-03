"use client";

import { useState, useEffect, useCallback } from "react";

const NO_LIVE_MODELS = "No live models returned.";
const EMPTY_CATALOG = { key: null, models: [], error: null };

async function fetchLiveCatalog(connectionId, { refresh = false } = {}) {
  // hidden=1: also list routable entries the upstream hides from its own picker (marked).
  const query = refresh ? "?hidden=1&refresh=1" : "?hidden=1";
  const res = await fetch(`/api/providers/${connectionId}/models${query}`, { cache: "no-store" });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Failed to fetch models (HTTP ${res.status})`);
  return {
    models: Array.isArray(data?.models) ? data.models : [],
    warning: data?.warning || null,
  };
}

function toCatalog(key, { models, warning }) {
  return { key, models, error: warning || (models.length > 0 ? null : NO_LIVE_MODELS) };
}

/**
 * Live per-connection model catalog for providers flagged `features.liveModels`.
 * Resolves from the first active connection whenever the provider or that connection
 * changes — no polling. Keyless (`noAuth`) providers key on the provider id; the
 * route falls back to the synthetic noauth connection. The server caches the
 * catalog; `refresh()` bypasses it.
 */
export function useLiveCatalog({ providerId, connections, enabled, noAuth }) {
  const connectionId = enabled
    ? noAuth
      ? providerId
      : (connections || []).find((connection) => connection.isActive !== false)?.id || null
    : null;
  const key = connectionId ? `${providerId}:${connectionId}` : null;
  // Results are tagged with the key they were fetched for, so a switch of provider or
  // connection hides the previous catalog immediately and late responses never leak in.
  const [catalog, setCatalog] = useState(EMPTY_CATALOG);

  useEffect(() => {
    if (!connectionId) return undefined;
    let cancelled = false;
    fetchLiveCatalog(connectionId)
      .then((result) => {
        if (!cancelled) setCatalog(toCatalog(key, result));
      })
      .catch((error) => {
        if (cancelled) return;
        setCatalog({
          key,
          models: [],
          error: error?.message || "Failed to reach the live model catalog.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [key, connectionId]);

  // Bypass the server cache and return the fresh catalog; throws on network/non-OK
  // so the caller can report the failure.
  const refresh = useCallback(async () => {
    if (!connectionId) throw new Error("No active connection");
    const result = await fetchLiveCatalog(connectionId, { refresh: true });
    setCatalog(toCatalog(key, result));
    return result;
  }, [key, connectionId]);

  const current = key && catalog.key === key ? catalog : EMPTY_CATALOG;
  return { liveModels: current.models, liveError: current.error, refresh };
}
