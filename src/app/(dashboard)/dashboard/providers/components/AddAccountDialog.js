"use client";

import PropTypes from "prop-types";
import { useEffect, useState } from "react";
import {
  Button,
  OAuthModal,
  KiroOAuthWrapper,
  CursorAuthModal,
  GitLabAuthModal,
  XiaomiMimoAuthModal,
  IFlowCookieModal,
} from "@/shared/components";
import AddApiKeyModal from "../[id]/AddApiKeyModal";

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
  const [showOAuthModal, setShowOAuthModal] = useState(false);
  const [showAgRisk, setShowAgRisk] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const isOAuthEntry = entry.authGroup === "oauth" || entry.authGroup === "free";

  useEffect(() => {
    if (entry.id === "antigravity" && typeof window !== "undefined") {
      const confirmed = window.localStorage.getItem(AG_RISK_STORAGE_KEY) === "true";
      if (!confirmed) {
        setShowAgRisk(true);
        return;
      }
    }
    setShowOAuthModal(true);
  }, [entry.id]);

  const handleOAuthSuccess = () => {
    onChanged?.();
    onClose();
  };

  const handleKeySave = async (formData) => {
    await onSave(formData);
  };

  if (!isOAuthEntry) {
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
        />
      ) : entry.id === "cursor" ? (
        <CursorAuthModal
          isOpen={showOAuthModal}
          providerInfo={entry.info}
          onSuccess={handleOAuthSuccess}
          onClose={onClose}
        />
      ) : entry.id === "gitlab" ? (
        <GitLabAuthModal
          isOpen={showOAuthModal}
          providerInfo={entry.info}
          onSuccess={handleOAuthSuccess}
          onClose={onClose}
        />
      ) : entry.id === "xiaomi-mimo" ? (
        <XiaomiMimoAuthModal
          isOpen={showOAuthModal}
          providerInfo={entry.info}
          onSuccess={handleOAuthSuccess}
          onClose={onClose}
        />
      ) : entry.id === "iflow" ? (
        <IFlowCookieModal
          isOpen={showOAuthModal}
          providerInfo={entry.info}
          onSuccess={handleOAuthSuccess}
          onClose={onClose}
        />
      ) : (
        <OAuthModal
          isOpen={showOAuthModal}
          provider={entry.id}
          providerInfo={entry.info}
          onSuccess={handleOAuthSuccess}
          onClose={onClose}
        />
      )}

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
                  setShowOAuthModal(true);
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
