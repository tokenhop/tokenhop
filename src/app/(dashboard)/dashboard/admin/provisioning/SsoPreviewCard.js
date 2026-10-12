"use client";

// YAN-373: "preview draft" panel — provider choice, round-trip start button,
// and the one-shot result. Never persists or logs result data.

import PropTypes from "prop-types";
import { Button, Callout, Card, LoadingState, Select } from "@/shared/components";
import { PreviewResult } from "./PreviewResult";

const PROVIDER_OPTIONS = [
  { value: "oidc", label: "OIDC" },
  { value: "saml", label: "SAML" },
];

export function SsoPreviewCard({ preview, onPreview, disabled }) {
  const { provider, setProvider, starting, startError, result, resultError, resultLoading } =
    preview;
  return (
    <Card
      title="Preview draft"
      subtitle="Test the unsaved draft against the saved SSO connection for one of your identities. Nothing is saved and your account is never changed."
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Select
            label="Provider"
            placeholder={null}
            options={PROVIDER_OPTIONS}
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            disabled={disabled || starting}
            className="sm:w-48"
          />
          <Button
            variant="outline"
            icon="open_in_new"
            loading={starting}
            disabled={disabled || starting}
            onClick={onPreview}
          >
            Preview draft
          </Button>
        </div>
        <p className="text-xs text-muted">
          Previewing starts a sign-in round trip and brings you back here. It pairs the draft on
          this page with the saved connection settings; it never falls back to the saved policy or a
          synthetic role.
        </p>

        {startError ? <Callout variant="err">{startError}</Callout> : null}

        {resultLoading ? (
          <LoadingState label="Loading preview result" lines={4} />
        ) : result ? (
          <PreviewResult result={result} />
        ) : resultError ? (
          <Callout variant="err" title="Preview failed">
            {resultError}
          </Callout>
        ) : (
          <p className="text-sm text-muted">
            No preview yet. Choose a provider and run a preview to see the groups your identity
            provider returns and the role and workspaces a new user would get.
          </p>
        )}
      </div>
    </Card>
  );
}

SsoPreviewCard.propTypes = {
  preview: PropTypes.shape({
    provider: PropTypes.string.isRequired,
    setProvider: PropTypes.func.isRequired,
    starting: PropTypes.bool.isRequired,
    startError: PropTypes.string.isRequired,
    start: PropTypes.func.isRequired,
    result: PropTypes.object,
    resultError: PropTypes.string.isRequired,
    resultLoading: PropTypes.bool.isRequired,
  }).isRequired,
  onPreview: PropTypes.func.isRequired,
  disabled: PropTypes.bool,
};
