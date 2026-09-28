"use client";

import PropTypes from "prop-types";
import IconButton from "../IconButton";
import CopyField from "../CopyField";
import CopyStatus from "../CopyStatus";
import { Spinner } from "../Loading";

/** Device-code step: login URL, user code, and the poll progress line. */
export default function OAuthDeviceStep({ deviceData, copied, error, copy, polling }) {
  const loginUrl = deviceData?.verification_uri_complete || deviceData?.verification_uri || "";
  const open = () => window.open(loginUrl, "_blank", "noopener,noreferrer");

  return (
    <>
      <div className="space-y-4 py-2 text-center">
        <p className="text-sm text-muted">Visit the login URL below and authorize:</p>
        <div className="rounded-xl bg-raised p-4 text-start">
          <p className="mb-2 text-xs text-muted">Login URL</p>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <CopyField value={loginUrl} label="Copy login URL" />
            </div>
            <IconButton
              icon="open_in_new"
              label="Open login URL"
              onClick={open}
              disabled={!loginUrl}
            />
          </div>
        </div>
        {deviceData?.user_code && (
          <div className="rounded-xl bg-coral-bg p-4">
            <p className="mb-1 text-xs text-muted">Your Code</p>
            <div className="flex items-center justify-center gap-2">
              <p className="font-mono text-2xl font-bold text-coral-ink">{deviceData.user_code}</p>
              <IconButton
                icon={
                  copied === "user_code"
                    ? "check"
                    : error === "user_code"
                      ? "error"
                      : "content_copy"
                }
                label="Copy code"
                onClick={() => copy(deviceData.user_code, "user_code")}
              />
              <CopyStatus copied={copied} error={error} id="user_code" />
            </div>
          </div>
        )}
      </div>
      {polling && (
        <div role="status" className="flex items-center justify-center gap-2 text-sm text-muted">
          <Spinner size="sm" />
          Waiting for authorization...
        </div>
      )}
    </>
  );
}

OAuthDeviceStep.propTypes = {
  deviceData: PropTypes.shape({
    verification_uri: PropTypes.string,
    verification_uri_complete: PropTypes.string,
    user_code: PropTypes.string,
  }),
  copied: PropTypes.string,
  error: PropTypes.string,
  copy: PropTypes.func.isRequired,
  polling: PropTypes.bool.isRequired,
};
