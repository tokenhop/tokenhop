"use client";

import PropTypes from "prop-types";
import Modal from "./Modal";
import OAuthDeviceStep from "./oauth/OAuthDeviceStep";
import OAuthManualSteps from "./oauth/OAuthManualSteps";
import OAuthResultStep from "./oauth/OAuthResultStep";
import ProxyOAuthPanel from "./ProxyOAuthPanel";
import useOAuthFlow from "@/shared/hooks/useOAuthFlow";
import { PROXY_OAUTH_PROVIDERS } from "./oauth/authFlowHelpers";

/**
 * Generic OAuth modal (auth code + popup, device code, fixed/dynamic proxies,
 * paste-token). Flow logic lives in useOAuthFlow; this file only renders steps.
 */
export default function OAuthModal({
  isOpen,
  provider,
  providerInfo,
  onSuccess,
  onClose,
  oauthMeta,
  idcConfig,
}) {
  const flow = useOAuthFlow({ isOpen, provider, oauthMeta, idcConfig, onSuccess, onClose });
  const {
    step,
    authData,
    callbackUrl,
    setCallbackUrl,
    error,
    isDeviceCode,
    deviceData,
    polling,
    authMode,
    pasteToken,
    setPasteToken,
    ideStatus,
    placeholderUrl,
    copied,
    copyError,
    copy,
    startOAuthFlow,
    handleManualSubmit,
    handleClose,
    selectBrowserMode,
    selectPasteTokenMode,
  } = flow;

  if (!provider || !providerInfo) return null;
  const proxyProvider = PROXY_OAUTH_PROVIDERS.has(provider);
  const xai = provider === "xai";
  const kimchi = provider === "kimchi";
  const title = xai ? "Connect Grok Build OAuth" : `Connect ${providerInfo.name}`;
  const manualPlaceholder = xai
    ? "http://127.0.0.1:56121/callback?code=... or copied code"
    : kimchi
      ? `${placeholderUrl.replace("code=...", "token=...")} or copied token`
      : placeholderUrl;

  return (
    <Modal isOpen={isOpen} title={title} onClose={handleClose} size="lg">
      <div className="flex flex-col gap-4">
        {proxyProvider && (step === "waiting" || step === "input" || step === "error") && (
          <ProxyOAuthPanel
            provider={provider}
            step={step}
            authMode={authMode}
            authUrl={authData?.authUrl}
            callbackUrl={callbackUrl}
            onCallbackUrlChange={setCallbackUrl}
            pasteToken={pasteToken}
            onPasteTokenChange={setPasteToken}
            ideStatus={ideStatus}
            onSelectBrowser={selectBrowserMode}
            onSelectPasteToken={selectPasteTokenMode}
            onSubmit={handleManualSubmit}
            onCancel={handleClose}
          />
        )}

        {(step === "waiting" || step === "input") && !isDeviceCode && !proxyProvider && (
          <OAuthManualSteps
            provider={provider}
            authUrl={authData?.authUrl}
            callbackUrl={callbackUrl}
            onCallbackUrlChange={setCallbackUrl}
            placeholder={manualPlaceholder}
            onSubmit={handleManualSubmit}
            onCancel={handleClose}
          />
        )}

        {step === "waiting" && isDeviceCode && deviceData && (
          <OAuthDeviceStep
            deviceData={deviceData}
            copied={copied}
            error={copyError}
            copy={copy}
            polling={polling}
          />
        )}

        {step === "success" && (
          <OAuthResultStep
            status="success"
            providerName={providerInfo.name}
            onClose={handleClose}
          />
        )}

        {step === "error" && (
          <OAuthResultStep
            status="error"
            error={error}
            onRetry={() => startOAuthFlow()}
            onClose={handleClose}
          />
        )}
      </div>
    </Modal>
  );
}

OAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  provider: PropTypes.string,
  providerInfo: PropTypes.shape({ name: PropTypes.string }),
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
  /** Extra metadata passed to /authorize and /exchange (e.g. gitlab clientId/baseUrl) */
  oauthMeta: PropTypes.object,
  /** Optional Kiro IDC config for AWS IAM Identity Center device flow */
  idcConfig: PropTypes.shape({
    startUrl: PropTypes.string,
    region: PropTypes.string,
  }),
};
