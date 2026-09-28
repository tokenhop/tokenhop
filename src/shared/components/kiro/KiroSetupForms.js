"use client";

import PropTypes from "prop-types";
import Button from "../Button";
import Callout from "../Callout";
import Input from "../Input";

function Actions({ primary, onPrimary, disabled, onBack }) {
  return (
    <div className="flex gap-2">
      <Button onClick={onPrimary} fullWidth disabled={disabled}>
        {primary}
      </Button>
      <Button onClick={onBack} variant="ghost" fullWidth>
        Back
      </Button>
    </div>
  );
}

Actions.propTypes = {
  primary: PropTypes.node.isRequired,
  onPrimary: PropTypes.func.isRequired,
  disabled: PropTypes.bool,
  onBack: PropTypes.func.isRequired,
};

/** AWS IAM Identity Center start URL + region. */
export function KiroIdcForm({ startUrl, onStartUrl, region, onRegion, error, onContinue, onBack }) {
  return (
    <div className="space-y-4">
      <Input
        label="IDC Start URL"
        required
        value={startUrl}
        onChange={(e) => onStartUrl(e.target.value)}
        placeholder="https://your-org.awsapps.com/start"
        hint="Your organization's AWS IAM Identity Center URL"
        inputClassName="font-mono text-sm"
      />
      <Input
        label="AWS Region"
        value={region}
        onChange={(e) => onRegion(e.target.value)}
        placeholder="us-east-1"
        hint="AWS region for your Identity Center (default: us-east-1)"
        inputClassName="font-mono text-sm"
      />
      {error && <Callout variant="err">{error}</Callout>}
      <Actions primary="Continue" onPrimary={onContinue} onBack={onBack} />
    </div>
  );
}

KiroIdcForm.propTypes = {
  startUrl: PropTypes.string.isRequired,
  onStartUrl: PropTypes.func.isRequired,
  region: PropTypes.string.isRequired,
  onRegion: PropTypes.func.isRequired,
  error: PropTypes.string,
  onContinue: PropTypes.func.isRequired,
  onBack: PropTypes.func.isRequired,
};

/** Long-lived Kiro/CodeWhisperer API key. */
export function KiroApiKeyForm({
  apiKey,
  onApiKey,
  region,
  onRegion,
  error,
  importing,
  onSubmit,
  onBack,
}) {
  return (
    <div className="space-y-4">
      <Callout variant="info">
        Paste a long-lived Kiro/CodeWhisperer API key. It is validated against AWS and stored
        directly as a bearer credential (no refresh).
      </Callout>
      <Input
        label="API Key"
        required
        value={apiKey}
        onChange={(e) => onApiKey(e.target.value)}
        placeholder="Paste your Kiro API key..."
        inputClassName="font-mono text-sm"
      />
      <Input
        label="AWS Region"
        value={region}
        onChange={(e) => onRegion(e.target.value)}
        placeholder="us-east-1"
        hint="AWS region for the key (default: us-east-1)"
        inputClassName="font-mono text-sm"
      />
      {error && <Callout variant="err">{error}</Callout>}
      <Actions
        primary={importing ? "Validating..." : "Add API Key"}
        onPrimary={onSubmit}
        disabled={importing || !apiKey.trim()}
        onBack={onBack}
      />
    </div>
  );
}

KiroApiKeyForm.propTypes = {
  apiKey: PropTypes.string.isRequired,
  onApiKey: PropTypes.func.isRequired,
  region: PropTypes.string.isRequired,
  onRegion: PropTypes.func.isRequired,
  error: PropTypes.string,
  importing: PropTypes.bool.isRequired,
  onSubmit: PropTypes.func.isRequired,
  onBack: PropTypes.func.isRequired,
};

/** Google/GitHub manual-callback notice (cards currently hidden in the picker). */
export function KiroSocialInfo({ provider, onContinue, onBack }) {
  return (
    <div className="space-y-4">
      <Callout variant="warn" icon="info" title="Manual Callback Required">
        After login, you&apos;ll need to copy the callback URL from your browser and paste it back
        here.
      </Callout>
      <Actions
        primary={`Continue with ${provider === "google" ? "Google" : "GitHub"}`}
        onPrimary={onContinue}
        onBack={onBack}
      />
    </div>
  );
}

KiroSocialInfo.propTypes = {
  provider: PropTypes.oneOf(["google", "github"]).isRequired,
  onContinue: PropTypes.func.isRequired,
  onBack: PropTypes.func.isRequired,
};

export { Actions as KiroFormActions };
