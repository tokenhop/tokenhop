"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import Button from "./Button";
import Callout from "./Callout";
import Textarea from "./Textarea";

/** iFlow cookie auth: paste a platform.iflow.cn browser cookie to mint a fresh API key. */
export default function IFlowCookieModal({ isOpen, onSuccess, onClose }) {
  const [cookie, setCookie] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const handleClose = () => {
    setCookie("");
    setError(null);
    setSuccess(false);
    onClose?.();
  };

  const handleSubmit = async () => {
    if (!cookie.trim()) {
      setError("Please paste your cookie");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/oauth/iflow/cookie", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookie: cookie.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Authentication failed");
      setSuccess(true);
      setTimeout(() => {
        onSuccess?.();
        handleClose();
      }, 1500);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="iFlow Cookie Authentication">
      <div className="space-y-4">
        {success ? (
          <div role="status" className="py-8 text-center">
            <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-ok-bg">
              <span className="material-symbols-outlined text-3xl text-ok" aria-hidden="true">
                check_circle
              </span>
            </div>
            <p className="text-lg font-medium text-text">Authentication Successful!</p>
            <p className="mt-2 text-sm text-muted">Fresh API key obtained</p>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <p className="text-sm text-muted">
                To get a fresh API key, paste your browser cookie from{" "}
                <a
                  href="https://platform.iflow.cn"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-coral hover:underline"
                >
                  platform.iflow.cn
                </a>
              </p>
              <div className="space-y-2 rounded-xl bg-raised p-3 text-xs">
                <p className="font-medium text-text">How to get cookie:</p>
                <ol className="list-inside list-decimal space-y-1 text-muted">
                  <li>Open platform.iflow.cn in your browser</li>
                  <li>Login to your account</li>
                  <li>Open DevTools (F12) → Application/Storage → Cookies</li>
                  <li>Copy the entire cookie string (must include BXAuth)</li>
                  <li>Paste it below</li>
                </ol>
              </div>
            </div>

            <Textarea
              label="Cookie String"
              rows={4}
              value={cookie}
              onChange={(e) => setCookie(e.target.value)}
              placeholder="BXAuth=xxx; ..."
              disabled={loading}
              textareaClassName="resize-none"
            />

            {error && <Callout variant="err">{error}</Callout>}

            <div className="flex gap-3 pt-2">
              <Button variant="secondary" onClick={handleClose} disabled={loading} fullWidth>
                Cancel
              </Button>
              <Button onClick={handleSubmit} loading={loading} fullWidth>
                Authenticate
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

IFlowCookieModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func,
};
