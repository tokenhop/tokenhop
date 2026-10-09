"use client";

import PropTypes from "prop-types";
import { useEffect, useState } from "react";
import {
  Button,
  Modal,
  ConfirmDialog,
  CursorAuthModal,
  EditConnectionModal,
  GitLabAuthModal,
  IFlowCookieModal,
  KiroOAuthWrapper,
  OAuthModal,
  XiaomiMimoAuthModal,
} from "@/shared/components";
import AddApiKeyModal from "../[id]/AddApiKeyModal";
import useConnectTarget from "../useConnectTarget";
import WorkspaceTargetField from "../components/WorkspaceTargetField";
import EditCompatibleNodeModal from "../[id]/EditCompatibleNodeModal";
import AddCustomModelModal from "../[id]/AddCustomModelModal";
import BulkImportCodexModal from "../[id]/BulkImportCodexModal";
import BulkImportGrokCliModal from "../[id]/BulkImportGrokCliModal";
import { plainNotice } from "./ProviderDetailHeader";

/**
 * Every auth entry point on the detail page, through Signal modals.
 * OAuth, device code, cookie, API key and bulk imports stay reachable.
 */
export function AddConnectionButtons({
  providerId,
  isCompatible,
  hasDualAuthModes,
  labels,
  onOAuth,
  onApiKey,
  onAdd,
  onCookie,
  onBulkCodex,
  onBulkGrokCli,
}) {
  return (
    <>
      {providerId === "iflow" ? (
        <Button
          size="sm"
          icon="cookie"
          variant="secondary"
          onClick={onCookie}
          title="Add connection using browser cookie"
        >
          Cookie
        </Button>
      ) : null}
      {providerId === "codex" ? (
        <Button
          size="sm"
          icon="playlist_add"
          variant="secondary"
          onClick={onBulkCodex}
          title="Bulk import codex accounts from JSON"
        >
          Bulk add
        </Button>
      ) : null}
      {providerId === "grok-cli" ? (
        <Button
          size="sm"
          icon="playlist_add"
          variant="secondary"
          onClick={onBulkGrokCli}
          title="Bulk import Grok CLI accounts from JSON"
        >
          Bulk add
        </Button>
      ) : null}
      {hasDualAuthModes ? (
        <>
          <Button size="sm" icon="lock" variant="secondary" onClick={onOAuth}>
            {labels.oauth}
          </Button>
          <Button size="sm" icon="key" variant="primary" onClick={onApiKey}>
            {labels.apiKey}
          </Button>
        </>
      ) : (
        <Button size="sm" icon="add" variant="primary" onClick={onAdd}>
          {isCompatible ? "Add API key" : providerId === "iflow" ? "OAuth" : "Add connection"}
        </Button>
      )}
    </>
  );
}

AddConnectionButtons.propTypes = {
  providerId: PropTypes.string.isRequired,
  isCompatible: PropTypes.bool.isRequired,
  hasDualAuthModes: PropTypes.bool.isRequired,
  labels: PropTypes.object.isRequired,
  onOAuth: PropTypes.func.isRequired,
  onApiKey: PropTypes.func.isRequired,
  onAdd: PropTypes.func.isRequired,
  onCookie: PropTypes.func.isRequired,
  onBulkCodex: PropTypes.func.isRequired,
  onBulkGrokCli: PropTypes.func.isRequired,
};

/**
 * Signal auth-flows block: OAuth variants, cookie, API key, connection edit,
 * compatible node edit, custom model add, bulk imports and risk confirm.
 */
export default function AuthFlows({
  providerId,
  providerInfo,
  isCompatible,
  isAnthropic,
  storageAlias,
  displayAlias,
  proxyPools,
  connectionNames,
  addConnectionError,
  selectedConnection,
  show,
  handlers,
  models,
  workspaceId: scopeWorkspaceId = null,
}) {
  const target = useConnectTarget();
  const workspaceId = target.workspaceId ?? scopeWorkspaceId;
  // Workspace preflight before any sign-in starts (multi-workspace only).
  const authMode = show.oauth
    ? "oauth"
    : show.xiaomiMimo
      ? "xiaomi"
      : show.iflowCookie
        ? "iflow"
        : null;
  const [confirmedMode, setConfirmedMode] = useState(null);
  useEffect(() => {
    if (authMode !== confirmedMode) setConfirmedMode(null);
  }, [authMode, confirmedMode]);
  const needsTarget =
    target.ready && target.workspaces.length > 1 && authMode && confirmedMode !== authMode;
  const authOpen = (flag) => Boolean(flag) && target.ready && !needsTarget;
  const cancelTarget = {
    oauth: handlers.closeOAuth,
    xiaomi: handlers.closeXiaomiMimo,
    iflow: handlers.closeIflowCookie,
  }[authMode];
  return (
    <>
      <Modal
        isOpen={Boolean(needsTarget)}
        onClose={() => cancelTarget?.()}
        title={`Connect ${providerInfo.name}`}
        description="Pick the workspace that will own this account."
        footer={
          <>
            <Button variant="ghost" onClick={() => cancelTarget?.()}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!workspaceId}
              onClick={() => setConfirmedMode(authMode)}
            >
              Continue
            </Button>
          </>
        }
      >
        <WorkspaceTargetField
          value={workspaceId ?? ""}
          onChange={target.setWorkspaceId}
          workspaces={target.workspaces}
        />
      </Modal>
      {providerId === "kiro" ? (
        <KiroOAuthWrapper
          workspaceId={workspaceId}
          isOpen={authOpen(show.oauth)}
          providerInfo={providerInfo}
          onSuccess={handlers.oauthSuccess}
          onClose={handlers.closeOAuth}
        />
      ) : providerId === "cursor" ? (
        <CursorAuthModal
          workspaceId={workspaceId}
          isOpen={authOpen(show.oauth)}
          providerInfo={providerInfo}
          onSuccess={handlers.oauthSuccess}
          onClose={handlers.closeOAuth}
        />
      ) : providerId === "gitlab" ? (
        <GitLabAuthModal
          workspaceId={workspaceId}
          isOpen={authOpen(show.oauth)}
          providerInfo={providerInfo}
          onSuccess={handlers.oauthSuccess}
          onClose={handlers.closeOAuth}
        />
      ) : (
        <OAuthModal
          workspaceId={workspaceId}
          isOpen={authOpen(show.oauth)}
          provider={providerId}
          providerInfo={providerInfo}
          onSuccess={handlers.oauthSuccess}
          onClose={handlers.closeOAuth}
        />
      )}
      <XiaomiMimoAuthModal
        workspaceId={workspaceId}
        isOpen={authOpen(show.xiaomiMimo)}
        onSuccess={handlers.oauthSuccess}
        onClose={handlers.closeXiaomiMimo}
      />
      {providerId === "iflow" ? (
        <IFlowCookieModal
          workspaceId={workspaceId}
          isOpen={authOpen(show.iflowCookie)}
          onSuccess={handlers.iflowCookieSuccess}
          onClose={handlers.closeIflowCookie}
        />
      ) : null}
      <AddApiKeyModal
        workspaceId={workspaceId}
        isOpen={show.addApiKey}
        provider={providerId}
        providerName={providerInfo.name}
        isCompatible={isCompatible}
        isAnthropic={isAnthropic}
        authType={providerInfo?.authType}
        authHint={providerInfo?.authHint}
        website={providerInfo?.website}
        proxyPools={proxyPools}
        error={addConnectionError}
        existingNames={connectionNames}
        onSave={handlers.saveApiKey}
        targetField={
          <WorkspaceTargetField
            value={workspaceId ?? ""}
            onChange={target.setWorkspaceId}
            workspaces={target.workspaces}
          />
        }
        onBulkDone={handlers.refreshConnections}
        onClose={handlers.closeAddApiKey}
      />
      <EditConnectionModal
        isOpen={show.edit}
        connection={selectedConnection}
        proxyPools={proxyPools}
        onSave={handlers.updateConnection}
        onClose={handlers.closeEdit}
      />
      {isCompatible ? (
        <EditCompatibleNodeModal
          isOpen={show.editNode}
          node={handlers.compatibleNode}
          onSave={handlers.updateNode}
          onClose={handlers.closeEditNode}
          isAnthropic={isAnthropic}
        />
      ) : null}
      {!isCompatible ? (
        <AddCustomModelModal
          isOpen={models.showAddCustomModel}
          providerAlias={storageAlias}
          providerDisplayAlias={displayAlias}
          onSave={handlers.saveCustomModel}
          onClose={handlers.closeAddCustomModel}
        />
      ) : null}
      {providerId === "codex" ? (
        <BulkImportCodexModal
          workspaceId={workspaceId}
          isOpen={show.bulkCodex}
          onClose={handlers.closeBulkCodex}
          onSuccess={handlers.refreshConnections}
        />
      ) : null}
      {providerId === "grok-cli" ? (
        <BulkImportGrokCliModal
          workspaceId={workspaceId}
          isOpen={show.bulkGrokCli}
          onClose={handlers.closeBulkGrokCli}
          onSuccess={handlers.refreshConnections}
        />
      ) : null}
      <ConfirmDialog
        isOpen={show.agRisk}
        onClose={handlers.closeAgRisk}
        onConfirm={handlers.confirmAgRisk}
        title="Risk notice"
        message={plainNotice(providerInfo?.deprecationNotice)}
        confirmText="I understand, continue"
        cancelText="Cancel"
        variant="danger"
      />
    </>
  );
}

AuthFlows.propTypes = {
  workspaceId: PropTypes.string,
  providerId: PropTypes.string.isRequired,
  providerInfo: PropTypes.object.isRequired,
  isCompatible: PropTypes.bool.isRequired,
  isAnthropic: PropTypes.bool.isRequired,
  storageAlias: PropTypes.string.isRequired,
  displayAlias: PropTypes.string.isRequired,
  proxyPools: PropTypes.array.isRequired,
  connectionNames: PropTypes.array.isRequired,
  addConnectionError: PropTypes.string,
  selectedConnection: PropTypes.object,
  show: PropTypes.shape({
    oauth: PropTypes.bool.isRequired,
    xiaomiMimo: PropTypes.bool.isRequired,
    iflowCookie: PropTypes.bool.isRequired,
    addApiKey: PropTypes.bool.isRequired,
    edit: PropTypes.bool.isRequired,
    editNode: PropTypes.bool.isRequired,
    bulkCodex: PropTypes.bool.isRequired,
    bulkGrokCli: PropTypes.bool.isRequired,
    agRisk: PropTypes.bool.isRequired,
  }).isRequired,
  handlers: PropTypes.shape({
    oauthSuccess: PropTypes.func.isRequired,
    closeOAuth: PropTypes.func.isRequired,
    closeXiaomiMimo: PropTypes.func.isRequired,
    iflowCookieSuccess: PropTypes.func.isRequired,
    closeIflowCookie: PropTypes.func.isRequired,
    saveApiKey: PropTypes.func.isRequired,
    refreshConnections: PropTypes.func.isRequired,
    closeAddApiKey: PropTypes.func.isRequired,
    updateConnection: PropTypes.func.isRequired,
    closeEdit: PropTypes.func.isRequired,
    compatibleNode: PropTypes.object,
    updateNode: PropTypes.func.isRequired,
    closeEditNode: PropTypes.func.isRequired,
    saveCustomModel: PropTypes.func.isRequired,
    closeAddCustomModel: PropTypes.func.isRequired,
    closeBulkCodex: PropTypes.func.isRequired,
    closeBulkGrokCli: PropTypes.func.isRequired,
    closeAgRisk: PropTypes.func.isRequired,
    confirmAgRisk: PropTypes.func.isRequired,
  }).isRequired,
  models: PropTypes.object.isRequired,
};
