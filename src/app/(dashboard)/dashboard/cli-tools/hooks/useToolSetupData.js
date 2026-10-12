"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { getModelsByProviderId, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { loadKeyContext, loadKeyList } from "../../endpoint/hooks/useApiKeys";
import { useCliScope } from "./useCliScope";
import { loadSettings, onHttpError } from "@/shared/utils/settingsApi";
import { withWorkspace } from "@/app/(dashboard)/dashboard/providers/connectTarget";

import { setKeyPresetStorageMode } from "../components/cliEndpointPresets";
import { setKeyCanCreate, useCliAccessStore } from "@/store/cliAccessStore";

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
  const [keyContext, setKeyContext] = useState(null);
  const [loading, setLoading] = useState(true);
  const { ready, scope, canManageInstance, canHostOps, identity } = useCliScope();
  const loadedIdentity = useRef(null);
  const requestVersion = useRef(0);
  const identityMatches = useCliAccessStore((s) => s.identity === identity);
  // YAN-749: ccFilterNaming is a workspace key; members never GET the
  // instance route. YAN-374: without instance.hostOps the tunnel-status and
  // provider reads would 403, so the member export view skips them and falls
  // back to the local origin. Inactive (switch off) behaves as today: every
  // call goes out exactly like before.
  const fetchData = useCallback(async () => {
    if (!ready) return;
    const version = ++requestVersion.current;
    const generation = useCliAccessStore.getState().generation;
    const current = () =>
      version === requestVersion.current && generation === useCliAccessStore.getState().generation;
    setLoading(true);
    const skipHost = ready && !canHostOps;
    setKeyPresetStorageMode(null);
    try {
      const [provRes, settings, tunnelRes, aliasRes] = await Promise.all([
        skipHost ? null : fetch("/api/providers"),
        loadSettings(scope, { canManageInstance }).catch(onHttpError(null)),
        skipHost ? null : fetch("/api/tunnel/status"),
        // Aliases need connections metadata read, which members lack.
        skipHost ? null : fetch(withWorkspace("/api/models/alias", scope?.workspaceId)),
      ]);
      if (!current()) return;
      // Keys follow the YAN-363 context envelope: hashed storage lists
      // workspace-scoped metadata (managers only, no raws); legacy keeps the
      // exact old /api/keys fetch. A key failure never blocks the rest.
      try {
        const ctx = await loadKeyContext();
        const keys = await loadKeyList(ctx);
        if (!current()) return;
        setKeyPresetStorageMode(ctx.storage);
        setKeyContext(ctx);
        setKeyCanCreate(ctx.storage === "hashed" && ctx.canCreate === true);
        setApiKeys(keys);
      } catch (err) {
        if (!current()) return;
        setKeyPresetStorageMode(null);
        setKeyContext(null);
        console.error("Error loading API keys:", err);
        setKeyCanCreate(false);
      }
      if (provRes?.ok) {
        const d = await provRes.json();
        if (!current()) return;
        setConnections(d.connections || []);
      }
      if (settings) {
        if (!current()) return; // loadSettings settled across an identity change
        setCloudEnabled(Boolean(settings.cloudEnabled));
        setCcFilterNaming(Boolean(settings.ccFilterNaming));
      }
      if (tunnelRes?.ok) {
        const d = await tunnelRes.json();
        if (!current()) return;
        setTunnelEnabled(Boolean(d.tunnel?.enabled || d.tunnel?.settingsEnabled));
        setTunnelPublicUrl(d.tunnel?.publicUrl || "");
        setTailscaleEnabled(Boolean(d.tailscale?.enabled || d.tailscale?.settingsEnabled));
        setTailscaleUrl(d.tailscale?.tunnelUrl || "");
      }
      if (aliasRes?.ok) {
        const d = await aliasRes.json();
        if (!current()) return;
        setModelAliases(d.aliases || {});
      }
    } catch (err) {
      console.error("Error loading CLI tools data:", err);
    } finally {
      if (current()) {
        loadedIdentity.current = identity;
        setLoading(false);
      }
    }
  }, [ready, scope, canManageInstance, canHostOps, identity]);

  useEffect(() => {
    if (ready) fetchData();
    return () => {
      requestVersion.current += 1;
    };
  }, [ready, fetchData]);

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

  // Members cannot read providers: the model list is empty by design, so
  // export must not wait on it (free-text model entry stays open).
  const hasActiveProviders = availableModels.length > 0 || (ready && !canHostOps);

  const defaultBaseUrl = useMemo(() => {
    if (canHostOps && tunnelEnabled && tunnelPublicUrl) return tunnelPublicUrl;
    if (canHostOps && cloudEnabled && CLOUD_URL) return CLOUD_URL;
    if (typeof window !== "undefined") return window.location.origin;
    return "http://localhost:20128";
  }, [canHostOps, tunnelEnabled, tunnelPublicUrl, cloudEnabled]);

  return {
    loading: loading || !ready || !identityMatches || loadedIdentity.current !== identity,
    identity,
    canHostOps,
    ready,
    connections: canHostOps ? connections : [],
    activeProviders: canHostOps ? activeProviders : [],
    availableModels: canHostOps ? availableModels : [],
    hasActiveProviders,
    apiKeys,
    keyContext,
    cloudEnabled: canHostOps && cloudEnabled,
    ccFilterNaming,
    cloudUrl: CLOUD_URL,
    tunnelEnabled: canHostOps && tunnelEnabled,
    tunnelPublicUrl: canHostOps ? tunnelPublicUrl : "",
    tailscaleEnabled: canHostOps && tailscaleEnabled,
    tailscaleUrl: canHostOps ? tailscaleUrl : "",
    modelAliases: canHostOps ? modelAliases : {},
    defaultBaseUrl,
    refresh: fetchData,
  };
}
