"use client";

import PropTypes from "prop-types";
import Button from "../Button";

/** Shared success/error heroes for OAuth-family modals. */
export default function OAuthResultStep({
  status,
  providerName,
  successMessage,
  error,
  onRetry,
  onClose,
}) {
  if (status === "success") {
    return (
      <div className="py-6 text-center">
        <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-ok-bg">
          <span className="material-symbols-outlined text-3xl text-ok" aria-hidden="true">
            check_circle
          </span>
        </div>
        <h3 className="mb-2 text-lg font-semibold">Connected Successfully!</h3>
        <p className="mb-4 text-sm text-muted">
          {successMessage || `Your ${providerName} account has been connected.`}
        </p>
        <Button onClick={onClose} fullWidth>
          Done
        </Button>
      </div>
    );
  }
  return (
    <div className="py-6 text-center">
      <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-err-bg">
        <span className="material-symbols-outlined text-3xl text-err" aria-hidden="true">
          error
        </span>
      </div>
      <h3 className="mb-2 text-lg font-semibold">Connection Failed</h3>
      <p className="mb-4 text-sm text-err">{error}</p>
      <div className="flex gap-2">
        <Button onClick={onRetry} variant="secondary" fullWidth>
          Try Again
        </Button>
        <Button onClick={onClose} variant="ghost" fullWidth>
          Cancel
        </Button>
      </div>
    </div>
  );
}

OAuthResultStep.propTypes = {
  status: PropTypes.oneOf(["success", "error"]).isRequired,
  providerName: PropTypes.string,
  /** Overrides the default success sentence. */
  successMessage: PropTypes.string,
  error: PropTypes.string,
  onRetry: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
