"use client";

import { useState, useEffect, useCallback } from "react";

/** `?workspaceId=` for multi-user scoped fetches; empty keeps today's URL. */
function scopedUrl(path, workspaceId) {
  return workspaceId ? `${path}?workspaceId=${encodeURIComponent(workspaceId)}` : path;
}

/**
 * Providers + nodes list data. With multi-user active, `scope.workspaceId`
 * makes both fetches name the active workspace explicitly instead of relying
 * on the session default; `scope` null (switch off / single user) keeps the
 * unchanged URLs. Fetching waits until `scope.ready` so an unresolved auth
 * status never triggers an unscoped read.
 *
 * @param {{ready?: boolean, workspaceId?: string|null}} [scope]
 */
export default function useProviderListData(scope = { ready: true, workspaceId: null }) {
  const { ready = true, workspaceId = null } = scope;
  const [connections, setConnections] = useState([]);
  const [providerNodes, setProviderNodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState("");

  const refreshData = useCallback(async () => {
    try {
      const [connectionsRes, nodesRes] = await Promise.all([
        fetch(scopedUrl("/api/providers", workspaceId)),
        fetch(scopedUrl("/api/provider-nodes", workspaceId)),
      ]);
      const connectionsData = await connectionsRes.json().catch(() => ({}));
      const nodesData = await nodesRes.json().catch(() => ({}));
      if (connectionsRes.ok) {
        setConnections(connectionsData.connections || []);
        setFetchError("");
      } else {
        setFetchError(connectionsData.error || "Failed to load providers");
      }
      if (nodesRes.ok) setProviderNodes(nodesData.nodes || []);
    } catch (error) {
      setFetchError(error?.message || "Failed to load providers");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (ready) refreshData();
  }, [ready, refreshData]);

  return {
    connections,
    setConnections,
    providerNodes,
    setProviderNodes,
    loading,
    fetchError,
    refreshData,
  };
}
