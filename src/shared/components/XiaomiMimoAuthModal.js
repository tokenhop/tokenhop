"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import Button from "./Button";
import Callout from "./Callout";
import { Spinner } from "./Loading";

function BusyHero({ title, children }) {
  return (
    <div className="py-6 text-center">
      <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-coral-bg">
        <Spinner size="lg" />
      </div>
      <h3 className="mb-2 text-lg font-semibold">{title}</h3>
      {children && <p className="text-sm text-muted">{children}</p>}
    </div>
  );
}

BusyHero.propTypes = { title: PropTypes.string.isRequired, children: PropTypes.node };

/**
 * Xiaomi MiMo: imports credentials from the local MiMo Desktop auth.json,
 * with a browser OAuth fallback. The API-key path uses the standard Add API Key modal.
 */
export default function XiaomiMimoAuthModal({ isOpen, onSuccess, onClose }) {
  const [phase, setPhase] = useState("detecting"); // detecting | found | not-found | importing
  const [detectResult, setDetectResult] = useState(null);
  const [error, setError] = useState(null);
  const [oauthUrl, setOauthUrl] = useState(null);
  const [oauthState, setOauthState] = useState(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    (async () => {
      setPhase("detecting");
      setError(null);
      setDetectResult(null);
      setOauthUrl(null);
      try {
        const res = await fetch("/api/oauth/xiaomi-mimo/auto-import");
        const data = await res.json();
        if (cancelled) return;
        if (data.found && data.apiKey) {
          setDetectResult(data);
          setPhase("found");
        } else {
          setPhase("not-found");
          setError(data.error || "Xiaomi MiMo Desktop credentials not found on this machine.");
        }
      } catch {
        if (!cancelled) {
          setPhase("not-found");
          setError("Failed to read local Xiaomi MiMo Desktop credentials.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const handleRetryDetect = () => {
    setPhase("detecting");
    fetch("/api/oauth/xiaomi-mimo/auto-import")
      .then((r) => r.json())
      .then((data) => {
        if (data.found && data.apiKey) {
          setDetectResult(data);
          setPhase("found");
        } else {
          setPhase("not-found");
          setError(data.error || "Still not found.");
        }
      })
      .catch(() => setPhase("not-found"));
  };

  const handleImport = async () => {
    if (!detectResult?.apiKey) return;
    setPhase("importing");
    setError(null);
    try {
      const res = await fetch("/api/oauth/xiaomi-mimo/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: detectResult.apiKey,
          uid: detectResult.uid,
          baseUrl: detectResult.baseUrl,
          mimoPassToken: detectResult.mimoPassToken || null,
          mimoUserId: detectResult.mimoUserId || null,
          mimoCUserId: detectResult.mimoCUserId || null,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Import failed");
      onSuccess?.(data.connection);
      onClose();
    } catch (err) {
      setPhase("found");
      setError(err.message);
    }
  };

  const handleStartOAuth = async () => {
    setError(null);
    try {
      const state = crypto.randomUUID();
      const res = await fetch(`/api/oauth/xiaomi-mimo/authorize?state=${state}`);
      const data = await res.json();
      if (!data.authorizeUrl) throw new Error(data.error || "Failed to start OAuth");
      setOauthUrl(data.authorizeUrl);
      setOauthState(data.state);
      window.open(data.authorizeUrl, "_blank", "width=600,height=700");
    } catch (err) {
      setError(err.message);
    }
  };

  const handlePollOAuth = async () => {
    if (!oauthState) return;
    setError(null);
    try {
      const res = await fetch(`/api/oauth/xiaomi-mimo/poll-status?state=${oauthState}`);
      const data = await res.json();
      if (data.status === "done" && data.result) {
        const exRes = await fetch("/api/oauth/xiaomi-mimo/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: oauthState }),
        });
        const exData = await exRes.json();
        if (!exData.success) throw new Error(exData.error || "Exchange failed");
        onSuccess?.(exData.connection);
        onClose();
      } else if (data.status === "error") {
        throw new Error(data.error || "OAuth failed");
      } else {
        setError("Authorization not completed yet. Finish in the browser, then click Check Again.");
      }
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Modal isOpen={isOpen} title="Connect Xiaomi MiMo" onClose={onClose}>
      <div className="flex flex-col gap-4">
        {phase === "detecting" && (
          <BusyHero title="Reading local credentials...">
            Checking ~/.local/share/mimocode/auth.json
          </BusyHero>
        )}

        {phase === "found" && detectResult && (
          <>
            <Callout variant="ok" title="Xiaomi MiMo Desktop credentials found!">
              UID: {detectResult.uid || "—"} · Source: {detectResult.source?.split(/[\\/]/).pop()}
            </Callout>
            {error && <Callout variant="err">{error}</Callout>}
            <div className="flex gap-2">
              <Button onClick={handleImport} fullWidth>
                Connect with Local Credentials
              </Button>
              <Button onClick={onClose} variant="ghost" fullWidth>
                Cancel
              </Button>
            </div>
          </>
        )}

        {phase === "importing" && <BusyHero title="Connecting..." />}

        {phase === "not-found" && (
          <>
            <Callout variant="warn" icon="info" title="Local credentials not found">
              <p>{error}</p>
              <p className="mt-2">
                Make sure Xiaomi MiMo Desktop is installed and you are signed in, then retry. Or
                sign in via browser below.
              </p>
            </Callout>

            {!oauthUrl ? (
              <div className="flex gap-2">
                <Button onClick={handleRetryDetect} variant="outline" fullWidth>
                  Retry Local Detect
                </Button>
                <Button onClick={handleStartOAuth} fullWidth>
                  Sign in via Browser
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <Callout variant="info">
                  Browser opened. Complete the Xiaomi sign-in, then click Check Again.
                </Callout>
                <div className="flex gap-2">
                  <Button onClick={handlePollOAuth} fullWidth>
                    Check Again
                  </Button>
                  <Button onClick={onClose} variant="ghost" fullWidth>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

XiaomiMimoAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
