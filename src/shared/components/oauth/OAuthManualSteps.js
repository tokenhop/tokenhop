"use client";

import PropTypes from "prop-types";
import Button from "../Button";
import CopyField from "../CopyField";
import Input from "../Input";
import { Spinner } from "../Loading";

/** Browser popup progress and manual callback fallback for non-device providers. */
export default function OAuthManualSteps({
  provider,
  authUrl,
  callbackUrl,
  onCallbackUrlChange,
  placeholder,
  onSubmit,
  onCancel,
}) {
  const xai = provider === "xai";
  const kimchi = provider === "kimchi";
  return (
    <div className="space-y-4">
      <div
        role="status"
        className="flex items-center gap-2 rounded-xl border border-line bg-sky-bg px-3 py-2 text-sm text-text"
      >
        <Spinner size="sm" className="text-sky" />
        {xai ? "Waiting for Grok Build OAuth…" : "Waiting for popup authorization…"}
      </div>
      <div className="flex items-center gap-3 py-1">
        <div className="h-px flex-1 bg-line" />
        <span className="text-xs uppercase tracking-wider text-muted">
          Or paste callback URL manually
        </span>
        <div className="h-px flex-1 bg-line" />
      </div>
      <div className="space-y-4">
        <div className="space-y-2">
          <p className="text-sm font-medium">
            Step 1: Open this {xai ? "Grok Build OAuth URL" : "URL"} in your browser
          </p>
          <CopyField value={authUrl || ""} label="Copy authorization URL" />
        </div>
        <Input
          label={
            xai
              ? "Step 2: Paste the callback URL or copied code here"
              : kimchi
                ? "Step 2: Paste the callback URL or copied token here"
                : "Step 2: Paste the callback URL here"
          }
          hint={
            xai
              ? "If xAI shows a code instead of redirecting, paste that code here."
              : kimchi
                ? "After authorization, copy the full callback URL or token from your browser."
                : "After authorization, copy the full URL from your browser."
          }
          value={callbackUrl}
          onChange={(e) => onCallbackUrlChange(e.target.value)}
          placeholder={placeholder}
          inputClassName="font-mono text-xs"
        />
      </div>
      <div className="flex gap-2">
        <Button onClick={onSubmit} fullWidth disabled={!callbackUrl}>
          Connect
        </Button>
        <Button onClick={onCancel} variant="ghost" fullWidth>
          Cancel
        </Button>
      </div>
    </div>
  );
}

OAuthManualSteps.propTypes = {
  provider: PropTypes.string.isRequired,
  authUrl: PropTypes.string,
  callbackUrl: PropTypes.string.isRequired,
  onCallbackUrlChange: PropTypes.func.isRequired,
  placeholder: PropTypes.string.isRequired,
  onSubmit: PropTypes.func.isRequired,
  onCancel: PropTypes.func.isRequired,
};
