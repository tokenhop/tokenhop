"use client";

import PropTypes from "prop-types";
import { useState } from "react";
import Button from "@/shared/components/Button";
import Modal from "@/shared/components/Modal";
import Callout from "@/shared/components/Callout";
import {
  PASSPHRASE_HEADER,
  downloadJson,
  backupFileName,
  apiError,
  passphraseProblem,
} from "./backupShared";
import AuthFields, { blankAuth } from "./BackupAuthFields";

/** GET /api/settings/database behind reauth; passphrase goes in a header. */
async function exportInstance({ password, passphrase }) {
  const headers = { "x-9r-password": password };
  if (passphrase) headers[PASSPHRASE_HEADER] = passphrase;
  const res = await fetch("/api/settings/database", { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw apiError(res, data, "Failed to export database");
  return data;
}

/** Instance download dialog: password gate, then a save. */
export default function InstanceDialog({ onClose, busy, setBusy, flash }) {
  const [auth, setAuth] = useState(blankAuth);
  const [error, setError] = useState("");

  const problem = passphraseProblem(auth.passphrase, auth.confirm, { headerSafe: true });
  const ready = Boolean(auth.password) && !problem;

  const run = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      const payload = await exportInstance(auth);
      downloadJson(payload, backupFileName());
      flash("ok", "Instance backup downloaded. Keep the file private.");
      onClose();
    } catch (err) {
      setError(err.message || "Failed to export database");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Download instance backup"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={run} loading={busy} disabled={!ready}>
            Download
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Callout variant="warn" title="Full-instance backup">
          Holds user identities and provider secrets. Keep the file private. Only an owner or admin
          can create one.
        </Callout>
        {error && <Callout variant="err" title={error} />}
        {problem && (
          <p className="text-[13px] text-err" role="alert">
            {problem}
          </p>
        )}
        <AuthFields auth={auth} setAuth={setAuth} mode="export" />
      </div>
    </Modal>
  );
}

InstanceDialog.propTypes = {
  onClose: PropTypes.func.isRequired,
  busy: PropTypes.bool,
  setBusy: PropTypes.func.isRequired,
  flash: PropTypes.func.isRequired,
};
