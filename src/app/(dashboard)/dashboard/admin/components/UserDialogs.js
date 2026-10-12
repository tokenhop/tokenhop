"use client";

import PropTypes from "prop-types";
import { useState } from "react";
import { Button, Callout, CopyField, Input, Select } from "@/shared/components";
import Modal from "@/shared/components/Modal";
import { setTemporaryPassword } from "@/shared/utils/adminApi";
import { suggestPassword } from "../adminView";
import { userName } from "./AdminShared";

/** Temporary-password dialog: the server never returns it again, copy it now. */
export function TempPasswordDialog({ user, onClose, onDone }) {
  const [password, setPassword] = useState(() => suggestPassword());
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await setTemporaryPassword(user.id, password);
      onDone(password);
    } catch (err) {
      setError(err?.message || "Could not set a temporary password.");
    } finally {
      setBusy(false);
    }
  };

  if (confirm) {
    return (
      <Modal isOpen onClose={onClose} title="Set temporary password">
        <p className="text-sm text-text">
          Set this password for {userName(user)}? Their current password stops working on every
          device, and they must choose a new one at next sign-in.
        </p>
        {error ? (
          <p role="alert" className="mt-3 rounded-lg bg-err-bg px-3 py-2 text-sm text-err">
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirm(false)} disabled={busy}>
            Back
          </Button>
          <Button variant="danger" onClick={save} loading={busy}>
            Set password
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal isOpen onClose={onClose} title="Set temporary password">
      <Input
        label="Temporary password"
        type="text"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <p className="mt-2 text-xs text-muted">
        At least 8 characters.{" "}
        <button
          type="button"
          onClick={() => setPassword(suggestPassword())}
          className="underline underline-offset-2 hover:text-text focus-visible:outline-none focus-visible:shadow-focus"
        >
          Regenerate
        </button>
      </p>
      <Callout variant="warn" title="They must change it">
        The user can&apos;t sign in normally until they pick a new password.
      </Callout>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => setConfirm(true)} disabled={!password}>
          Continue
        </Button>
      </div>
    </Modal>
  );
}

/** Shown once after the temporary password is set: copy it or lose it. */
export function TempPasswordBanner({ password, onDismiss }) {
  return (
    <div role="alert" className="flex gap-3 rounded-xl border border-lime/40 bg-lime-bg p-4">
      <span
        className="material-symbols-outlined shrink-0 text-[20px] text-lime-ink"
        aria-hidden="true"
      >
        key
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-text">
          Temporary password set. Copy it now — it won&apos;t be shown again.
        </p>
        <CopyField value={password} label="Copy temporary password" dir="ltr" className="mt-2" />
      </div>
      <Button variant="secondary" size="sm" onClick={onDismiss}>
        Done
      </Button>
    </div>
  );
}

/** Owner transfer: password proof, or continue through the SSO provider. */
export function TransferDialog({
  name,
  busy,
  password,
  onPassword,
  provider,
  onProvider,
  error,
  onClose,
  onTransfer,
  onSso,
}) {
  return (
    <Modal isOpen onClose={onClose} title="Transfer ownership">
      <p className="text-sm text-text">
        {name} becomes the instance owner. You become an admin and can&apos;t undo this yourself.
      </p>
      <div className="mt-4">
        <Input
          label="Your current password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => onPassword(e.target.value)}
        />
      </div>
      {error ? (
        <p id="transfer-error" role="alert" className="mt-3 text-sm text-err">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="danger" onClick={onTransfer} loading={busy} disabled={!password}>
          Transfer with password
        </Button>
      </div>
      <p className="mt-4 text-xs text-muted">
        Signed in with single sign-on? Use your provider instead.
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <Select
          label="Provider"
          value={provider}
          onChange={(e) => onProvider(e.target.value)}
          options={[
            { value: "oidc", label: "OIDC" },
            { value: "saml", label: "SAML" },
          ]}
          className="min-w-36"
        />
        <Button
          variant="secondary"
          onClick={onSso}
          loading={busy}
          aria-describedby={error ? "transfer-error" : undefined}
        >
          Continue with provider
        </Button>
      </div>
    </Modal>
  );
}

TransferDialog.propTypes = {
  name: PropTypes.string.isRequired,
  busy: PropTypes.bool,
  password: PropTypes.string.isRequired,
  onPassword: PropTypes.func.isRequired,
  provider: PropTypes.string.isRequired,
  onProvider: PropTypes.func.isRequired,
  error: PropTypes.string,
  onClose: PropTypes.func.isRequired,
  onTransfer: PropTypes.func.isRequired,
  onSso: PropTypes.func.isRequired,
};

TempPasswordDialog.propTypes = {
  user: PropTypes.object.isRequired,
  onClose: PropTypes.func.isRequired,
  onDone: PropTypes.func.isRequired,
};

TempPasswordBanner.propTypes = {
  password: PropTypes.string.isRequired,
  onDismiss: PropTypes.func.isRequired,
};
