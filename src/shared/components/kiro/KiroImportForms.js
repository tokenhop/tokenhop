"use client";

import PropTypes from "prop-types";
import Callout from "../Callout";
import Input from "../Input";
import Textarea from "../Textarea";
import { Spinner } from "../Loading";
import { KiroFormActions } from "./KiroSetupForms";

const CLI_PROXY_PLACEHOLDER =
  '{"auth_method":"external_idp","access_token":"...","refresh_token":"...","client_id":"...","token_endpoint":"https://login.microsoftonline.com/.../oauth2/v2.0/token","profile_arn":"...","scopes":"..."}';

/** Refresh-token import with AWS SSO cache auto-detect. */
export function KiroTokenImport({
  autoDetecting,
  autoDetected,
  refreshToken,
  onRefreshToken,
  error,
  importing,
  onSubmit,
  onBack,
}) {
  if (autoDetecting) {
    return (
      <div className="py-6 text-center">
        <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-coral-bg">
          <Spinner size="lg" />
        </div>
        <h3 className="mb-2 text-lg font-semibold">Auto-detecting token...</h3>
        <p className="text-sm text-muted">Reading from AWS SSO cache</p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {autoDetected && (
        <Callout variant="ok">Token auto-detected from Kiro IDE successfully!</Callout>
      )}
      {!autoDetected && !error && (
        <Callout variant="info">
          Kiro IDE not detected. Please paste your refresh token manually.
        </Callout>
      )}
      <Input
        label="Refresh Token"
        required
        value={refreshToken}
        onChange={(e) => onRefreshToken(e.target.value)}
        placeholder="Token will be auto-filled..."
        inputClassName="font-mono text-sm"
      />
      {error && <Callout variant="err">{error}</Callout>}
      <KiroFormActions
        primary={importing ? "Importing..." : "Import Token"}
        onPrimary={onSubmit}
        disabled={importing || !refreshToken.trim()}
        onBack={onBack}
      />
    </div>
  );
}

KiroTokenImport.propTypes = {
  autoDetecting: PropTypes.bool.isRequired,
  autoDetected: PropTypes.bool.isRequired,
  refreshToken: PropTypes.string.isRequired,
  onRefreshToken: PropTypes.func.isRequired,
  error: PropTypes.string,
  importing: PropTypes.bool.isRequired,
  onSubmit: PropTypes.func.isRequired,
  onBack: PropTypes.func.isRequired,
};

/** CLIProxyAPI external_idp JSON import. */
export function KiroCliProxyImport({ json, onJson, error, importing, onSubmit, onBack }) {
  return (
    <div className="space-y-4">
      <Callout variant="info">
        Paste the Kiro CLIProxyAPI auth JSON containing auth_method=external_idp. Only Microsoft
        login token endpoints are accepted.
      </Callout>
      <Textarea
        label="CLIProxyAPI Auth JSON"
        required
        rows={7}
        value={json}
        onChange={(e) => onJson(e.target.value)}
        placeholder={CLI_PROXY_PLACEHOLDER}
        textareaClassName="min-h-40 font-mono text-sm"
      />
      {error && <Callout variant="err">{error}</Callout>}
      <KiroFormActions
        primary={importing ? "Importing..." : "Import CLIProxyAPI JSON"}
        onPrimary={onSubmit}
        disabled={importing || !json.trim()}
        onBack={onBack}
      />
    </div>
  );
}

KiroCliProxyImport.propTypes = {
  json: PropTypes.string.isRequired,
  onJson: PropTypes.func.isRequired,
  error: PropTypes.string,
  importing: PropTypes.bool.isRequired,
  onSubmit: PropTypes.func.isRequired,
  onBack: PropTypes.func.isRequired,
};
