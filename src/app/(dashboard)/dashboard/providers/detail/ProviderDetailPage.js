"use client";
import { withWorkspace } from "../connectTarget";

import { useCallback, useEffect, useState } from "react";
import { refreshShellStatus } from "@/shared/hooks/useShellStatus";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Callout, CardSkeleton, NoAuthProxyCard } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import { mergeLiveWithStatic } from "@/shared/utils/liveModels";
import { probeNotifyMethod } from "@/shared/utils/providerHealth";
import { useSettingsScope } from "@/shared/hooks/useSettingsScope";
import { loadOwnedMap, loadSettingsValue, patchSettings } from "@/shared/utils/settingsApi";
import { useLiveCatalog } from "../[id]/useLiveCatalog";
import { useConnections } from "./useConnections";
import { useProviderStrategy } from "./useProviderStrategy";
import { useModels } from "./useModels";
import {
  connectionLabels,
  providerAliases,
  providerAuthFlags,
  providerCatalog,
  resolveProviderInfo,
} from "./providerDetailMeta";
import ProviderDetailHeader, { ProviderDetailNotices } from "./ProviderDetailHeader";
import CompatibleDetailsCard from "./CompatibleDetailsCard";
import MoveToWorkspaceButton from "@/shared/components/MoveToWorkspaceButton";
import ConnectionsSection from "./ConnectionsSection";
import ModelsSection from "./ModelsSection";
import CompatibleModelsSection from "./CompatibleModelsSection";
import AuthFlows, { AddConnectionButtons } from "./AuthFlows";

const AG_RISK_STORAGE_KEY = "ag_risk_confirmed";
const AUTO_PING_SETTINGS_KEYS = { claude: "claudeAutoPing", codex: "codexAutoPing" };

/**
 * Signal provider detail page: header, notices, compatible details,
 * connections and models sections with every auth flow reachable.
 */
export default function ProviderDetailPage() {
  const params = useParams();
  const router = useRouter();
  const providerId = params.id;
  const notifyError = useCallback((message) => useNotificationStore.getState().error(message), []);
  const notifySuccess = useCallback(
    (message) => useNotificationStore.getState().success(message),
    [],
  );

  const notifyResult = useCallback((variant, message) => {
    const store = useNotificationStore.getState();
    store[probeNotifyMethod(variant)](message);
  }, []);

  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState("");
  const [providerNode, setProviderNode] = useState(null);
  const [show, setShow] = useState({
    oauth: false,
    xiaomiMimo: false,
    iflowCookie: false,
    addApiKey: false,
    edit: false,
    editNode: false,
    bulkCodex: false,
    bulkGrokCli: false,
    agRisk: false,
  });
  const open = useCallback((key) => setShow((prev) => ({ ...prev, [key]: true })), []);
  const close = useCallback((key) => setShow((prev) => ({ ...prev, [key]: false })), []);
  const [addConnectionError, setAddConnectionError] = useState("");
  const [selectedConnection, setSelectedConnection] = useState(null);
  const [autoPing, setAutoPing] = useState({ enabled: false, connections: {} });
  const { ready: settingsReady, scope: settingsScope } = useSettingsScope();

  const conn = useConnections({ providerId, notifyError, notifyResult });
  const strategy = useProviderStrategy({ providerId, notifyError });
  const providerInfo = resolveProviderInfo(providerId, providerNode);
  const authFlags = providerAuthFlags(providerId, providerInfo);
  const isCompatible = authFlags.isOpenAICompatible || authFlags.isAnthropicCompatible;
  const { storageAlias, displayAlias } = providerAliases(providerId, providerNode, isCompatible);
  const { staticModels, isLiveCatalog } = providerCatalog(providerId);
  const {
    liveModels,
    liveError,
    refresh: refreshLive,
  } = useLiveCatalog({
    providerId,
    connections: conn.connections,
    enabled: isLiveCatalog && !isCompatible,
    noAuth: authFlags.isFreeNoAuth,
  });
  const liveFallback = isLiveCatalog && !isCompatible && liveModels.length === 0 && !!liveError;
  const catalogModels =
    isLiveCatalog && liveModels.length > 0 && !isCompatible
      ? mergeLiveWithStatic(providerId, liveModels, staticModels)
      : staticModels;
  const models = useModels({
    providerId,
    storageAlias,
    staticModels,
    catalogModels,
    notifyError,
  });
  const labels = connectionLabels(providerId);
  const hasDualAuthModes = !isCompatible && authFlags.isOAuth && authFlags.supportsApiKey;

  const { fetchConnections } = conn;
  const { load: loadStrategy } = strategy;
  const { load: loadModels, loadThinking } = models;

  const fetchDetail = useCallback(async () => {
    setFetchError("");
    try {
      await fetchConnections();
      await Promise.all([loadStrategy(), loadModels(), loadThinking()]);
      const nodesRes = await fetch("/api/provider-nodes", { cache: "no-store" });
      if (nodesRes.ok) {
        const nodesData = await nodesRes.json().catch(() => ({}));
        let node = (nodesData.nodes || []).find((entry) => entry.id === providerId) || null;
        if (!node && isCompatible) {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 150));
            const retryRes = await fetch("/api/provider-nodes", { cache: "no-store" });
            if (!retryRes.ok) continue;
            const retryData = await retryRes.json().catch(() => ({}));
            node = (retryData.nodes || []).find((entry) => entry.id === providerId) || null;
            if (node) break;
          }
        }
        setProviderNode(node);
      }
      const autoPingKey = AUTO_PING_SETTINGS_KEYS[providerId];
      const autoPingCfg = autoPingKey
        ? (await loadSettingsValue(autoPingKey, settingsScope).catch(() => ({}))) || {}
        : {};
      setAutoPing({
        enabled: autoPingCfg.enabled === true,
        connections: autoPingCfg.connections || {},
      });
    } catch (error) {
      console.log("Error fetching provider detail:", error);
      setFetchError("Could not load this provider. Check the gateway and try again.");
    } finally {
      setLoading(false);
    }
  }, [
    fetchConnections,
    isCompatible,
    loadModels,
    loadStrategy,
    loadThinking,
    providerId,
    settingsScope,
  ]);

  useEffect(() => {
    if (settingsReady) fetchDetail();
  }, [fetchDetail, settingsReady]);

  const toggleAutoPing = (connectionId, on) => {
    const key = AUTO_PING_SETTINGS_KEYS[providerId];
    if (!key) return;
    const next = { ...autoPing, connections: { ...autoPing.connections, [connectionId]: on } };
    setAutoPing(next);
    // YAN-770: scoped saves re-read the workspace's own entries and add this
    // toggle, so inherited connections and `enabled` stay inherited.
    const save = settingsScope
      ? loadOwnedMap(key, settingsScope).then((owned) =>
          patchSettings(
            {
              [key]: {
                ...owned,
                connections: { ...(owned.connections || {}), [connectionId]: on },
              },
            },
            settingsScope,
          ),
        )
      : patchSettings({ [key]: next }, settingsScope);
    save.catch((error) => console.log("Error saving auto-ping config:", error));
  };

  const openOAuthConnection = () => open("oauth");

  const triggerOAuthConnection = () => {
    if (providerId === "antigravity" && typeof window !== "undefined") {
      const confirmed = window.localStorage.getItem(AG_RISK_STORAGE_KEY) === "true";
      if (!confirmed) {
        open("agRisk");
        return;
      }
    }
    if (providerId === "xiaomi-mimo") {
      open("xiaomiMimo");
      return;
    }
    if (authFlags.isOAuth) {
      openOAuthConnection();
      return;
    }
    setAddConnectionError("");
    open("addApiKey");
  };

  const triggerApiKeyConnection = () => {
    setAddConnectionError("");
    open("addApiKey");
  };

  const triggerAddConnection = () => {
    if (authFlags.isOAuth) {
      triggerOAuthConnection();
      return;
    }
    triggerApiKeyConnection();
  };

  const handleAgRiskConfirm = () => {
    if (typeof window !== "undefined") window.localStorage.setItem(AG_RISK_STORAGE_KEY, "true");
    close("agRisk");
    if (authFlags.isOAuth) openOAuthConnection();
    else triggerApiKeyConnection();
  };

  const refreshConnections = async () => {
    await conn.fetchConnections();
    refreshShellStatus();
  };

  const handleSaveApiKey = async (formData, workspaceId = settingsScope?.workspaceId ?? null) => {
    setAddConnectionError("");
    try {
      const res = await fetch(withWorkspace("/api/providers", workspaceId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, ...formData }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        await refreshConnections();
        close("addApiKey");
        return;
      }
      setAddConnectionError(data?.error || "Failed to save connection");
    } catch (error) {
      console.log("Error saving connection:", error);
      setAddConnectionError("Failed to save connection");
    }
  };

  const handleUpdateConnection = async (formData) => {
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
      close("edit");
      return null;
    } catch (error) {
      console.log("Error updating connection:", error);
      return "Failed to save connection";
    }
  };

  const handleUpdateNode = async (formData) => {
    try {
      const res = await fetch(`/api/provider-nodes/${providerId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setProviderNode(data.node);
        await refreshConnections();
        close("editNode");
      } else {
        notifyError(data.error || "Failed to update provider.");
      }
    } catch (error) {
      console.log("Error updating provider node:", error);
    }
  };

  const confirmDeleteNode = () => {
    conn.setConfirmState({
      title: "Delete compatible node",
      message: `Delete this ${authFlags.isAnthropicCompatible ? "Anthropic" : "OpenAI"} Compatible node?`,
      onConfirm: async () => {
        conn.setConfirmState(null);
        try {
          const res = await fetch(`/api/provider-nodes/${providerId}`, { method: "DELETE" });
          if (res.ok) router.push("/dashboard/providers");
          else notifyError("Failed to delete provider.");
        } catch (error) {
          console.log("Error deleting provider node:", error);
        }
      },
    });
  };

  const connectionActions = {
    onOAuth: triggerOAuthConnection,
    onApiKey: triggerApiKeyConnection,
    onAdd: triggerAddConnection,
    onCookie: () => open("iflowCookie"),
    onBulkCodex: () => open("bulkCodex"),
    onBulkGrokCli: () => open("bulkGrokCli"),
  };
  const addButtons = (
    <AddConnectionButtons
      providerId={providerId}
      isCompatible={isCompatible}
      hasDualAuthModes={hasDualAuthModes}
      labels={labels}
      {...connectionActions}
    />
  );

  const flowHandlers = {
    oauthSuccess: () => {
      refreshConnections();
      close("oauth");
    },
    closeOAuth: () => close("oauth"),
    closeXiaomiMimo: () => close("xiaomiMimo"),
    iflowCookieSuccess: () => {
      refreshConnections();
      close("iflowCookie");
    },
    closeIflowCookie: () => close("iflowCookie"),
    saveApiKey: handleSaveApiKey,
    refreshConnections,
    closeAddApiKey: () => {
      setAddConnectionError("");
      close("addApiKey");
    },
    updateConnection: handleUpdateConnection,
    closeEdit: () => close("edit"),
    compatibleNode: providerNode,
    updateNode: handleUpdateNode,
    closeEditNode: () => close("editNode"),
    saveCustomModel: async (modelId, caps) => {
      const saved = await models.addCustomModel(modelId, "llm", storageAlias, caps);
      if (saved) models.setShowAddCustomModel(false);
      return saved;
    },
    closeAddCustomModel: () => models.setShowAddCustomModel(false),
    closeBulkCodex: () => close("bulkCodex"),
    closeBulkGrokCli: () => close("bulkGrokCli"),
    closeAgRisk: () => close("agRisk"),
    confirmAgRisk: handleAgRiskConfirm,
  };

  const modelSnippet = `${displayAlias}/${models.enabledModels[0]?.id || models.customModelRows[0]?.id || staticModels[0]?.id || "model-id"}`;
  const authVariant = authFlags.isOAuth
    ? "info"
    : authFlags.isFreeNoAuth
      ? "live"
      : authFlags.supportsApiKey
        ? "brand"
        : "neutral";
  const authLabel = authFlags.isOAuth
    ? "OAuth"
    : authFlags.isFreeNoAuth
      ? "Free"
      : authFlags.supportsApiKey
        ? "API key"
        : isCompatible
          ? "Compatible"
          : "Provider";

  if (loading) {
    return (
      <div className="flex min-w-0 flex-col gap-5 px-1 sm:px-0" aria-busy="true">
        <span className="sr-only" role="status">
          Loading provider
        </span>
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  if (!providerInfo) {
    return (
      <div className="flex min-w-0 flex-col items-center gap-3 px-1 py-20 text-center sm:px-0">
        <p className="text-muted">Provider not found</p>
        <Link
          href="/dashboard/providers"
          className="inline-flex min-h-11 items-center text-sm font-semibold text-coral-ink hover:text-coral focus-visible:shadow-focus focus-visible:outline-none"
        >
          Back to providers
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-5 px-1 sm:px-0">
      <ProviderDetailHeader
        providerId={providerId}
        providerInfo={providerInfo}
        connections={conn.connections}
        authLabel={authLabel}
        authVariant={authVariant}
        modelSnippet={modelSnippet}
        loading={false}
      />
      <ProviderDetailNotices providerInfo={providerInfo} />
      {fetchError ? (
        <Callout variant="err" title="Could not load provider">
          <span className="flex flex-wrap items-center gap-2">
            {fetchError}
            <Button size="sm" variant="secondary" onClick={fetchDetail}>
              Retry
            </Button>
          </span>
        </Callout>
      ) : null}

      {isCompatible && providerNode ? (
        <CompatibleDetailsCard
          isAnthropic={authFlags.isAnthropicCompatible}
          apiType={providerNode.apiType}
          fimTemplate={providerNode.fimTemplate}
          baseUrl={providerNode.baseUrl}
          onAddKey={triggerApiKeyConnection}
          onEdit={() => open("editNode")}
          onDelete={confirmDeleteNode}
          moveAction={
            <MoveToWorkspaceButton
              variant="button"
              label="Move"
              items={[
                {
                  type: "node",
                  id: providerNode.id,
                  label: providerNode.name || providerNode.id || providerId,
                },
              ]}
              sourceWorkspaceId={providerNode.workspaceId ?? null}
              onMoved={fetchDetail}
            />
          }
        />
      ) : null}

      {authFlags.isFreeNoAuth ? (
        <NoAuthProxyCard providerId={providerId} />
      ) : (
        <ConnectionsSection
          providerId={providerId}
          auth={{ isOAuth: authFlags.isOAuth, hasDualAuthModes, labels }}
          strategy={strategy}
          conn={conn}
          autoPing={{
            enabled: autoPing.enabled,
            connections: autoPing.connections,
            toggle: toggleAutoPing,
          }}
          actions={{
            addButtons,
            edit: (entry) => {
              setSelectedConnection(entry);
              open("edit");
            },
            notifyError,
          }}
        />
      )}

      <ModelsSection
        providerId={providerId}
        storageAlias={storageAlias}
        displayAlias={displayAlias}
        isLiveCatalog={isLiveCatalog}
        isCompatible={isCompatible}
        isAnthropic={authFlags.isAnthropicCompatible}
        isFreeNoAuth={authFlags.isFreeNoAuth}
        connections={conn.connections}
        catalogModels={catalogModels}
        staticModels={staticModels}
        liveError={liveError}
        liveFallback={liveFallback}
        refreshLive={refreshLive}
        models={models}
        onDisableAll={(state) => conn.setConfirmState(state)}
        compatibleSection={
          <CompatibleModelsSection
            isFreeNoAuth={authFlags.isFreeNoAuth}
            storageAlias={storageAlias}
            displayAlias={displayAlias}
            isAnthropic={authFlags.isAnthropicCompatible}
            connections={conn.connections}
            models={models}
            actions={{ notifyError, notifySuccess }}
          />
        }
      />

      <AuthFlows
        providerId={providerId}
        providerInfo={providerInfo}
        isCompatible={isCompatible}
        isAnthropic={authFlags.isAnthropicCompatible}
        storageAlias={storageAlias}
        displayAlias={displayAlias}
        proxyPools={conn.proxyPools}
        connectionNames={conn.connections.map((entry) => entry.name).filter(Boolean)}
        addConnectionError={addConnectionError}
        selectedConnection={selectedConnection}
        show={show}
        handlers={flowHandlers}
        models={models}
        workspaceId={settingsScope?.workspaceId ?? null}
      />
    </div>
  );
}
