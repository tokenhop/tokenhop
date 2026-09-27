"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { getModelsByProviderId, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";

const CLOUD_URL = process.env.NEXT_PUBLIC_CLOUD_URL || "";

/**
 * Shared data loader for CLI-tool setup cards: connections, models,
 * API keys, tunnel/tailscale status, and model aliases. Fetched once and
 * reused across whichever tool is currently open in the setup panel.
 */
export function useToolSetupData() {
  const [connections, setConnections] = useState([]);
  const [apiKeys, setApiKeys] = useState([]);
  const [cloudEnabled, setCloudEnabled] = useState(false);
  const [ccFilterNaming, setCcFilterNaming] = useState(false);
  const [tunnelEnabled, setTunnelEnabled] = useState(false);
  const [tunnelPublicUrl, setTunnelPublicUrl] = useState("");
  const [tailscaleEnabled, setTailscaleEnabled] = useState(false);
  const [tailscaleUrl, setTailscaleUrl] = useState("");
  const [modelAliases, setModelAliases] = useState({});
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [provRes, settingsRes, tunnelRes, keysRes, aliasRes] = await Promise.all([
        fetch("/api/providers"),
        fetch("/api/settings"),
        fetch("/api/tunnel/status"),
        fetch("/api/keys"),
        fetch("/api/models/alias"),
      ]);
      if (provRes.ok) {
        const d = await provRes.json();
        setConnections(d.connections || []);
      }
      if (settingsRes.ok) {
        const d = await settingsRes.json();
        setCloudEnabled(Boolean(d.cloudEnabled));
        setCcFilterNaming(Boolean(d.ccFilterNaming));
      }
      if (tunnelRes.ok) {
        const d = await tunnelRes.json();
        setTunnelEnabled(Boolean(d.tunnel?.enabled || d.tunnel?.settingsEnabled));
        setTunnelPublicUrl(d.tunnel?.publicUrl || "");
        setTailscaleEnabled(Boolean(d.tailscale?.enabled || d.tailscale?.settingsEnabled));
        setTailscaleUrl(d.tailscale?.tunnelUrl || "");
      }
      if (keysRes.ok) {
        const d = await keysRes.json();
        setApiKeys(d.keys || []);
      }
      if (aliasRes.ok) {
        const d = await aliasRes.json();
        setModelAliases(d.aliases || {});
      }
    } catch (err) {
      console.error("Error loading CLI tools data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const activeProviders = useMemo(
    () => connections.filter((c) => c.isActive !== false),
    [connections],
  );

  const availableModels = useMemo(() => {
    const models = [];
    const seen = new Set();

    activeProviders.forEach((conn) => {
      const alias = PROVIDER_ID_TO_ALIAS[conn.provider] || conn.provider;
      const providerModels = getModelsByProviderId(conn.provider);
      providerModels.forEach((m) => {
        const value = `${alias}/${m.id}`;
        if (!seen.has(value)) {
          seen.add(value);
          models.push({
            value,
            label: value,
            provider: conn.provider,
            alias,
            connectionName: conn.name,
            modelId: m.id,
          });
        }
      });

      // Compatible nodes have no static catalog; use connection's custom models
      if (providerModels.length === 0) {
        const prefix = conn.providerSpecificData?.prefix || alias;
        const fallbacks = [];
        if (conn.defaultModel) fallbacks.push({ id: conn.defaultModel, name: conn.defaultModel });
        (conn.providerSpecificData?.customModels || []).forEach((m) => {
          if (m?.id && !fallbacks.some((f) => f.id === m.id)) {
            fallbacks.push({ id: m.id, name: m.name || m.id });
          }
        });
        if (fallbacks.length === 0 && conn.testStatus === "active") {
          fallbacks.push({ id: "model-id", name: `${prefix}/model-id` });
        }
        fallbacks.forEach((m) => {
          const value = `${prefix}/${m.id}`;
          if (!seen.has(value)) {
            seen.add(value);
            models.push({
              value,
              label: value,
              provider: conn.provider,
              alias: prefix,
              connectionName: conn.name,
              modelId: m.id,
            });
          }
        });
      }
    });

    return models;
  }, [activeProviders]);

  const hasActiveProviders = availableModels.length > 0;

  const defaultBaseUrl = useMemo(() => {
    if (tunnelEnabled && tunnelPublicUrl) return tunnelPublicUrl;
    if (cloudEnabled && CLOUD_URL) return CLOUD_URL;
    if (typeof window !== "undefined") return window.location.origin;
    return "http://localhost:20128";
  }, [tunnelEnabled, tunnelPublicUrl, cloudEnabled]);

  return {
    loading,
    connections,
    activeProviders,
    availableModels,
    hasActiveProviders,
    apiKeys,
    cloudEnabled,
    ccFilterNaming,
    cloudUrl: CLOUD_URL,
    tunnelEnabled,
    tunnelPublicUrl,
    tailscaleEnabled,
    tailscaleUrl,
    modelAliases,
    defaultBaseUrl,
    refresh: fetchData,
  };
}
