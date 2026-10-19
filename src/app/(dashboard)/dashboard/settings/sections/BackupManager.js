"use client";

import PropTypes from "prop-types";
import { useEffect, useRef, useState } from "react";
import SectionCard from "@/shared/components/SectionCard";
import SettingRow from "@/shared/components/SettingRow";
import Toggle from "@/shared/components/Toggle";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import Checkbox from "@/shared/components/Checkbox";
import Modal from "@/shared/components/Modal";
import Callout from "@/shared/components/Callout";
import CopyField from "@/shared/components/CopyField";
import {
  FORCE_PHRASE,
  buildInstanceImportBody,
  isMismatchError,
  readJsonFile,
  apiError,
  passphraseProblem,
  normalizeDiff,
  hasProof,
  reauthErrorText,
} from "./backupShared";
import AuthFields, { authWithProof, spendProof } from "./BackupAuthFields";
import InstanceDialog from "./InstanceBackupDownload";
import WorkspaceDialog from "./WorkspaceBackup";
import { ChooseFileAgain, DiffList, useDataReauth, useDatabaseFile } from "./BackupReauth";

/**
 * User-aware Data & backup UI (YAN-375): runs only while multi-user is
 * active, so DataSection keeps the legacy OFF path untouched.
 *
 * Two cards, each a standalone multi-step dialog flow — instance first
 * (owner/admin reauth) and one per owned workspace. The instance keeps the
 * existing `tokenhop-backup-<stamp>.json` name. Workspace exports carry
 * `type: "tokenhop.workspaceExport", version: 1`.
 *
 * YAN-1012: users with a linked SSO identity can verify with their provider
 * instead of a password. On return the matching dialog reopens with the
 * one-time proof (or the failure); imports ask for the file again.
 */
export default function BackupManager({ view, onSettingsChange, readEnvelope }) {
  const [status, setStatus] = useState({ type: "", message: "" });
  const [busy, setBusy] = useState(false);
  // `null` closed, else `{}` or the provider round trip result for that dialog.
  const [instanceOpen, setInstanceOpen] = useState(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(null);
  const [importReauth, setImportReauth] = useState(null);
  const databaseFile = useDatabaseFile();
  const { providers, returned, clearReturned } = useDataReauth();

  const ownedWorkspaces = (view.workspaces || []).filter((w) => w.role === "owner");
  const canInstance = view.can?.("instance.settings.manage") ?? false;
  const isOwner = view.can?.("instance.ownership.transfer") ?? false;
  const isManager = canInstance;
  const ownerOnly = isOwner;

  const flash = (type, message) => setStatus({ type, message });

  // Route the provider round trip result to its dialog exactly once.
  useEffect(() => {
    if (!returned) return;
    clearReturned();
    const { action, workspaceId, ssoProof, error, force } = returned;
    const result = { ssoProof: ssoProof || null, ssoOnly: true, error: error || "", force };
    if (action === "instance.export") setInstanceOpen(result);
    else if (action === "instance.import") setImportReauth(result);
    else if (action?.startsWith("workspace.")) {
      setWorkspaceOpen({ ...result, workspaceId, tab: action.slice("workspace.".length) });
    } else setStatus({ type: "err", message: error });
  }, [returned, clearReturned]);

  return (
    <div id="data" className="scroll-mt-24 space-y-4">
      <SectionCard
        icon="database"
        title="Data & backup"
        subtitle="Everything lives in one SQLite file."
      />
      <div className="rounded-2xl border border-line bg-panel p-5 shadow-card divide-y divide-line">
        <SettingRow
          label="Database"
          description="SQLite file location."
          settingKey="DATA_DIR"
          control={
            <div className="w-full sm:min-w-72 sm:max-w-sm">
              <CopyField value={databaseFile} />
            </div>
          }
        />
        <SettingRow
          label="Instance backup"
          description="Full instance: users, identities, keys, connections, combos. Reauth required. An optional passphrase lets this file restore on a different instance; without one it only restores where the same master key exists."
          control={
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                icon="download"
                disabled={!isManager}
                onClick={() => {
                  flash("", "");
                  setInstanceOpen({});
                }}
              >
                Download
              </Button>
              <InstanceImportButton
                ownerOnly={ownerOnly}
                disabled={!isManager}
                busy={busy}
                setBusy={setBusy}
                flash={flash}
                onSettingsChange={onSettingsChange}
                readEnvelope={readEnvelope}
                providers={providers}
                reauth={importReauth}
                clearReauth={() => setImportReauth(null)}
              />
            </div>
          }
        />
        {!isManager && (
          <p className="py-2 text-[13px] text-muted">
            Instance backup needs an owner or admin. You are signed in as {view.name} (
            {view.roleLabel}).
          </p>
        )}
        <SettingRow
          label="Workspace backup"
          description="A workspace you own: its connections, provider nodes, combos, model settings, aliases and preferences. Never includes keys or memberships, and never another workspace."
          control={
            <Button
              variant="secondary"
              icon="download"
              disabled={busy || ownedWorkspaces.length === 0}
              onClick={() => {
                flash("", "");
                setWorkspaceOpen({});
              }}
            >
              Workspace
            </Button>
          }
        />
        {ownedWorkspaces.length === 0 && (
          <p className="py-2 text-[13px] text-muted">
            You do not own any workspace yet, so there is nothing to export. Workspace owners can
            back up their own workspace here; managers cannot.
          </p>
        )}
        {status.message && (
          <div className="py-3">
            <Callout variant={status.type === "ok" ? "ok" : "err"} title={status.message} />
          </div>
        )}
        <SettingRow
          label="Cloud sync"
          description="Keep settings and connections in sync across machines."
          settingKey="cloudEnabled"
          control={
            <Toggle
              checked={false}
              onChange={() => {}}
              disabled
              aria-label="Cloud sync (unavailable)"
            />
          }
        />
        <div className="py-3">
          <Callout variant="info" title="Cloud sync is not available in this build">
            No sync worker ships with this repo, so the toggle stays off. Your data stays local; use
            backup to move it between machines.
          </Callout>
        </div>
      </div>

      {instanceOpen && (
        <InstanceDialog
          onClose={() => setInstanceOpen(null)}
          busy={busy}
          setBusy={setBusy}
          flash={flash}
          providers={providers}
          ssoProof={instanceOpen.ssoProof}
          ssoOnly={instanceOpen.ssoOnly}
          initialError={instanceOpen.error}
        />
      )}
      {workspaceOpen && ownedWorkspaces.length > 0 && (
        <WorkspaceDialog
          workspaces={ownedWorkspaces}
          onClose={() => setWorkspaceOpen(null)}
          busy={busy}
          setBusy={setBusy}
          flash={flash}
          providers={providers}
          initial={workspaceOpen.tab ? workspaceOpen : null}
        />
      )}
    </div>
  );
}

BackupManager.propTypes = {
  view: PropTypes.shape({
    name: PropTypes.string,
    roleLabel: PropTypes.string,
    workspaces: PropTypes.array,
  }).isRequired,
  onSettingsChange: PropTypes.func,
  readEnvelope: PropTypes.func.isRequired,
};

/**
 * Instance import: hidden file input + restore dialog with envelope preview,
 * user-mismatch diff, and an explicit owner-only typed confirmation before
 * `force`. Never auto-forces. After a provider round trip (`reauth`) the file
 * is gone, so it is asked for again; the proof rides along to the dialog.
 */
function InstanceImportButton({
  ownerOnly,
  disabled,
  busy,
  setBusy,
  flash,
  onSettingsChange,
  readEnvelope,
  providers,
  reauth,
  clearReauth,
}) {
  const fileRef = useRef(null);
  const [pending, setPending] = useState(null);

  const open = async (file) => {
    let payload = null;
    try {
      payload = await readJsonFile(file);
    } catch (err) {
      flash("err", err.message);
      return;
    }
    setPending({ name: file.name, payload, envelope: readEnvelope(payload), reauth });
    clearReauth();
  };

  const pick = (event) => {
    const file = event.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (file) open(file);
  };

  return (
    <>
      <Button
        variant="secondary"
        icon="upload"
        disabled={disabled || busy}
        onClick={() => fileRef.current?.click()}
      >
        Import
      </Button>
      <input
        ref={fileRef}
        type="file"
        aria-label="Instance backup file"
        accept="application/json,.json"
        onChange={pick}
        className="hidden"
      />
      {reauth && !pending && (
        <ChooseFileAgain
          title="Restore instance backup"
          verified={Boolean(reauth.ssoProof)}
          error={reauth.error}
          onFile={open}
          onClose={clearReauth}
        />
      )}
      {pending && (
        <InstanceRestoreDialog
          name={pending.name}
          payload={pending.payload}
          envelope={pending.envelope}
          ownerOnly={ownerOnly}
          dismiss={() => setPending(null)}
          busy={busy}
          setBusy={setBusy}
          flash={flash}
          onSettingsChange={onSettingsChange}
          providers={providers}
          reauth={pending.reauth || undefined}
        />
      )}
    </>
  );
}

InstanceImportButton.propTypes = {
  ownerOnly: PropTypes.bool,
  disabled: PropTypes.bool,
  busy: PropTypes.bool,
  setBusy: PropTypes.func.isRequired,
  flash: PropTypes.func.isRequired,
  onSettingsChange: PropTypes.func,
  readEnvelope: PropTypes.func.isRequired,
  providers: PropTypes.arrayOf(PropTypes.string),
  reauth: PropTypes.object,
  clearReauth: PropTypes.func.isRequired,
};

function InstanceRestoreDialog({
  name,
  payload,
  envelope,
  ownerOnly,
  dismiss,
  busy,
  setBusy,
  flash,
  onSettingsChange,
  providers = [],
  reauth = {},
}) {
  const [auth, setAuth] = useState(() => ({
    ...authWithProof(reauth.ssoProof),
    ssoOnly: Boolean(reauth.ssoOnly),
  }));
  const [error, setError] = useState(reauth.error || "");
  // The owner chose to replace users before the round trip: the diff is gone,
  // but the typed confirmation below is still required again.
  const [diff, setDiff] = useState(reauth.force && ownerOnly ? {} : null);
  const [confirmForce, setConfirmForce] = useState(false);
  const [typed, setTyped] = useState("");

  const normalized = normalizeDiff(diff);
  const mismatch = Boolean(diff);
  const forceArmed =
    mismatch && confirmForce && typed.trim().toUpperCase() === FORCE_PHRASE && ownerOnly;
  const problem = passphraseProblem(auth.passphrase, auth.passphrase, { headerSafe: false });
  const ready =
    hasProof(auth) &&
    (!envelope?.portable || Boolean(auth.passphrase)) &&
    !problem &&
    (!mismatch || forceArmed);

  const run = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      const body = buildInstanceImportBody(payload, auth, forceArmed);
      const res = await fetch("/api/settings/database", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = apiError(res, data, "Failed to import database");
        // Any answer after the server read the proof means it is spent.
        if (auth.ssoProof) setAuth(spendProof);
        if (isMismatchError(err)) {
          setDiff(err.diff || {});
          setError(
            auth.ssoProof && ownerOnly
              ? "Your single sign-on check was used. Verify again to replace the users."
              : "",
          );
          return;
        }
        throw err;
      }
      dismiss();
      onSettingsChange?.();
      flash("ok", "Database imported. Restart to apply.");
    } catch (err) {
      setError(reauthErrorText(err, Boolean(auth.ssoProof), "Failed to import database"));
      if (auth.ssoProof) setAuth(spendProof);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={dismiss}
      title={mismatch ? "Users differ — replace them?" : "Replace database with this backup?"}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={dismiss} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={run} loading={busy} disabled={!ready} variant="danger">
            {mismatch ? "Replace users and data" : "Replace"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Callout variant="warn" title="Import replaces this instance's data">
          Backup file {name}. Everything — settings, connections, keys, combos — is replaced by the
          backup. Download a fresh backup first if you might need the current state.
        </Callout>
        {envelope?.hashed && (
          <Callout
            variant="info"
            title={`Full-instance backup (format v${envelope.formatVersion})`}
          >
            Holds user identities, password hashes, key references (no raw keys) and provider
            credentials. Keep this file private.{" "}
            {envelope.portable
              ? "This file is passphrase-protected for another instance. Enter its passphrase to restore it."
              : "The master key is not in the file; it must already exist on this machine or the restore fails before anything changes."}
          </Callout>
        )}
        {envelope && (
          <p className="text-[13px] text-muted">
            {envelope.formatVersion ? `Format v${envelope.formatVersion}` : "Legacy format"}
            {envelope.schemaVersion != null && ` · schema ${envelope.schemaVersion}`}
          </p>
        )}
        {mismatch && (
          <>
            <Callout variant="err" title="This backup names different users">
              Replacing would remove or rewrite accounts, including possibly your own. Only the
              instance owner can do this, and only with the typed confirmation below. It is never
              automatic.
            </Callout>
            <DiffList title="Only in the backup" entries={normalized.onlyInBackup} />
            <DiffList
              title="Only on this instance"
              entries={normalized.onlyInInstance}
              variant="err"
            />
            <DiffList title="Role changes" entries={normalized.roleChanged} variant="err" />
            {!ownerOnly ? (
              <Callout variant="warn" title="Owner only">
                You are signed in as an admin. Ask the instance owner to perform this import.
              </Callout>
            ) : (
              <div className="space-y-3 rounded-xl border border-err/40 p-3">
                <Checkbox
                  checked={confirmForce}
                  onChange={setConfirmForce}
                  label="I understand this removes or rewrites accounts"
                  description="Including possibly my own session. I will have to sign in again."
                />
                {confirmForce && (
                  <Input
                    label={`Type ${FORCE_PHRASE} to continue`}
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder={FORCE_PHRASE}
                    autoComplete="off"
                  />
                )}
              </div>
            )}
          </>
        )}
        {error && <Callout variant="err" title={error} />}
        {!mismatch && problem && (
          <p className="text-[13px] text-err" role="alert">
            {problem}
          </p>
        )}
        <AuthFields
          auth={auth}
          setAuth={setAuth}
          mode="import"
          requiredPassphrase={Boolean(envelope?.portable)}
          disabled={busy}
          sso={{
            providers,
            action: "instance.import",
            force: mismatch && ownerOnly,
          }}
        />
      </div>
    </Modal>
  );
}

InstanceRestoreDialog.propTypes = {
  name: PropTypes.string.isRequired,
  payload: PropTypes.object.isRequired,
  envelope: PropTypes.object,
  ownerOnly: PropTypes.bool,
  dismiss: PropTypes.func.isRequired,
  busy: PropTypes.bool,
  setBusy: PropTypes.func.isRequired,
  flash: PropTypes.func.isRequired,
  onSettingsChange: PropTypes.func,
  providers: PropTypes.arrayOf(PropTypes.string),
  reauth: PropTypes.object,
};
