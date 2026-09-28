"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import KiroMethodList from "./kiro/KiroMethodList";
import { KiroIdcForm, KiroApiKeyForm, KiroSocialInfo } from "./kiro/KiroSetupForms";
import { KiroTokenImport, KiroCliProxyImport } from "./kiro/KiroImportForms";

/**
 * Kiro auth method selection: Builder ID device flow, IDC device flow,
 * API key, Google/GitHub social, refresh-token import, CLIProxyAPI import.
 */
export default function KiroAuthModal({ isOpen, onMethodSelect, onClose }) {
  const [selectedMethod, setSelectedMethod] = useState(null);
  const [idcStartUrl, setIdcStartUrl] = useState("");
  const [idcRegion, setIdcRegion] = useState("us-east-1");
  const [refreshToken, setRefreshToken] = useState("");
  const [cliProxyJson, setCliProxyJson] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyRegion, setApiKeyRegion] = useState("us-east-1");
  const [error, setError] = useState(null);
  const [importing, setImporting] = useState(false);
  const [autoDetecting, setAutoDetecting] = useState(false);
  const [autoDetected, setAutoDetected] = useState(false);
  const [idcCredentials, setIdcCredentials] = useState(null);

  // Auto-detect token when import method is selected
  useEffect(() => {
    if (selectedMethod !== "import" || !isOpen) return;

    const autoDetect = async () => {
      setAutoDetecting(true);
      setError(null);
      setAutoDetected(false);
      setIdcCredentials(null);

      try {
        const res = await fetch("/api/oauth/kiro/auto-import");
        const data = await res.json();

        if (data.found) {
          setRefreshToken(data.refreshToken);
          setAutoDetected(true);
          if (data.clientId && data.clientSecret) {
            setIdcCredentials({
              clientId: data.clientId,
              clientSecret: data.clientSecret,
              region: data.region,
              authMethod: data.authMethod,
              profileArn: data.profileArn,
            });
          }
        } else {
          setError(data.error || "Could not auto-detect token");
        }
      } catch {
        setError("Failed to auto-detect token");
      } finally {
        setAutoDetecting(false);
      }
    };

    autoDetect();
  }, [selectedMethod, isOpen]);

  const handleMethodSelect = (method) => {
    setSelectedMethod(method);
    setError(null);
  };

  const handleBack = () => {
    setSelectedMethod(null);
    setError(null);
  };

  const handleImportToken = async () => {
    if (!refreshToken.trim()) {
      setError("Please enter a refresh token");
      return;
    }
    setImporting(true);
    setError(null);
    try {
      const res = await fetch("/api/oauth/kiro/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: refreshToken.trim(), ...(idcCredentials || {}) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      onMethodSelect("import");
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  const handleImportCliProxyJson = async () => {
    if (!cliProxyJson.trim()) {
      setError("Please paste CLIProxyAPI auth JSON");
      return;
    }
    setImporting(true);
    setError(null);
    try {
      const res = await fetch("/api/oauth/kiro/import-cli-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ json: cliProxyJson.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "CLIProxyAPI import failed");
      onMethodSelect("import-cli-proxy");
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  const handleIdcContinue = () => {
    if (!idcStartUrl.trim()) {
      setError("Please enter your IDC start URL");
      return;
    }
    onMethodSelect("idc", { startUrl: idcStartUrl.trim(), region: idcRegion });
  };

  const handleApiKeyImport = async () => {
    if (!apiKey.trim()) {
      setError("Please enter an API key");
      return;
    }
    setImporting(true);
    setError(null);
    try {
      const res = await fetch("/api/oauth/kiro/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim(), region: apiKeyRegion.trim() || "us-east-1" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      onMethodSelect("api-key");
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  const handleSocialLogin = (provider) => {
    onMethodSelect("social", { provider });
  };

  return (
    <Modal isOpen={isOpen} title="Connect Kiro" onClose={onClose} size="lg">
      <div className="flex flex-col gap-4">
        {!selectedMethod && (
          <KiroMethodList
            onQuickSelect={(method) => onMethodSelect(method)}
            onFormSelect={handleMethodSelect}
          />
        )}

        {selectedMethod === "idc" && (
          <KiroIdcForm
            startUrl={idcStartUrl}
            onStartUrl={setIdcStartUrl}
            region={idcRegion}
            onRegion={setIdcRegion}
            error={error}
            onContinue={handleIdcContinue}
            onBack={handleBack}
          />
        )}

        {selectedMethod === "api-key" && (
          <KiroApiKeyForm
            apiKey={apiKey}
            onApiKey={setApiKey}
            region={apiKeyRegion}
            onRegion={setApiKeyRegion}
            error={error}
            importing={importing}
            onSubmit={handleApiKeyImport}
            onBack={handleBack}
          />
        )}

        {selectedMethod === "social-google" && (
          <KiroSocialInfo
            provider="google"
            onContinue={() => handleSocialLogin("google")}
            onBack={handleBack}
          />
        )}

        {selectedMethod === "social-github" && (
          <KiroSocialInfo
            provider="github"
            onContinue={() => handleSocialLogin("github")}
            onBack={handleBack}
          />
        )}

        {selectedMethod === "import" && (
          <KiroTokenImport
            autoDetecting={autoDetecting}
            autoDetected={autoDetected}
            refreshToken={refreshToken}
            onRefreshToken={setRefreshToken}
            error={error}
            importing={importing}
            onSubmit={handleImportToken}
            onBack={handleBack}
          />
        )}

        {selectedMethod === "import-cli-proxy" && (
          <KiroCliProxyImport
            json={cliProxyJson}
            onJson={setCliProxyJson}
            error={error}
            importing={importing}
            onSubmit={handleImportCliProxyJson}
            onBack={handleBack}
          />
        )}
      </div>
    </Modal>
  );
}

KiroAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onMethodSelect: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
