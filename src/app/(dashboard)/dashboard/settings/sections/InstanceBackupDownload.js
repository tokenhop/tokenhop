"use client";

import PropTypes from "prop-types";
import { useState } from "react";
import Button from "@/shared/components/Button";
import Modal from "@/shared/components/Modal";
import Callout from "@/shared/components/Callout";
import {
  PASSPHRASE_HEADER,
  SSO_PROOF_HEADER,
  downloadJson,
  backupFileName,
  apiError,
  passphraseProblem,
  hasProof,
  reauthErrorText,
} from "./backupShared";
import AuthFields, { authWithProof, spendProof } from "./BackupAuthFields";

/**
 * GET /api/settings/database behind reauth: the one-time single sign-on proof
 * OR the password (never both); the passphrase goes in a header too.
 */
async function exportInstance({ password, passphrase, ssoProof }) {
  const headers = ssoProof ? { [SSO_PROOF_HEADER]: ssoProof } : { "x-9r-password": password };
  if (passphrase) headers[PASSPHRASE_HEADER] = passphrase;
  const res = await fetch("/api/settings/database", { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw apiError(res, data, "Failed to export database");
  return data;
}

/**
 * Instance download dialog: password or single sign-on gate, then a save.
 * `ssoProof` arrives after the provider round trip; `ssoOnly` reopens it
 * after a failed round trip (no password fallback).
 */
export default function InstanceDialog({
  onClose,
  busy,
  setBusy,
  flash,
  providers = [],
  ssoProof = null,
  ssoOnly = false,
  initialError = "",
}) {
  const [auth, setAuth] = useState(() => ({
    ...authWithProof(ssoProof),
    ssoOnly: ssoOnly || Boolean(ssoProof),
  }));
  const [error, setError] = useState(initialError);

  const problem = passphraseProblem(auth.passphrase, auth.confirm, { headerSafe: true });
  const ready = hasProof(auth) && !problem;

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
      setError(reauthErrorText(err, Boolean(auth.ssoProof), "Failed to export database"));
      // A proof is single-use: any failed attempt that sent one needs a fresh check.
      if (auth.ssoProof) setAuth(spendProof);
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
        <AuthFields
          auth={auth}
          setAuth={setAuth}
          mode="export"
          sso={{ providers, action: "instance.export" }}
          disabled={busy}
        />
      </div>
    </Modal>
  );
}

InstanceDialog.propTypes = {
  onClose: PropTypes.func.isRequired,
  busy: PropTypes.bool,
  setBusy: PropTypes.func.isRequired,
  flash: PropTypes.func.isRequired,
  providers: PropTypes.arrayOf(PropTypes.string),
  ssoProof: PropTypes.string,
  ssoOnly: PropTypes.bool,
  initialError: PropTypes.string,
};
