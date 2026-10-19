"use client";

import PropTypes from "prop-types";
import { useRef, useState } from "react";
import Button from "@/shared/components/Button";
import Select from "@/shared/components/Select";
import SegmentedControl from "@/shared/components/SegmentedControl";
import Modal from "@/shared/components/Modal";
import Callout from "@/shared/components/Callout";
import {
  WORKSPACE_EXPORT_TYPE,
  WORKSPACE_EXPORT_VERSION,
  readJsonFile,
  downloadJson,
  backupFileName,
  apiError,
  passphraseProblem,
  hasProof,
  proofFields,
  reauthErrorText,
} from "./backupShared";
import AuthFields, { authWithProof, spendProof } from "./BackupAuthFields";

const slug = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "workspace";

/**
 * Workspace export/import (YAN-375): the chooser only lists workspaces the
 * signer owns, so nothing about sibling workspaces ever renders. Export
 * downloads `type: tokenhop.workspaceExport v1`; import posts the doc plus
 * reauth and shows backend user/role errors inline.
 *
 * YAN-1012: `initial` reopens the dialog after a single sign-on round trip —
 * same tab and workspace, with the one-time proof (or the failure). A proof is
 * bound to that tab + workspace, so both are locked while it is held.
 */
export default function WorkspaceDialog({
  workspaces,
  onClose,
  busy,
  setBusy,
  flash,
  providers = [],
  initial = null,
}) {
  // A proof is bound to its workspace: drop it if that one is no longer listed.
  const owned = workspaces.some((w) => w.id === initial?.workspaceId);
  const [tab, setTab] = useState(initial?.tab || "export");
  const [workspaceId, setWorkspaceId] = useState(() =>
    owned ? initial.workspaceId : (workspaces[0]?.id ?? ""),
  );
  const [auth, setAuth] = useState(() => ({
    ...authWithProof(owned ? initial?.ssoProof : null),
    ssoOnly: Boolean(initial?.ssoOnly || initial?.ssoProof),
  }));
  const [error, setError] = useState(initial?.error || "");
  const proofHeld = Boolean(auth.ssoProof);
  const [importFile, setImportFile] = useState(null);
  const [docName, setDocName] = useState("");
  const fileRef = useRef(null);

  const selected = workspaces.find((w) => w.id === workspaceId) || null;
  const passphraseOk = Boolean(auth.passphrase);
  const problem = passphraseOk
    ? passphraseProblem(
        auth.passphrase,
        // Import has no repeat field: compare the passphrase with itself.
        tab === "export" ? auth.confirm : auth.passphrase,
        { headerSafe: false },
      )
    : "";
  const ready =
    Boolean(selected) &&
    hasProof(auth) &&
    passphraseOk &&
    !problem &&
    (tab === "export" || Boolean(importFile));

  const pickDoc = async (event) => {
    const f = event.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    setError("");
    if (!f) return;
    try {
      const doc = await readJsonFile(f);
      if (doc?.type !== WORKSPACE_EXPORT_TYPE || doc?.version !== WORKSPACE_EXPORT_VERSION) {
        throw new Error(
          `Not a workspace backup (expected ${WORKSPACE_EXPORT_TYPE} v${WORKSPACE_EXPORT_VERSION}).`,
        );
      }
      setImportFile(doc);
      setDocName(f.name);
    } catch (err) {
      setImportFile(null);
      setDocName("");
      setError(err.message || "Invalid workspace file");
    }
  };

  const run = async () => {
    if (!ready || busy || !selected) return;
    setBusy(true);
    setError("");
    try {
      if (tab === "export") {
        const body = proofFields(auth);
        if (auth.passphrase) body.passphrase = auth.passphrase;
        const res = await fetch(`/api/workspaces/${selected.id}/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw apiError(res, data, "Failed to export workspace");
        downloadJson(data, backupFileName(`workspace-${slug(selected.name)}-`));
        flash("ok", `Workspace “${selected.name}” exported. Keep the file private.`);
        onClose();
      } else {
        const body = { ...proofFields(auth), data: importFile };
        if (auth.passphrase) body.passphrase = auth.passphrase;
        const res = await fetch(`/api/workspaces/${selected.id}/import`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw apiError(res, data, "Failed to import workspace");
        flash("ok", `Workspace “${selected.name}” imported.`);
        onClose();
      }
    } catch (err) {
      setError(reauthErrorText(err, Boolean(auth.ssoProof), "Request failed"));
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
      title="Workspace backup"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={run} loading={busy} disabled={!ready}>
            {tab === "export" ? "Download" : "Import"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {proofHeld ? (
          <p className="text-sm font-semibold text-text">
            {tab === "export" ? "Export" : "Import"}
          </p>
        ) : (
          <SegmentedControl
            aria-label="Workspace backup mode"
            value={tab}
            onChange={(value) => {
              setTab(value);
              setError("");
            }}
            options={[
              { value: "export", label: "Export" },
              { value: "import", label: "Import" },
            ]}
          />
        )}
        <Select
          label="Workspace"
          value={workspaceId}
          onChange={(e) => setWorkspaceId(e.target.value)}
          options={workspaces.map((w) => ({
            value: w.id,
            label: `${w.name}${w.kind === "personal" ? " (personal)" : ""}`,
          }))}
          placeholder={null}
          disabled={proofHeld}
          hint={
            proofHeld
              ? "Your single sign-on check is for this workspace only."
              : "Only workspaces you own are listed."
          }
        />
        {error && <Callout variant="err" title={error} />}
        {tab === "import" && (
          <div className="space-y-2">
            <Button
              variant="secondary"
              icon="upload"
              size="sm"
              onClick={() => fileRef.current?.click()}
            >
              Choose file
            </Button>
            <input
              ref={fileRef}
              type="file"
              aria-label="Workspace backup file"
              accept="application/json,.json"
              onChange={pickDoc}
              className="hidden"
            />
            {docName ? (
              <p className="text-[13px] text-muted" role="status">
                {docName}
              </p>
            ) : (
              proofHeld && (
                <p className="text-[13px] text-muted" role="status">
                  Choose the backup file again to continue. The check expires in 5 minutes.
                </p>
              )
            )}
            <Callout variant="warn" title="Adds copies with new IDs — never replaces">
              Only {selected ? `“${selected.name}”` : "the chosen workspace"} is touched. You must
              own it; managers cannot import. Conflicting items are rejected atomically, so either
              the whole file imports or nothing changes.
            </Callout>
          </div>
        )}
        <AuthFields
          auth={auth}
          setAuth={setAuth}
          mode={tab === "export" ? "workspaceExport" : "workspaceImport"}
          sso={{
            providers,
            action: tab === "export" ? "workspace.export" : "workspace.import",
            workspaceId: selected?.id,
          }}
          disabled={busy}
        />
        {problem && (
          <p className="text-[13px] text-err" role="alert">
            {problem}
          </p>
        )}
      </div>
    </Modal>
  );
}

WorkspaceDialog.propTypes = {
  workspaces: PropTypes.array.isRequired,
  onClose: PropTypes.func.isRequired,
  busy: PropTypes.bool,
  setBusy: PropTypes.func.isRequired,
  flash: PropTypes.func.isRequired,
  providers: PropTypes.arrayOf(PropTypes.string),
  initial: PropTypes.shape({
    tab: PropTypes.oneOf(["export", "import"]),
    workspaceId: PropTypes.string,
    ssoProof: PropTypes.string,
    ssoOnly: PropTypes.bool,
    error: PropTypes.string,
  }),
};
