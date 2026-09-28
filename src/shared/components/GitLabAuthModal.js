"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import Button from "./Button";
import Callout from "./Callout";
import Input from "./Input";
import OAuthModal from "./OAuthModal";

const GITLAB_COM = "https://gitlab.com";

function getRedirectUri() {
  if (typeof window === "undefined") return "http://localhost/callback";
  const port = window.location.port || (window.location.protocol === "https:" ? "443" : "80");
  return `http://localhost:${port}/callback`;
}

/**
 * GitLab Duo auth: OAuth app (PKCE, hands off to OAuthModal with the app
 * credentials) or a Personal Access Token.
 */
export default function GitLabAuthModal({ isOpen, providerInfo, onSuccess, onClose }) {
  const [mode, setMode] = useState(null); // null | "oauth" | "pat"
  const [baseUrl, setBaseUrl] = useState(GITLAB_COM);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [pat, setPat] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showOAuth, setShowOAuth] = useState(false);
  const [oauthMeta, setOauthMeta] = useState(null);

  const reset = () => {
    setMode(null);
    setBaseUrl(GITLAB_COM);
    setClientId("");
    setClientSecret("");
    setPat("");
    setError(null);
    setLoading(false);
    setShowOAuth(false);
    setOauthMeta(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleOAuthStart = () => {
    if (!clientId.trim()) {
      setError("Client ID is required");
      return;
    }
    setError(null);
    setOauthMeta({
      baseUrl: baseUrl.trim() || GITLAB_COM,
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
    });
    setShowOAuth(true);
  };

  const handlePATSubmit = async () => {
    if (!pat.trim()) {
      setError("Personal Access Token is required");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/oauth/gitlab/pat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: pat.trim(), baseUrl: baseUrl.trim() || GITLAB_COM }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Authentication failed");
      onSuccess?.();
      handleClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  // Sub-modal for OAuth PKCE flow
  if (showOAuth && oauthMeta) {
    return (
      <OAuthModal
        isOpen
        provider="gitlab"
        providerInfo={providerInfo}
        oauthMeta={oauthMeta}
        onSuccess={() => {
          onSuccess?.();
          handleClose();
        }}
        onClose={() => {
          setShowOAuth(false);
          setOauthMeta(null);
        }}
      />
    );
  }

  const modeCard =
    "flex flex-col items-center gap-2 rounded-xl border border-line p-4 text-start transition-colors hover:border-coral hover:bg-coral-bg focus-visible:outline-none focus-visible:shadow-focus";

  return (
    <Modal isOpen={isOpen} title="Connect GitLab Duo" onClose={handleClose} size="lg">
      <div className="flex flex-col gap-4">
        {!mode && (
          <>
            <p className="text-sm text-muted">Choose how to authenticate with GitLab Duo:</p>
            <div className="grid grid-cols-2 gap-3">
              <button type="button" onClick={() => setMode("oauth")} className={modeCard}>
                <span className="material-symbols-outlined text-2xl text-coral" aria-hidden="true">
                  lock_open
                </span>
                <span>
                  <span className="block text-sm font-medium">OAuth App</span>
                  <span className="block text-xs text-muted">Use a GitLab OAuth application</span>
                </span>
              </button>
              <button type="button" onClick={() => setMode("pat")} className={modeCard}>
                <span className="material-symbols-outlined text-2xl text-coral" aria-hidden="true">
                  key
                </span>
                <span>
                  <span className="block text-sm font-medium">Personal Access Token</span>
                  <span className="block text-xs text-muted">Use a GitLab PAT with api scope</span>
                </span>
              </button>
            </div>
          </>
        )}

        {mode === "oauth" && (
          <>
            <p className="text-xs text-muted">
              Create an OAuth app at{" "}
              <a
                href={`${baseUrl.trim() || GITLAB_COM}/-/profile/applications`}
                target="_blank"
                rel="noreferrer"
                className="text-coral underline"
              >
                GitLab Applications
              </a>{" "}
              with redirect URI{" "}
              <code className="rounded bg-raised px-1 text-xs">{getRedirectUri()}</code>
            </p>
            <Input
              label="GitLab Base URL"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={GITLAB_COM}
            />
            <Input
              label="Client ID"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="Your OAuth application client ID"
            />
            <Input
              label="Client Secret (optional for PKCE)"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder="Leave empty for public PKCE app"
            />
            {error && <Callout variant="err">{error}</Callout>}
            <div className="flex gap-2">
              <Button onClick={handleOAuthStart} fullWidth disabled={!clientId.trim()}>
                Authorize
              </Button>
              <Button
                onClick={() => {
                  setMode(null);
                  setError(null);
                }}
                variant="ghost"
                fullWidth
              >
                Back
              </Button>
            </div>
          </>
        )}

        {mode === "pat" && (
          <>
            <p className="text-xs text-muted">
              Create a PAT at{" "}
              <a
                href={`${baseUrl.trim() || GITLAB_COM}/-/user_settings/personal_access_tokens`}
                target="_blank"
                rel="noreferrer"
                className="text-coral underline"
              >
                GitLab Access Tokens
              </a>{" "}
              with scopes: <code className="rounded bg-raised px-1 text-xs">api</code>,{" "}
              <code className="rounded bg-raised px-1 text-xs">read_user</code>, and{" "}
              <code className="rounded bg-raised px-1 text-xs">ai_features</code>.
            </p>
            <Input
              label="GitLab Base URL"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={GITLAB_COM}
            />
            <Input
              label="Personal Access Token"
              type="password"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
              placeholder="glpat-xxxxxxxxxxxxxxxxxxxx"
            />
            {error && <Callout variant="err">{error}</Callout>}
            <div className="flex gap-2">
              <Button
                onClick={handlePATSubmit}
                fullWidth
                disabled={!pat.trim() || loading}
                loading={loading}
              >
                Connect
              </Button>
              <Button
                onClick={() => {
                  setMode(null);
                  setError(null);
                }}
                variant="ghost"
                fullWidth
              >
                Back
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

GitLabAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  providerInfo: PropTypes.shape({ name: PropTypes.string }),
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
