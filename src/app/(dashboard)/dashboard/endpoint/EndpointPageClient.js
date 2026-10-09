"use client";

import PropTypes from "prop-types";
import { ACTIVE } from "@/shared/brand";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Button,
  IconButton,
  Modal,
  ConfirmDialog,
  CardSkeleton,
  Skeleton,
  Callout,
} from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import useAuthStatus from "@/shared/hooks/useAuthStatus";
import { TUNNEL_BENEFITS } from "./endpointConstants";
import { deriveSecurityState } from "./endpointLogic";
import WaysInGrid from "./components/WaysInGrid";
import ApiKeysCard from "./components/ApiKeysCard";
import AccessCard from "./components/AccessCard";
import QuickConnectCard from "./components/QuickConnectCard";
import KeyCreateDialog from "./components/KeyCreateDialog";
import { useTunnelControls } from "./hooks/useTunnelControls";
import { useApiKeys } from "./hooks/useApiKeys";
import { useRemoteHost, useLocalBaseUrl } from "@/shared/hooks/useEndpointShell";

/**
 * Endpoint & keys page (Signal redesign): three ways in, API keys with
 * one-time reveal, access controls derived from real state, quick connect
 * snippets. Tunnel/tailscale lifecycles, security gates, key CRUD.
 *
 * @param {object} props
 * @param {string} props.machineId Server machine id (reserved for future use).
 */
export default function EndpointPageClient({ machineId: _machineId }) {
  const tunnel = useTunnelControls();
  const apiKeys = useApiKeys();
  const authStatus = useAuthStatus();
  const currentUserId =
    authStatus?.multiUserActive === true ? authStatus.principal?.user?.id : null;
  const isRemoteHost = useRemoteHost();
  const localUrl = useLocalBaseUrl();
  const { copied, error: copyError, copy } = useCopyToClipboard();
  const [selectedKeyId, setSelectedKeyId] = useState(null);
  const searchParams = useSearchParams();
  const router = useRouter();
  const createRequested = searchParams.get("create") === "key";
  const createBlocked = !apiKeys.capabilities.canCreate;
  const lastRevealedId = useRef(apiKeys.revealed?.id);
  const setShowAddModalRef = useRef(apiKeys.setShowAddModal);
  setShowAddModalRef.current = apiKeys.setShowAddModal;

  const clearCreateParam = useCallback(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("create") !== "key") return;
    url.searchParams.delete("create");
    router.replace(`${url.pathname}${url.search}${url.hash}`, { scroll: false });
  }, [router]);

  const lastCreateRequested = useRef(null);
  useEffect(() => {
    if (!apiKeys.loading && createRequested !== lastCreateRequested.current) {
      lastCreateRequested.current = createRequested;
      const allowed = apiKeys.contextReady && !createBlocked;
      setShowAddModalRef.current(allowed ? createRequested : false);
    }
  }, [createRequested, apiKeys.loading, createBlocked, apiKeys.contextReady]);

  useEffect(() => {
    if (apiKeys.revealed?.id && apiKeys.revealed.id !== lastRevealedId.current) {
      clearCreateParam();
    }
    lastRevealedId.current = apiKeys.revealed?.id;
  }, [apiKeys.revealed, clearCreateParam]);

  const closeCreate = () => {
    apiKeys.setShowAddModal(false);
    apiKeys.setNewKeyName("");
    apiKeys.setCreateError?.(null);
    clearCreateParam();
  };

  const security = deriveSecurityState({
    requireApiKey: tunnel.requireApiKey,
    requireLogin: tunnel.requireLogin,
    hasPassword: tunnel.hasPassword,
    tunnelEnabled: tunnel.tunnelEnabled,
    tsEnabled: tunnel.tsEnabled,
    tunnelDashboardAccess: tunnel.tunnelDashboardAccess,
    remoteHost: isRemoteHost,
  });

  const guardRemote = (openModal, setStatus, message) => {
    if (tunnel.isLoginUnsafe || message) {
      setStatus?.({
        type: "error",
        message: message || `Security required: ${tunnel.unsafeReason}`,
      });
      return;
    }
    openModal();
  };
  const guardTunnel = (openModal) =>
    guardRemote(
      openModal,
      tunnel.setTunnelStatus,
      tunnel.isLoginUnsafe
        ? `Security required: ${tunnel.unsafeReason}`
        : tunnel.requireApiKey
          ? null
          : 'Security required: Enable "Require API key" before activating the tunnel.',
    );
  const guardTailscale = (openModal) =>
    guardRemote(
      openModal,
      tunnel.setTsStatus,
      tunnel.isLoginUnsafe ? `Security required: ${tunnel.unsafeReason}` : null,
    );

  if (apiKeys.loading) {
    return (
      <div className="flex flex-col gap-4" aria-live="polite" aria-busy="true">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const effectiveSelectedKeyId =
    (selectedKeyId && apiKeys.keys.some((k) => k.id === selectedKeyId) ? selectedKeyId : null) ??
    apiKeys.keys[0]?.id ??
    null;

  const handleToggleKey = (id, checked) => {
    const target = apiKeys.keys.find((k) => k.id === id);
    if (target?.isActive && !checked) apiKeys.confirmPauseKey(target);
    else apiKeys.toggleKey(id, checked);
  };

  return (
    <div className="flex flex-col gap-4">
      {apiKeys.error && (
        <Callout variant="err" title="Couldn't load part of this page">
          {apiKeys.error}
        </Callout>
      )}

      <WaysInGrid
        localUrl={localUrl}
        tunnel={{
          checking: tunnel.tunnelChecking,
          enabled: tunnel.tunnelEnabled,
          reachable: tunnel.tunnelReachable,
          everReachable: tunnel.tunnelEverReachable,
          url: tunnel.tunnelUrl,
          publicUrl: tunnel.tunnelPublicUrl,
          loading: tunnel.tunnelLoading,
          progress: tunnel.tunnelProgress,
          status: tunnel.tunnelStatus,
          canEnable: tunnel.canEnableRemote,
          gateNote: tunnel.gateNote,
        }}
        tailscale={{
          enabled: tunnel.tsEnabled,
          reachable: tunnel.tsReachable,
          everReachable: tunnel.tsEverReachable,
          url: tunnel.tsUrl,
          loading: tunnel.tsLoading || tunnel.tsConnecting,
          progress: tunnel.tsProgress,
          status: tunnel.tsStatus,
          authUrl: tunnel.tsAuthUrl,
          authLabel: tunnel.tsAuthLabel,
          installed: tunnel.tsInstalled,
        }}
        onEnableTunnel={() => guardTunnel(() => tunnel.setShowEnableTunnelModal(true))}
        onStopTunnel={tunnel.setTunnelLoading}
        onDisableTunnel={() => tunnel.setShowDisableTunnelModal(true)}
        onConnectTailscale={() => guardTailscale(tunnel.handleOpenTsModal)}
        onDisableTailscale={() => tunnel.setShowDisableTsModal(true)}
        onInstallTailscale={tunnel.handleOpenTsModal}
        onStopTailscale={tunnel.setTsLoading}
      />

      {tunnel.isLoginUnsafe && !tunnel.tunnelEnabled && !tunnel.tsEnabled && (
        <Callout variant="warn">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm">{tunnel.unsafeReason}</span>
            <Button variant="ghost" size="sm" href="/dashboard/profile">
              Open settings
            </Button>
          </div>
        </Callout>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          <ApiKeysCard
            keys={apiKeys.keys}
            hashedMode={apiKeys.hashedMode}
            canCreate={apiKeys.capabilities.canCreate}
            canManage={apiKeys.capabilities.canManage}
            currentUserId={currentUserId ?? null}
            migrationNotice={apiKeys.migrationNotice}
            requireApiKey={tunnel.requireApiKey}
            onToggleRequireApiKey={tunnel.handleRequireApiKey}
            onCreateKey={() => apiKeys.setShowAddModal(true)}
            createdBanner={
              apiKeys.revealed
                ? { keyName: apiKeys.revealed.name, plainKey: apiKeys.revealed.plain }
                : null
            }
            onDismissBanner={apiKeys.dismissRevealed}
            onCopy={copy}
            copiedId={copied}
            copyError={copyError}
            visibleIds={apiKeys.visibleKeys}
            onToggleVisibility={apiKeys.toggleVisibility}
            togglingId={apiKeys.togglingId}
            onToggleKey={handleToggleKey}
            deletingId={apiKeys.deletingId}
            onDeleteKey={(id) => {
              const target = apiKeys.keys.find((k) => k.id === id);
              apiKeys.setConfirmState({
                title: "Delete API key",
                message: `Delete API key "${target?.name ?? ""}"? This cannot be undone.`,
                onConfirm: async () => {
                  apiKeys.setConfirmState(null);
                  await apiKeys.deleteKey(id);
                },
              });
            }}
            onRenameKey={apiKeys.renameKey}
            renamingId={apiKeys.renamingId}
            renameErrors={apiKeys.renameErrors}
            clearRenameError={apiKeys.clearRenameError}
            loading={false}
          />
          {apiKeys.budgetFailure && (
            <Callout variant="err" title="Key created, but budget was not saved">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm">
                  {apiKeys.budgetFailure.detail || "Copy the key, then retry the budget save."}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={apiKeys.retryBudget}
                  loading={apiKeys.budgetFailure.retrying}
                >
                  Retry budget save
                </Button>
              </div>
            </Callout>
          )}
          <QuickConnectCard
            baseUrl={localUrl}
            hashedMode={apiKeys.hashedMode}
            selectedKeyId={effectiveSelectedKeyId}
            keys={apiKeys.keys}
            revealed={apiKeys.revealed}
            onSelectKey={setSelectedKeyId}
            onCopy={copy}
            copiedId={copied}
            copyError={copyError}
          />
        </div>

        <div className="min-w-0">
          <AccessCard
            requireLogin={tunnel.requireLogin}
            tunnelDashboardAccess={tunnel.tunnelDashboardAccess}
            security={security}
            onToggleLogin={tunnel.handleRequireLogin}
            onToggleTunnelDash={tunnel.handleTunnelDashboardAccess}
          />
        </div>
      </div>

      {/* Tunnel dashboard access row is in AccessCard; the dashboard-over-tunnel
          toggle there is the single control (was bottom-row only in v1). */}

      {createRequested && apiKeys.contextReady && createBlocked && (
        <Callout variant="warn">
          You don&apos;t have permission to create keys in this workspace.
        </Callout>
      )}

      <KeyCreateDialog
        isOpen={apiKeys.showAddModal}
        onClose={closeCreate}
        onCreate={apiKeys.createKey}
        newName={apiKeys.newKeyName}
        onNewName={apiKeys.setNewKeyName}
        createError={apiKeys.createError}
        hashedMode={apiKeys.hashedMode}
        canCreateService={apiKeys.capabilities.canCreateService}
        createType={apiKeys.createType}
        onSetCreateType={apiKeys.setCreateType}
        createModels={apiKeys.createModels}
        onSetCreateModels={apiKeys.setCreateModels}
        createCombos={apiKeys.createCombos}
        onSetCreateCombos={apiKeys.setCreateCombos}
        createBudgetUsd={apiKeys.createBudgetUsd}
        onSetCreateBudgetUsd={apiKeys.setCreateBudgetUsd}
        createBudgetWindow={apiKeys.createBudgetWindow}
        onSetCreateBudgetWindow={apiKeys.setCreateBudgetWindow}
        createExpiry={apiKeys.createExpiry}
        onSetCreateExpiry={apiKeys.setCreateExpiry}
        customExpiryDate={apiKeys.customExpiryDate}
        onSetCustomExpiryDate={apiKeys.setCustomExpiryDate}
      />

      <Modal
        isOpen={tunnel.showEnableTunnelModal}
        onClose={() => tunnel.setShowEnableTunnelModal(false)}
        title="Enable tunnel"
        footer={
          <>
            <Button variant="ghost" onClick={() => tunnel.setShowEnableTunnelModal(false)}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={tunnel.handleEnableTunnel}>
              Start tunnel
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3 rounded-lg border border-line bg-raised p-4">
            <span className="material-symbols-outlined text-coral" aria-hidden="true">
              cloud_upload
            </span>
            <div>
              <p className="text-sm font-medium text-text">Cloudflare Tunnel</p>
              <p className="text-sm text-muted">
                {`Expose your local ${ACTIVE.name} to the internet. No port forwarding, no static IP needed. Share endpoint URL with your team or use it in Cursor, Cline, and other AI tools from anywhere.`}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {TUNNEL_BENEFITS.map((benefit) => (
              <div
                key={benefit.title}
                className="flex flex-col items-center rounded-lg bg-raised p-3 text-center"
              >
                <span
                  className="material-symbols-outlined mb-1 text-xl text-coral"
                  aria-hidden="true"
                >
                  {benefit.icon}
                </span>
                <p className="text-xs font-semibold text-text">{benefit.title}</p>
                <p className="text-xs text-muted">{benefit.desc}</p>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted">
            Requires outbound port 7844 (TCP/UDP). Connection may take 10-30s.
          </p>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={tunnel.showDisableTunnelModal}
        onClose={() => !tunnel.tunnelLoading && tunnel.setShowDisableTunnelModal(false)}
        onConfirm={tunnel.handleDisableTunnel}
        title="Disable tunnel"
        message="The Cloudflare tunnel will be disconnected. Remote access via tunnel URL will stop working."
        confirmText={tunnel.tunnelLoading ? "Disabling..." : "Disable"}
        cancelText="Cancel"
        variant="danger"
      />

      {/* Tailscale modal: check → install → connect */}
      <Modal
        isOpen={tunnel.showTsModal}
        onClose={() => {
          if (!tunnel.tsInstalling) {
            tunnel.setShowTsModal(false);
            tunnel.setTsSudoPassword("");
            tunnel.setTsStatus(null);
          }
        }}
        title="Tailscale Funnel"
      >
        <div className="flex flex-col gap-4">
          {tunnel.tsInstalled === null && (
            <div className="flex flex-col gap-2" aria-busy="true">
              <span className="sr-only" aria-live="polite">
                Checking...
              </span>
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-11 w-full" />
            </div>
          )}
          {tunnel.tsInstalled === false && !tunnel.tsInstalling && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted">
                Tailscale is not installed. Install it to enable Funnel.
              </p>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={tunnel.handleInstallTailscale} fullWidth>
                  Install Tailscale
                </Button>
                <Button variant="ghost" onClick={() => tunnel.setShowTsModal(false)} fullWidth>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {tunnel.tsInstalling && (
            <div className="flex flex-col gap-2" aria-live="polite">
              <Skeleton className="h-4 w-2/3" />
              <span className="text-sm text-muted">Installing Tailscale...</span>
              {tunnel.tsInstallLog.length > 0 && (
                <div
                  ref={tunnel.tsLogRef}
                  className="max-h-40 overflow-y-auto rounded bg-raised p-2 font-mono text-xs text-muted"
                >
                  {tunnel.tsInstallLog.map((line, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: append-only streamed log lines, no unique ids
                    <div key={i}>{line}</div>
                  ))}
                </div>
              )}
            </div>
          )}
          {tunnel.tsInstalled === true && !tunnel.tsInstalling && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2 text-sm text-ok">
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                  check_circle
                </span>
                Tailscale installed
              </div>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={() => tunnel.handleConnectTailscale()}
                  fullWidth
                >
                  Connect
                </Button>
                <Button variant="ghost" onClick={() => tunnel.setShowTsModal(false)} fullWidth>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {tunnel.tsStatus && (
            <Callout variant={tunnel.tsStatus.type === "error" ? "err" : "info"}>
              {tunnel.tsStatus.message}
            </Callout>
          )}
        </div>
      </Modal>

      {/* Disable Tailscale confirm */}
      <ConfirmDialog
        isOpen={tunnel.showDisableTsModal}
        onClose={() => !tunnel.tsLoading && tunnel.setShowDisableTsModal(false)}
        onConfirm={tunnel.handleDisableTailscale}
        title="Disable Tailscale"
        message="Tailscale Funnel will be stopped. Remote access via Tailscale URL will stop working."
        confirmText={tunnel.tsLoading ? "Disabling..." : "Disable"}
        cancelText="Cancel"
        variant="danger"
      />

      {/* Pause / delete key confirm */}
      <ConfirmDialog
        isOpen={!!apiKeys.confirmState}
        onClose={() => apiKeys.setConfirmState(null)}
        onConfirm={apiKeys.confirmState?.onConfirm}
        title={apiKeys.confirmState?.title || "Confirm"}
        message={apiKeys.confirmState?.message}
        variant="danger"
      />

      {/* Tunnel status toast (success/info, non-error statuses live inline in the card). */}
      {tunnel.tunnelStatus?.type === "success" && (
        <div className="flex items-center gap-2" aria-live="polite">
          <IconButton
            icon="close"
            aria-label="Dismiss"
            onClick={() => tunnel.setTunnelStatus(null)}
          />
          <Callout variant="ok">{tunnel.tunnelStatus.message}</Callout>
        </div>
      )}
    </div>
  );
}

EndpointPageClient.propTypes = {
  machineId: PropTypes.string.isRequired,
};
