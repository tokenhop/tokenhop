"use client";

import PropTypes from "prop-types";
import { useEffect, useRef, useState } from "react";
import SectionCard from "@/shared/components/SectionCard";
import SettingRow from "@/shared/components/SettingRow";
import SegmentedControl from "@/shared/components/SegmentedControl";
import Callout from "@/shared/components/Callout";
import { saveSettings } from "./sso/ssoApi";
import OidcForm from "./sso/OidcForm";
import SamlForm from "./sso/SamlForm";

const AUTH_MODE_OPTIONS = [
  { value: "password", label: "Password only" },
  { value: "sso", label: "SSO only" },
  { value: "both", label: "Both" },
];

const SSO_TYPE_OPTIONS = [
  { value: "oidc", label: "OIDC" },
  { value: "saml", label: "SAML 2.0" },
];

/** Legacy `saml`/`oidc` auth modes behave as SSO-only. */
function normalizeAuthMode(mode) {
  if (mode === "saml" || mode === "oidc") return "sso";
  if (mode === "both" || mode === "sso") return mode;
  return "password";
}

function protocolLabel(ssoType) {
  return ssoType === "saml" ? "SAML 2.0" : "OIDC";
}

/**
 * Single sign-on section. Auth mode and protocol save immediately; the
 * protocol form (OIDC or SAML) owns its own fields, test, and guides.
 */
export default function SsoSection({ settings, onSettingsChange }) {
  const [authMode, setAuthMode] = useState(normalizeAuthMode(settings.authMode));
  const [ssoType, setSsoType] = useState(settings.ssoType === "saml" ? "saml" : "oidc");
  const [modeError, setModeError] = useState("");
  const modeSeq = useRef(0);

  // Adopt async server values once GET completes (initial settings are stubs).
  useEffect(() => {
    setAuthMode(normalizeAuthMode(settings.authMode));
    setSsoType(settings.ssoType === "saml" ? "saml" : "oidc");
  }, [settings.authMode, settings.ssoType]);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const redirectUri = `${origin}/api/auth/oidc/callback`;
  const acsUrl = `${origin}/api/auth/saml/acs`;
  const metadataUrl = `${origin}/api/auth/saml/metadata`;

  const patchMode = async (key, value, revert) => {
    const token = ++modeSeq.current;
    setModeError("");
    try {
      const saved = await saveSettings({ [key]: value });
      // Ignore stale responses: only the latest click wins.
      if (modeSeq.current !== token) return;
      onSettingsChange?.(saved);
    } catch (err) {
      if (modeSeq.current !== token) return;
      revert();
      setModeError(err.message || "Failed to save sign-in method");
    }
  };

  const handleAuthMode = (next) => {
    const previous = authMode;
    setAuthMode(next);
    patchMode("authMode", next, () => setAuthMode(previous));
  };

  const handleSsoType = (next) => {
    const previous = ssoType;
    setSsoType(next);
    patchMode("ssoType", next, () => setSsoType(previous));
  };

  const storedMode = settings.authMode;
  const ssoOnly = storedMode === "sso" || storedMode === "saml" || storedMode === "oidc";

  return (
    <div id="sso" className="scroll-mt-24 space-y-4">
      <SectionCard
        icon="lock_open"
        title="Single sign-on"
        subtitle="Sign in with your identity provider."
      />
      <div className="divide-y divide-line rounded-2xl border border-line bg-panel p-5 shadow-card">
        <SettingRow
          label="Sign-in method"
          description="Password only, SSO only, or both."
          settingKey="authMode"
          control={
            <SegmentedControl
              options={AUTH_MODE_OPTIONS}
              value={authMode}
              onChange={handleAuthMode}
              aria-label="Sign-in method"
            />
          }
        />
        <SettingRow
          label="Protocol"
          description="OIDC or SAML 2.0."
          settingKey="ssoType"
          control={
            <SegmentedControl
              options={SSO_TYPE_OPTIONS}
              value={ssoType}
              onChange={handleSsoType}
              aria-label="SSO protocol"
            />
          }
        />
        {modeError && (
          <p className="py-2 text-xs text-err" role="alert">
            {modeError}
          </p>
        )}
        <div className="py-4">
          {ssoType === "saml" ? (
            <SamlForm
              key={`saml:${settings.samlEntryPoint ?? ""}:${settings.samlIssuer ?? ""}:${settings.samlCert ?? ""}`}
              settings={settings}
              authMode={authMode}
              acsUrl={acsUrl}
              metadataUrl={metadataUrl}
              onSaved={(saved) => onSettingsChange?.(saved)}
            />
          ) : (
            <OidcForm
              key={`oidc:${settings.oidcIssuerUrl ?? ""}:${settings.oidcClientId ?? ""}:${settings.oidcConfigured ?? ""}`}
              settings={settings}
              authMode={authMode}
              redirectUri={redirectUri}
              onSaved={(saved) => onSettingsChange?.(saved)}
            />
          )}
        </div>
        {ssoOnly && (
          <Callout
            variant="warn"
            title={`SSO login (${protocolLabel(settings.ssoType)}) is currently active.`}
          >
            Password login is disabled until you switch back.
          </Callout>
        )}
        {storedMode === "both" && (
          <Callout
            variant="warn"
            title={`Password and SSO login (${protocolLabel(settings.ssoType)}) are both active.`}
          />
        )}
      </div>
    </div>
  );
}

SsoSection.propTypes = {
  settings: PropTypes.object.isRequired,
  onSettingsChange: PropTypes.func,
};
