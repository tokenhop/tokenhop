"use client";

import PropTypes from "prop-types";
import { useState } from "react";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import CopyField from "@/shared/components/CopyField";
import Callout from "@/shared/components/Callout";
import { postJson, saveSettings } from "./ssoApi";

const DEFAULT_SCOPES = "openid profile email";
const DEFAULT_LABEL = "Sign in with OIDC";

function successMessage(authMode) {
  if (authMode === "sso") return "OIDC login enabled";
  if (authMode === "both") return "Password and OIDC login enabled";
  return "OIDC settings saved";
}

function testMessage(data) {
  const base = `Connection OK. Discovery loaded from ${data.issuerUrl}.`;
  if (!data.clientSecretTested) return base;
  return data.clientSecretValid === true
    ? `${base} Client secret validated too.`
    : `${base} Client secret was not checked.`;
}

/**
 * OIDC form: issuer, client id, write-only client secret, scopes, button
 * label, read-only redirect URI, save and "Test sign-in" (save, then discovery).
 */
export default function OidcForm({ settings, authMode, redirectUri, onSaved }) {
  const [form, setForm] = useState({
    oidcIssuerUrl: settings.oidcIssuerUrl || "",
    oidcClientId: settings.oidcClientId || "",
    oidcScopes: settings.oidcScopes || DEFAULT_SCOPES,
    oidcLoginLabel: settings.oidcLoginLabel || DEFAULT_LABEL,
  });
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(""); // "" | "save" | "test"
  const [status, setStatus] = useState({ type: "", message: "" });

  const update = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const payload = () => {
    const body = {
      authMode,
      ssoType: "oidc",
      oidcIssuerUrl: form.oidcIssuerUrl.trim(),
      oidcClientId: form.oidcClientId.trim(),
      oidcScopes: form.oidcScopes.trim() || DEFAULT_SCOPES,
      oidcLoginLabel: form.oidcLoginLabel.trim() || DEFAULT_LABEL,
    };
    if (secret.trim()) body.oidcClientSecret = secret.trim();
    return body;
  };

  const persist = async () => {
    const saved = await saveSettings(payload());
    setSecret("");
    onSaved(saved);
    return saved;
  };

  const handleSave = async (e) => {
    e.preventDefault();
    const body = payload();
    if (
      authMode !== "password" &&
      (!body.oidcIssuerUrl || !body.oidcClientId || !body.oidcClientSecret) &&
      !settings.oidcConfigured
    ) {
      setStatus({
        type: "err",
        message: "Issuer URL, client ID, and client secret are required to enable OIDC.",
      });
      return;
    }
    setBusy("save");
    setStatus({ type: "", message: "" });
    try {
      await persist();
      setStatus({ type: "ok", message: successMessage(authMode) });
    } catch (err) {
      setStatus({ type: "err", message: err.message || "Failed to save OIDC settings" });
    } finally {
      setBusy("");
    }
  };

  const handleTest = async () => {
    if (!form.oidcIssuerUrl.trim() || !form.oidcClientId.trim()) {
      setStatus({
        type: "err",
        message: "Issuer URL and client ID are required to test the connection.",
      });
      return;
    }
    setBusy("test");
    setStatus({ type: "", message: "" });
    try {
      let saved;
      try {
        saved = await persist();
      } catch (err) {
        throw new Error(err.message || "Failed to save OIDC settings before testing");
      }
      const data = await postJson("/api/auth/oidc/test", {
        issuerUrl: saved.oidcIssuerUrl,
        clientId: saved.oidcClientId,
        scopes: saved.oidcScopes || DEFAULT_SCOPES,
      });
      setStatus({ type: "ok", message: testMessage(data) });
    } catch (err) {
      setStatus({ type: "err", message: err.message || "OIDC connection test failed" });
    } finally {
      setBusy("");
    }
  };

  const disabled = busy !== "";

  return (
    <form onSubmit={handleSave} className="flex flex-col gap-4">
      <Input
        label="Issuer URL"
        value={form.oidcIssuerUrl}
        onChange={update("oidcIssuerUrl")}
        placeholder="https://auth.example.com/application/o/9router/"
        disabled={disabled}
      />
      <Input
        label="Client ID"
        value={form.oidcClientId}
        onChange={update("oidcClientId")}
        placeholder="9router-dashboard"
        disabled={disabled}
      />
      <Input
        label="Client secret"
        type="password"
        autoComplete="new-password"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        placeholder="Leave blank to keep existing secret"
        hint="This value is write-only after saving."
        disabled={disabled}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input
          label="Scopes"
          value={form.oidcScopes}
          onChange={update("oidcScopes")}
          placeholder={DEFAULT_SCOPES}
          disabled={disabled}
        />
        <Input
          label="Button label"
          value={form.oidcLoginLabel}
          onChange={update("oidcLoginLabel")}
          placeholder={DEFAULT_LABEL}
          disabled={disabled}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium text-text">Redirect URI · give this to your IdP</p>
        <CopyField value={redirectUri} label="Copy redirect URI" />
      </div>
      <div aria-live="polite">
        {status.message && (
          <Callout variant={status.type === "ok" ? "ok" : "err"} title={status.message} />
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy === "save"} disabled={disabled}>
          Save OIDC settings
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={handleTest}
          loading={busy === "test"}
          disabled={disabled}
        >
          Test sign-in
        </Button>
      </div>
    </form>
  );
}

OidcForm.propTypes = {
  settings: PropTypes.object.isRequired,
  authMode: PropTypes.oneOf(["password", "sso", "both"]).isRequired,
  redirectUri: PropTypes.string.isRequired,
  onSaved: PropTypes.func.isRequired,
};
