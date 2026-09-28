"use client";

import { useState, useEffect, useCallback } from "react";

export default function useProviderListData() {
  const [connections, setConnections] = useState([]);
  const [providerNodes, setProviderNodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState("");

  const refreshData = useCallback(async () => {
    try {
      const [connectionsRes, nodesRes] = await Promise.all([
        fetch("/api/providers"),
        fetch("/api/provider-nodes"),
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
  }, []);

  useEffect(() => {
    refreshData();
  }, [refreshData]);

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
