"use client";

import PropTypes from "prop-types";
import { useState } from "react";
import { Button, Callout, Checkbox, Input, Select } from "@/shared/components";
import Modal from "@/shared/components/Modal";
import { deleteWorkspace, safeAuthorizeUrl, startWorkspaceReauth } from "./workspaceApi";

const PROVIDER_OPTIONS = [
  { value: "oidc", label: "OIDC" },
  { value: "saml", label: "SAML" },
];

const START_ERRORS = {
  sso_not_linked: "Your account is not linked to that provider.",
  sso_unavailable: "That provider is not available on this instance.",
};

/** Dialog-local message for a failed DELETE. `usedSso` picks the no-fallback copy. */
function deleteErrorText(err, usedSso) {
  if (err?.status === 401 || err?.code === "reauth_required") {
    return usedSso
      ? "Fresh sign-in required. The single sign-on proof is missing, expired or already used. Re-authenticate again."
      : err?.message || "Fresh authentication required.";
  }
  if (err?.code === "reauth_unsupported") {
    return "This account signs in with single sign-on and has no password. Re-authenticate with your provider instead.";
  }
  if (err?.code === "stale_session") return "Your session is out of date. Sign in again.";
  if (err?.code === "default_workspace") return "The Default workspace cannot be deleted.";
  return err?.message || "Could not delete this workspace.";
}

/**
 * Guarded workspace deletion. The delete button stays disabled until the
 * exact workspace name is typed, the DEK-destruction checkbox is ticked and a
 * fresh proof exists: the current password, or a one-time `ssoProof` handed
 * in by the page after an SSO re-auth round trip. Typed name, checkbox and
 * password are local state only, so a provider round trip always re-asks
 * for them. Errors stay inside the dialog.
 *
 * @param {object} props
 * @param {{ id: string, name: string }} props.workspace
 * @param {number|null} [props.grantBudgetsElsewhere] Budgets in other workspaces that this delete also removes (separate from this workspace's own budgets).
 * @param {string|null} [props.ssoProof] One-time proof from a completed SSO re-auth; never persisted or logged.
 * @param {boolean} [props.requireSso] Failed SSO proof requires another IdP login, never a password fallback.
 * @param {string} [props.initialError] Callback failure shown in this dialog.
 * @param {() => void} props.onClose
 * @param {() => void} props.onProofSpent Called when a failed attempt used `ssoProof` (single-use: a fresh re-auth is required).
 * @param {() => void} props.onDeleted Called after the server confirms deletion.
 */
export default function DeleteWorkspaceDialog({
  workspace,
  ssoProof = null,
  grantBudgetsElsewhere = null,
  requireSso = false,
  initialError = "",
  onClose,
  onProofSpent,
  onDeleted,
}) {
  const [typedName, setTypedName] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [password, setPassword] = useState("");
  const [provider, setProvider] = useState("oidc");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  // SSO-initiated attempts never fall back to a password proof, even after a
  // spent/missing ssoProof: the server fails closed (401) and so do we.
  const [needSso, setNeedSso] = useState(requireSso || Boolean(ssoProof));

  const nameMatches = typedName === workspace.name;
  const hasProof = ssoProof ? true : needSso ? false : password.length > 0;
  const canDelete = nameMatches && acknowledged && hasProof && !busy;
  const close = () => {
    if (!busy) onClose();
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!canDelete) return;
    setBusy(true);
    setError("");
    try {
      await deleteWorkspace(workspace.id, ssoProof ? { ssoProof } : { currentPassword: password });
      onDeleted();
    } catch (err) {
      setError(deleteErrorText(err, Boolean(ssoProof)));
      if (ssoProof) {
        setNeedSso(true);
        onProofSpent();
      }
      if (err?.status === 401) setPassword("");
      setBusy(false);
    }
  };

  const startSso = async () => {
    setBusy(true);
    setError("");
    try {
      const body = await startWorkspaceReauth(workspace.id, provider);
      const url = safeAuthorizeUrl(body?.authorizeUrl);
      if (!url) throw new Error("The provider did not return a valid sign-in URL.");
      window.location.assign(url);
    } catch (err) {
      setError(START_ERRORS[err?.code] || err?.message || "Could not start re-authentication.");
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={close} closeOnOverlay={false} title={`Delete ${workspace.name}`}>
      <form onSubmit={submit} className="flex min-w-0 flex-col gap-4" noValidate>
        <Callout variant="err" title="This cannot be undone">
          <p>
            Permanently removes the live credentials, API keys, memberships, invitations, budgets
            and outgoing grants of this workspace. Budgets in other workspaces that depend on its
            grants are removed too. Usage history is retained.
          </p>
          {Number.isInteger(grantBudgetsElsewhere) && grantBudgetsElsewhere > 0 ? (
            <p className="mt-2 font-semibold">
              {`That includes ${grantBudgetsElsewhere} budget${grantBudgetsElsewhere === 1 ? "" : "s"} in other workspaces.`}
            </p>
          ) : null}
          <p className="mt-2">
            The workspace encryption key is destroyed. Old backups together with the master key may
            still restore the old secrets, so rotate any credentials you care about.
          </p>
        </Callout>

        <Input
          label={`Type "${workspace.name}" to confirm`}
          value={typedName}
          onChange={(event) => setTypedName(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />

        <Checkbox
          checked={acknowledged}
          onChange={setAcknowledged}
          disabled={busy}
          label="I understand the encryption key is destroyed"
          description="Stored credentials and API keys of this workspace cannot be recovered afterwards."
        />

        {ssoProof ? (
          <Callout variant="ok" title="Single sign-on re-authentication complete">
            This proof works for one delete attempt only.
          </Callout>
        ) : (
          <div className="flex flex-col gap-3">
            {needSso ? (
              <p className="text-sm text-muted">
                This attempt used single sign-on, so a password is not accepted. Re-authenticate
                with your provider for a fresh proof.
              </p>
            ) : (
              <Input
                label="Your current password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
              />
            )}
            <div className="flex flex-col gap-2 border-t border-line pt-3">
              <p className="text-xs text-muted">
                Signed in with single sign-on? Re-authenticate with your provider. You return here
                and must type the name and tick the box again. Starting a new check cancels any
                pending one.
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <Select
                  label="Provider"
                  value={provider}
                  onChange={(event) => setProvider(event.target.value)}
                  options={PROVIDER_OPTIONS}
                  disabled={busy}
                  className="min-w-36"
                />
                <Button type="button" variant="secondary" onClick={startSso} disabled={busy}>
                  Re-authenticate with provider
                </Button>
              </div>
            </div>
          </div>
        )}

        {error ? (
          <p role="alert" className="rounded-lg bg-err-bg px-3 py-2 text-sm text-err">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={busy} disabled={!canDelete}>
            Delete workspace
          </Button>
        </div>
      </form>
    </Modal>
  );
}

DeleteWorkspaceDialog.propTypes = {
  workspace: PropTypes.shape({ id: PropTypes.string.isRequired, name: PropTypes.string.isRequired })
    .isRequired,
  ssoProof: PropTypes.string,
  grantBudgetsElsewhere: PropTypes.number,
  requireSso: PropTypes.bool,
  initialError: PropTypes.string,
  onClose: PropTypes.func.isRequired,
  onProofSpent: PropTypes.func.isRequired,
  onDeleted: PropTypes.func.isRequired,
};
