"use client";

import PropTypes from "prop-types";
import { useRef, useState } from "react";
import Input from "@/shared/components/Input";
import Textarea from "@/shared/components/Textarea";
import Button from "@/shared/components/Button";
import CopyField from "@/shared/components/CopyField";
import Callout from "@/shared/components/Callout";
import SamlGuides from "./SamlGuides";
import { parseIdpMetadata, postJson, saveSettings } from "./ssoApi";

const DEFAULT_ISSUER = "urn:9router:sp";
const DEFAULT_LABEL = "Sign in with SAML SSO";

function successMessage(authMode) {
  if (authMode === "sso") return "SAML SSO login enabled";
  if (authMode === "both") return "Password and SAML SSO login enabled";
  return "SAML 2.0 settings saved";
}

/**
 * SAML 2.0 form: SSO URL, entity id, IdP cert, labels, claim attributes,
 * XML-metadata import helper, read-only ACS/metadata URLs, save and test.
 */
export default function SamlForm({ settings, authMode, acsUrl, metadataUrl, onSaved }) {
  const [form, setForm] = useState({
    samlEntryPoint: settings.samlEntryPoint || "",
    samlIssuer: settings.samlIssuer || DEFAULT_ISSUER,
    samlCert: settings.samlCert || "",
    samlLoginLabel: settings.samlLoginLabel || DEFAULT_LABEL,
    samlAttributeEmail: settings.samlAttributeEmail || "email",
    samlAttributeName: settings.samlAttributeName || "name",
  });
  const [busy, setBusy] = useState(""); // "" | "save" | "test"
  const [status, setStatus] = useState({ type: "", message: "" });
  const [showGuide, setShowGuide] = useState(false);
  const certFileRef = useRef(null);
  const metadataFileRef = useRef(null);

  const update = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const handleSave = async (e) => {
    e.preventDefault();
    setBusy("save");
    setStatus({ type: "", message: "" });
    try {
      const saved = await saveSettings({
        authMode,
        ssoType: "saml",
        samlEntryPoint: form.samlEntryPoint.trim(),
        samlIssuer: form.samlIssuer.trim() || DEFAULT_ISSUER,
        samlCert: form.samlCert.trim(),
        samlLoginLabel: form.samlLoginLabel.trim() || DEFAULT_LABEL,
        samlAttributeEmail: form.samlAttributeEmail.trim() || "email",
        samlAttributeName: form.samlAttributeName.trim() || "name",
      });
      onSaved(saved);
      setStatus({ type: "ok", message: successMessage(authMode) });
    } catch (err) {
      setStatus({ type: "err", message: err.message || "Failed to save SAML settings" });
    } finally {
      setBusy("");
    }
  };

  const handleTest = async () => {
    setBusy("test");
    setStatus({ type: "", message: "" });
    try {
      const data = await postJson("/api/auth/saml/test", {
        samlEntryPoint: form.samlEntryPoint.trim(),
        samlIssuer: form.samlIssuer.trim() || DEFAULT_ISSUER,
        samlCert: form.samlCert.trim(),
      });
      setStatus({ type: "ok", message: data.message || "SAML configuration verified!" });
    } catch (err) {
      setStatus({ type: "err", message: err.message || "SAML configuration test failed" });
    } finally {
      setBusy("");
    }
  };

  const handleMetadataUpload = (e) => {
    const file = e.target.files?.[0];
    if (metadataFileRef.current) metadataFileRef.current.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const parsed = parseIdpMetadata(event.target?.result || "");
      if (!parsed) {
        setStatus({ type: "err", message: "Unable to parse valid SAML IdP metadata" });
        return;
      }
      setForm((prev) => ({
        ...prev,
        samlEntryPoint: parsed.ssoUrl || prev.samlEntryPoint,
        samlCert: parsed.cert || prev.samlCert,
      }));
      setStatus({
        type: "ok",
        message: `IdP metadata imported (SSO URL: ${parsed.ssoUrl ? "found" : "not found"}, cert: ${parsed.cert ? "found" : "not found"}).`,
      });
    };
    reader.onerror = () => setStatus({ type: "err", message: "Error reading metadata file" });
    reader.readAsText(file);
  };

  const handleCertUpload = (e) => {
    const file = e.target.files?.[0];
    if (certFileRef.current) certFileRef.current.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      setForm((prev) => ({ ...prev, samlCert: String(event.target?.result || "").trim() }));
      setStatus({ type: "ok", message: "Certificate file loaded into configuration." });
    };
    reader.onerror = () => setStatus({ type: "err", message: "Error reading certificate file" });
    reader.readAsText(file);
  };

  const disabled = busy !== "";

  return (
    <form onSubmit={handleSave} className="flex flex-col gap-4">
      <div className="rounded-xl border border-line bg-raised p-3">
        <button
          type="button"
          onClick={() => setShowGuide((v) => !v)}
          aria-expanded={showGuide}
          className="flex w-full items-center justify-between text-start text-xs font-semibold text-text"
        >
          <span className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px] text-coral" aria-hidden="true">
              menu_book
            </span>
            IdP setup guidelines &amp; provider instructions
          </span>
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
            {showGuide ? "expand_less" : "expand_more"}
          </span>
        </button>
        {showGuide && (
          <div className="mt-3 border-t border-line pt-3">
            <SamlGuides acsUrl={acsUrl} entityId={form.samlIssuer || DEFAULT_ISSUER} />
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 rounded-xl border border-dashed border-coral/40 bg-coral-bg p-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text">1-click IdP metadata XML import</p>
          <p className="text-xs text-muted">
            Auto-fill SSO URL, Entity ID and cert from the IdP XML.
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon="upload_file"
          onClick={() => metadataFileRef.current?.click()}
          disabled={disabled}
        >
          Upload metadata XML
        </Button>
        <input
          ref={metadataFileRef}
          type="file"
          accept=".xml,application/xml,text/xml"
          onChange={handleMetadataUpload}
          className="hidden"
        />
      </div>

      <Input
        label="Single Sign-On Service URL (samlEntryPoint)"
        value={form.samlEntryPoint}
        onChange={update("samlEntryPoint")}
        placeholder="https://idp.example.com/app/saml/sso/..."
        disabled={disabled}
      />
      <Input
        label="SP Entity ID / Audience (samlIssuer)"
        value={form.samlIssuer}
        onChange={update("samlIssuer")}
        placeholder={DEFAULT_ISSUER}
        disabled={disabled}
      />
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-text">IdP X.509 Certificate (samlCert)</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon="file_upload"
            onClick={() => certFileRef.current?.click()}
            disabled={disabled}
          >
            Upload cert
          </Button>
          <input
            ref={certFileRef}
            type="file"
            accept=".crt,.pem,.cer,text/plain"
            onChange={handleCertUpload}
            className="hidden"
          />
        </div>
        <Textarea
          aria-label="IdP X.509 Certificate (samlCert)"
          value={form.samlCert}
          onChange={update("samlCert")}
          placeholder="Paste raw Base64 certificate or PEM block"
          rows={4}
          disabled={disabled}
          textareaClassName="font-mono text-xs"
        />
        <p className="text-xs text-muted">Paste raw Base64 certificate or PEM block.</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Input
          label="Login button label"
          value={form.samlLoginLabel}
          onChange={update("samlLoginLabel")}
          placeholder={DEFAULT_LABEL}
          disabled={disabled}
        />
        <Input
          label="Email claim attribute"
          value={form.samlAttributeEmail}
          onChange={update("samlAttributeEmail")}
          placeholder="email"
          disabled={disabled}
        />
        <Input
          label="Display name claim"
          value={form.samlAttributeName}
          onChange={update("samlAttributeName")}
          placeholder="name"
          disabled={disabled}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium text-text">ACS callback URL</p>
        <CopyField value={acsUrl} label="Copy ACS URL" />
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium text-text">SP XML metadata</p>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <CopyField value={metadataUrl} label="Copy metadata URL" />
          </div>
          <Button type="button" variant="secondary" icon="download" href={metadataUrl}>
            Download XML
          </Button>
        </div>
      </div>
      <div aria-live="polite">
        {status.message && (
          <Callout variant={status.type === "ok" ? "ok" : "err"} title={status.message} />
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy === "save"} disabled={disabled}>
          Save SAML settings
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

SamlForm.propTypes = {
  settings: PropTypes.object.isRequired,
  authMode: PropTypes.oneOf(["password", "sso", "both"]).isRequired,
  acsUrl: PropTypes.string.isRequired,
  metadataUrl: PropTypes.string.isRequired,
  onSaved: PropTypes.func.isRequired,
};
