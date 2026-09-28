"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import Button from "./Button";
import Callout from "./Callout";
import Input from "./Input";
import Textarea from "./Textarea";
import { Spinner } from "./Loading";
import OAuthModal from "./OAuthModal";

/**
 * Cursor connect: method chooser between browser login (PKCE device-style flow
 * via OAuthModal) and token import from a local Cursor IDE install (auto-detects
 * from its SQLite database, falls back to manual paste; Windows may need a retry).
 */
export default function CursorAuthModal({ isOpen, providerInfo, onSuccess, onClose }) {
  const [method, setMethod] = useState(null); // null | "browser" | "import"
  const [accessToken, setAccessToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [machineId, setMachineId] = useState("");
  const [error, setError] = useState(null);
  const [importing, setImporting] = useState(false);
  const [autoDetecting, setAutoDetecting] = useState(false);
  const [autoDetected, setAutoDetected] = useState(false);
  const [windowsManual, setWindowsManual] = useState(false);
  // Latest method, readable from async callbacks that captured an older render.
  const methodRef = useRef(method);
  methodRef.current = method;

  const runAutoDetect = useCallback(async () => {
    setAutoDetecting(true);
    setError(null);
    setAutoDetected(false);
    setWindowsManual(false);
    setRefreshToken("");

    try {
      const res = await fetch("/api/oauth/cursor/auto-import");
      const data = await res.json();

      if (data.found) {
        setAccessToken(data.accessToken);
        setMachineId(data.machineId);
        setRefreshToken(data.refreshToken || "");
        setAutoDetected(true);
      } else if (data.windowsManual) {
        setWindowsManual(true);
      } else {
        setError(data.error || "Could not auto-detect tokens");
      }
    } catch {
      setError("Failed to auto-detect tokens");
    } finally {
      setAutoDetecting(false);
    }
  }, []);

  // Auto-detect only after the user picks Import: the auto-import endpoint is
  // local-only, so it must not be called on remote/Docker hosts by default.
  useEffect(() => {
    if (!isOpen || method !== "import") return;
    runAutoDetect();
  }, [isOpen, method, runAutoDetect]);

  // Return to the method chooser whenever the modal closes.
  useEffect(() => {
    if (isOpen) return;
    setMethod(null);
    setError(null);
  }, [isOpen]);

  const handleClose = () => {
    setMethod(null);
    setError(null);
    onClose();
  };

  const handleBack = () => {
    setMethod(null);
    setError(null);
  };

  const handleImportToken = async () => {
    if (!accessToken.trim()) {
      setError("Please enter an access token");
      return;
    }
    if (!machineId.trim()) {
      setError("Please enter a machine ID");
      return;
    }
    setImporting(true);
    setError(null);
    try {
      const res = await fetch("/api/oauth/cursor/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessToken: accessToken.trim(),
          machineId: machineId.trim(),
          ...(refreshToken.trim() ? { refreshToken: refreshToken.trim() } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      onSuccess?.();
      handleClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  if (method === "browser") {
    return (
      <OAuthModal
        isOpen={isOpen}
        provider="cursor"
        providerInfo={providerInfo}
        onSuccess={() => {
          // Ignore a stale success from a flow the user already backed out of.
          if (methodRef.current !== "browser") return;
          setMethod(null);
          onSuccess?.();
          onClose?.();
        }}
        onClose={() => setMethod(null)}
      />
    );
  }

  if (method === null) {
    return (
      <Modal isOpen={isOpen} title="Connect Cursor" onClose={handleClose}>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">Choose how to connect your Cursor account:</p>
          <div className="flex flex-col gap-1">
            <Button onClick={() => setMethod("browser")} icon="login" size="lg" fullWidth>
              Login with browser
            </Button>
            <p className="text-xs text-muted">
              Sign in at cursor.com from any browser — works on remote and Docker hosts
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <Button
              onClick={() => setMethod("import")}
              icon="download"
              variant="secondary"
              size="lg"
              fullWidth
            >
              Import from Cursor IDE
            </Button>
            <p className="text-xs text-muted">Read the token from a local Cursor IDE install</p>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal isOpen={isOpen} title="Connect Cursor IDE" onClose={handleClose}>
      <div className="flex flex-col gap-4">
        {autoDetecting && (
          <div className="py-6 text-center">
            <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-coral-bg">
              <Spinner size="lg" />
            </div>
            <h3 className="mb-2 text-lg font-semibold">Auto-detecting tokens...</h3>
            <p className="text-sm text-muted">Reading from Cursor IDE database</p>
          </div>
        )}

        {!autoDetecting && (
          <>
            {autoDetected && (
              <Callout variant="ok">Tokens auto-detected from Cursor IDE successfully!</Callout>
            )}

            {windowsManual && (
              <Callout
                variant="warn"
                icon="info"
                title="Could not read Cursor database automatically."
              >
                Make sure Cursor IDE has been opened at least once, then click Retry. If the problem
                persists, paste your tokens manually below.
                <Button onClick={runAutoDetect} variant="outline" fullWidth className="mt-2">
                  Retry
                </Button>
              </Callout>
            )}

            {!autoDetected && !windowsManual && !error && (
              <Callout variant="info">
                Cursor IDE not detected. Please paste your tokens manually.
              </Callout>
            )}

            <Textarea
              label="Access Token"
              required
              rows={3}
              value={accessToken}
              onChange={(e) => {
                setAccessToken(e.target.value);
                // A hand-edited access token no longer pairs with the detected refresh token.
                setRefreshToken("");
              }}
              placeholder="Access token will be auto-filled..."
              textareaClassName="font-mono text-sm"
            />

            <Input
              label="Machine ID"
              required
              value={machineId}
              onChange={(e) => setMachineId(e.target.value)}
              placeholder="Machine ID will be auto-filled..."
              inputClassName="font-mono text-sm"
            />

            {error && <Callout variant="err">{error}</Callout>}

            <div className="flex gap-2">
              <Button
                onClick={handleImportToken}
                fullWidth
                disabled={importing || !accessToken.trim() || !machineId.trim()}
              >
                {importing ? "Importing..." : "Import Token"}
              </Button>
              <Button onClick={handleBack} variant="ghost" icon="arrow_back" fullWidth>
                Back
              </Button>
              <Button onClick={handleClose} variant="ghost" fullWidth>
                Cancel
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

CursorAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  providerInfo: PropTypes.object,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
