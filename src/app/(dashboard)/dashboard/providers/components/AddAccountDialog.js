"use client";

import PropTypes from "prop-types";
import { useEffect, useState } from "react";
import {
  Button,
  Modal,
  OAuthModal,
  KiroOAuthWrapper,
  CursorAuthModal,
  GitLabAuthModal,
  XiaomiMimoAuthModal,
  IFlowCookieModal,
} from "@/shared/components";
import AddApiKeyModal from "../[id]/AddApiKeyModal";
import useConnectTarget from "../useConnectTarget";
import WorkspaceTargetField from "./WorkspaceTargetField";

const AG_RISK_STORAGE_KEY = "ag_risk_confirmed";

/**
 * Add Account dialog for a provider on the list page.
 * Routes to OAuth wrapper/account/key modals based on provider configuration.
 */
export default function AddAccountDialog({
  entry,
  proxyPools,
  error,
  existingNames,
  onSave,
  onClose,
  onChanged,
}) {
  const target = useConnectTarget();
  const [showOAuthModal, setShowOAuthModal] = useState(false);
  const [showTarget, setShowTarget] = useState(false);
  const [showAgRisk, setShowAgRisk] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const isOAuthEntry = entry.authGroup === "oauth" || entry.authGroup === "free";

  const manageableCount = target.workspaces.length;

  // Auto-open flow. Decides once the workspace target is known: antigravity
  // risk gate first (unchanged), then a workspace picker when more than one
  // manageable workspace exists, otherwise straight to the auth modal.
  useEffect(() => {
    setShowAgRisk(false);
    setShowOAuthModal(false);
    setShowTarget(false);
    if (!target.ready) return;
    if (entry.id === "antigravity" && typeof window !== "undefined") {
      const confirmed = window.localStorage.getItem(AG_RISK_STORAGE_KEY) === "true";
      if (!confirmed) {
        setShowAgRisk(true);
        return;
      }
    }
    if (manageableCount > 1) {
      setShowTarget(true);
      return;
    }
    setShowOAuthModal(true);
  }, [entry.id, target.ready, manageableCount]);

  const openAfterPreflight = () => {
    if (manageableCount > 1) {
      setShowTarget(true);
      return;
    }
    setShowOAuthModal(true);
  };

  const handleTargetContinue = () => {
    setShowTarget(false);
    setShowOAuthModal(true);
  };

  const handleOAuthSuccess = () => {
    onChanged?.();
    onClose();
  };

  const handleKeySave = async (formData) => {
    await onSave(formData, target.workspaceId);
  };

  if (!isOAuthEntry) {
    if (!target.ready) return null;
    return (
      <AddApiKeyModal
        isOpen
        provider={entry.id}
        providerName={entry.info.name}
        isCompatible={false}
        isAnthropic={false}
        authType={entry.info.authType}
        authHint={entry.info.authHint}
        website={entry.info.website}
        proxyPools={proxyPools}
        error={error}
        existingNames={existingNames}
        onSave={handleKeySave}
        workspaceId={target.workspaceId}
        targetField={
          <WorkspaceTargetField
            value={target.workspaceId ?? ""}
            onChange={target.setWorkspaceId}
            workspaces={target.workspaces}
          />
        }
        onBulkDone={onChanged}
        onClose={onClose}
      />
    );
  }

  return (
    <>
      {entry.id === "kiro" ? (
        <KiroOAuthWrapper
          isOpen={showOAuthModal}
          providerInfo={entry.info}
          onSuccess={handleOAuthSuccess}
          onClose={onClose}
          workspaceId={target.workspaceId}
        />
      ) : entry.id === "cursor" ? (
        <CursorAuthModal
          isOpen={showOAuthModal}
          providerInfo={entry.info}
          onSuccess={handleOAuthSuccess}
          onClose={onClose}
          workspaceId={target.workspaceId}
        />
      ) : entry.id === "gitlab" ? (
        <GitLabAuthModal
          isOpen={showOAuthModal}
          providerInfo={entry.info}
          onSuccess={handleOAuthSuccess}
          onClose={onClose}
          workspaceId={target.workspaceId}
        />
      ) : entry.id === "xiaomi-mimo" ? (
        <XiaomiMimoAuthModal
          isOpen={showOAuthModal}
          providerInfo={entry.info}
          onSuccess={handleOAuthSuccess}
          onClose={onClose}
          workspaceId={target.workspaceId}
        />
      ) : entry.id === "iflow" ? (
        <IFlowCookieModal
          isOpen={showOAuthModal}
          providerInfo={entry.info}
          onSuccess={handleOAuthSuccess}
          onClose={onClose}
          workspaceId={target.workspaceId}
        />
      ) : (
        <OAuthModal
          isOpen={showOAuthModal}
          provider={entry.id}
          providerInfo={entry.info}
          onSuccess={handleOAuthSuccess}
          onClose={onClose}
          workspaceId={target.workspaceId}
        />
      )}

      <Modal
        isOpen={showTarget}
        title={`Connect ${entry.info.name}`}
        description="Pick the workspace that will own this account."
        onClose={onClose}
        footer={
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" disabled={!target.workspaceId} onClick={handleTargetContinue}>
              Continue
            </Button>
          </div>
        }
      >
        <WorkspaceTargetField
          value={target.workspaceId ?? ""}
          onChange={target.setWorkspaceId}
          workspaces={target.workspaces}
        />
      </Modal>

      {showAgRisk && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="ag-risk-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <div className="signal-backdrop absolute inset-0" aria-hidden="true" onClick={onClose} />
          <div className="relative w-full max-w-md rounded-[20px] border border-line bg-panel p-6 shadow-card">
            <h2 id="ag-risk-title" className="font-display text-lg font-bold">
              Antigravity carries account risk
            </h2>
            <p className="mt-2 text-sm text-muted">
              Unofficial OAuth for Google Antigravity can trigger account review. Continue only with
              a spare account.
            </p>
            <label className="mt-4 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="size-4"
              />
              I understand the risk
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={!acknowledged}
                onClick={() => {
                  window.localStorage.setItem(AG_RISK_STORAGE_KEY, "true");
                  setShowAgRisk(false);
                  openAfterPreflight();
                }}
              >
                Continue
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

AddAccountDialog.propTypes = {
  entry: PropTypes.object.isRequired,
  proxyPools: PropTypes.array,
  error: PropTypes.string,
  existingNames: PropTypes.array,
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
  onChanged: PropTypes.func,
};
