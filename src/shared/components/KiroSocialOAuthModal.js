"use client";

import { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import Button from "./Button";
import CopyField from "./CopyField";
import Input from "./Input";
import { Spinner } from "./Loading";
import OAuthResultStep from "./oauth/OAuthResultStep";
import { parseSocialCallback } from "./oauth/authFlowHelpers";

/**
 * Kiro social OAuth (Google/GitHub): opens the authorize URL once, then
 * exchanges a pasted kiro:// or localhost callback for tokens.
 */
export default function KiroSocialOAuthModal({ isOpen, provider, onSuccess, onClose }) {
  const [step, setStep] = useState("loading"); // loading | input | success | error
  const [authUrl, setAuthUrl] = useState("");
  const [authData, setAuthData] = useState(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [error, setError] = useState(null);
  const openedRef = useRef(false);

  // Reset the once-per-session auto-open so the next session opens again.
  useEffect(() => {
    if (!isOpen) openedRef.current = false;
  }, [isOpen]);

  // Initialize auth flow
  useEffect(() => {
    if (!isOpen || !provider) return;

    const initAuth = async () => {
      try {
        setError(null);
        setStep("loading");
        const res = await fetch(`/api/oauth/kiro/social-authorize?provider=${provider}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setAuthData(data);
        setAuthUrl(data.authUrl);
        setStep("input");
        if (!openedRef.current) {
          openedRef.current = true;
          window.open(data.authUrl, "_blank");
        }
      } catch (err) {
        setError(err.message);
        setStep("error");
      }
    };

    initAuth();
  }, [isOpen, provider]);

  const handleManualSubmit = async () => {
    try {
      setError(null);
      const parsed = parseSocialCallback(callbackUrl);
      if (parsed.kind === "error") throw new Error(parsed.message);
      const res = await fetch("/api/oauth/kiro/social-exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: parsed.code, codeVerifier: authData.codeVerifier, provider }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setStep("success");
      onSuccess?.();
    } catch (err) {
      setError(err.message);
      setStep("error");
    }
  };

  const providerName = provider === "google" ? "Google" : "GitHub";

  return (
    <Modal isOpen={isOpen} title={`Connect Kiro via ${providerName}`} onClose={onClose} size="lg">
      <div className="flex flex-col gap-4">
        {step === "loading" && (
          <div className="py-6 text-center">
            <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-coral-bg">
              <Spinner size="lg" />
            </div>
            <h3 className="mb-2 text-lg font-semibold">Initializing...</h3>
            <p className="text-sm text-muted">Setting up {providerName} authentication</p>
          </div>
        )}

        {step === "input" && (
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm font-medium">Step 1: Open this URL in your browser</p>
              <CopyField value={authUrl} label="Copy authorization URL" />
            </div>
            <Input
              label="Step 2: Paste the callback URL here"
              hint="After authorization, copy the full URL from your browser address bar."
              value={callbackUrl}
              onChange={(e) => setCallbackUrl(e.target.value)}
              placeholder="kiro://kiro.kiroAgent/authenticate-success?code=..."
              inputClassName="font-mono text-xs"
            />
            <div className="flex gap-2">
              <Button onClick={handleManualSubmit} fullWidth disabled={!callbackUrl}>
                Connect
              </Button>
              <Button onClick={onClose} variant="ghost" fullWidth>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {step === "success" && (
          <OAuthResultStep
            status="success"
            successMessage={`Your Kiro account via ${providerName} has been connected.`}
            onClose={onClose}
          />
        )}

        {step === "error" && (
          <OAuthResultStep
            status="error"
            error={error}
            onRetry={() => setStep("input")}
            onClose={onClose}
          />
        )}
      </div>
    </Modal>
  );
}

KiroSocialOAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  provider: PropTypes.oneOf(["google", "github"]).isRequired,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
