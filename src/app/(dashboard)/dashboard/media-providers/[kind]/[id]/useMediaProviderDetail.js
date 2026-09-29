"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { refreshShellStatus } from "@/shared/hooks/useShellStatus";
import { useNotificationStore } from "@/store/notificationStore";
import { getModelsByProviderId } from "@/shared/constants/models";
import { getProviderAlias } from "@/shared/constants/providers";
import { useConnections } from "@/app/(dashboard)/dashboard/providers/detail/useConnections";
import { useModels } from "@/app/(dashboard)/dashboard/providers/detail/useModels";
import { useProviderStrategy } from "@/app/(dashboard)/dashboard/providers/detail/useProviderStrategy";

/**
 * Media provider detail data: custom embedding node, Signal connections,
 * strategy and kind-filtered models, plus the API-key/edit flows.
 *
 * @param {object} args
 * @param {string} args.id provider id from the route
 * @param {string} args.kind media kind from the route ("llm" is never used here)
 * @param {boolean} args.isCustom custom embedding node detail
 * @param {boolean} [args.noAuth] no-auth provider: no connections or strategy to load
 */
export function useMediaProviderDetail({ id, kind, isCustom, noAuth = false }) {
  const notifyError = useCallback((message) => useNotificationStore.getState().error(message), []);
  const [customNode, setCustomNode] = useState(null);
  const [customLoading, setCustomLoading] = useState(isCustom);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState("");
  const [addConnectionError, setAddConnectionError] = useState("");
  const [showAddApiKey, setShowAddApiKey] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState(null);

  const conn = useConnections({ providerId: id, notifyError });
  const strategy = useProviderStrategy({ providerId: id, notifyError });
  const storageAlias = isCustom ? customNode?.prefix || id : getProviderAlias(id);
  const staticModels = getModelsByProviderId(id);
  const models = useModels({
    providerId: id,
    storageAlias,
    staticModels,
    catalogModels: staticModels,
    kind,
    notifyError,
  });

  // Fetch the custom embedding node first: its prefix is the storage alias
  // models must load with. Failures surface as an error state, never 404.
  // Each call bumps the sequence ref; only the latest call may set state,
  // so stale responses (Retry races, post-unmount) are ignored.
  const nodeReqSeq = useRef(0);
  const loadNode = useCallback(async () => {
    if (!isCustom) return;
    const reqId = ++nodeReqSeq.current;
    setCustomLoading(true);
    setFetchError("");
    try {
      const res = await fetch("/api/provider-nodes", { cache: "no-store" });
      if (!res.ok) throw new Error("Could not load custom provider");
      const data = await res.json();
      if (reqId !== nodeReqSeq.current) return;
      setCustomNode((data.nodes || []).find((node) => node.id === id) || null);
    } catch (error) {
      if (reqId !== nodeReqSeq.current) return;
      setFetchError(error instanceof Error ? error.message : "Could not load custom provider");
    } finally {
      if (reqId === nodeReqSeq.current) setCustomLoading(false);
    }
  }, [id, isCustom]);

  useEffect(() => {
    loadNode();
    // Invalidate any in-flight request on unmount/id change.
    return () => {
      nodeReqSeq.current += 1;
    };
  }, [loadNode]);

  const { fetchConnections } = conn;
  const { load: loadStrategy } = strategy;
  const { load: loadModels } = models;
  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setFetchError("");
    try {
      if (noAuth) {
        await loadModels();
        return;
      }
      await fetchConnections();
      // Both loaders report their own failures (toast/inline); loadStrategy
      // resolves undefined, so only a thrown error fails the page.
      await Promise.all([loadStrategy(), loadModels()]);
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : "Could not load provider");
    } finally {
      setLoading(false);
    }
  }, [noAuth, fetchConnections, loadStrategy, loadModels]);

  // The custom prefix (storage alias) is only known after the node loads, so
  // the sections wait for it; a later prefix change reloads the models.
  const loadedPrefix = isCustom ? customNode?.prefix : undefined;
  useEffect(() => {
    if (customLoading) return;
    // Missing or failed custom node: stop loading so the page shows a 404
    // (not found) or the error state with Retry (fetch failed).
    if (isCustom && !customNode) {
      setLoading(false);
      return;
    }
    fetchDetail();
  }, [customLoading, customNode, loadedPrefix, fetchDetail, isCustom]);

  const refreshConnections = async () => {
    await fetchConnections();
    refreshShellStatus();
  };

  // AddApiKeyModal already validated the key before calling this save.
  const saveApiKey = async (formData) => {
    setAddConnectionError("");
    try {
      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: id, ...formData }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAddConnectionError(data.error || "Failed to save connection");
        return;
      }
      await refreshConnections();
      setShowAddApiKey(false);
    } catch (error) {
      setAddConnectionError(error instanceof Error ? error.message : "Failed to save connection");
    }
  };

  const updateConnection = async (formData) => {
    if (!selectedConnection) return "No connection selected";
    try {
      const res = await fetch(`/api/providers/${selectedConnection.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return data.error || "Failed to save connection";
      }
      await refreshConnections();
      setSelectedConnection(null);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "Failed to save connection";
    }
  };

  const saveCustomModel = async (modelId, caps) => {
    const saved = await models.addCustomModel(modelId, kind, storageAlias, caps);
    if (saved) models.setShowAddCustomModel(false);
    return saved;
  };

  return {
    notifyError,
    customNode,
    setCustomNode,
    customLoading,
    loading,
    fetchError,
    fetchDetail,
    loadNode,
    addConnectionError,
    setAddConnectionError,
    showAddApiKey,
    setShowAddApiKey,
    selectedConnection,
    setSelectedConnection,
    conn,
    strategy,
    models,
    storageAlias,
    staticModels,
    refreshConnections,
    saveApiKey,
    updateConnection,
    saveCustomModel,
  };
}
