"use client";

import PropTypes from "prop-types";
import { useEffect, useMemo, useRef, useState } from "react";
import SectionCard from "@/shared/components/SectionCard";
import SettingRow from "@/shared/components/SettingRow";
import Toggle from "@/shared/components/Toggle";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import Modal from "@/shared/components/Modal";
import Callout from "@/shared/components/Callout";
import CopyField from "@/shared/components/CopyField";
import { ACTIVE } from "@/shared/brand";
import { useAuthStatusState } from "@/shared/hooks/useAuthStatus";
import { accountView } from "@/shared/utils/account";
import BackupManager from "./BackupManager";

// Shown until the server reports the real path (and if that request fails).
const DEFAULT_DATABASE_FILE = `~/.${ACTIVE.dataDirName}/db/data.sqlite`;

/**
 * Read-only envelope facts of a picked backup file: the actual formatVersion /
 * schemaVersion / apiKeyStorage the file carries, never a guessed schema.
 * v2 (`formatVersion: 2`) is the full-instance hashed snapshot; anything else
 * keeps the legacy v1 shape.
 */
export const readBackupEnvelope = (payload) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const version = Number.isInteger(payload.formatVersion) ? payload.formatVersion : null;
  return {
    formatVersion: version,
    schemaVersion: Number.isInteger(payload.schemaVersion) ? payload.schemaVersion : null,
    hashed: (version === 2 || version === 3) && payload.apiKeyStorage?.storage === "hashed",
    encrypted:
      version === 3 && payload.credentialEncryption != null && Array.isArray(payload.workspaceKeys),
    portable: version === 3 && payload.credentialEncryption?.portable != null,
    apiKeyStorageVersion:
      version === 2 && Number.isInteger(payload.apiKeyStorage?.version)
        ? payload.apiKeyStorage.version
        : null,
    hashKid:
      typeof payload.apiKeyStorage?.hashKid === "string" ? payload.apiKeyStorage.hashKid : null,
  };
};

/**
 * Data & backup section. While users & teams is active (YAN-375) the
 * reauth-confirmed, passphrase-aware export/import takes over; a single-user
 * install keeps the legacy password-gated flow byte-for-byte.
 */
export default function DataSection({ onSettingsChange }) {
  const { status: authStatus } = useAuthStatusState();
  const view = useMemo(() => accountView(authStatus), [authStatus]);
  if (view.active)
    return (
      <BackupManager
        view={view}
        onSettingsChange={onSettingsChange}
        readEnvelope={readBackupEnvelope}
      />
    );
  return <LegacyDataSection onSettingsChange={onSettingsChange} />;
}

/**
 * Data & backup section: read-only DB location and password-gated
 * download/import backup actions (parity with the legacy profile page),
 * plus the honest cloud-sync readout (the sync worker is not in this repo).
 */
function LegacyDataSection({ onSettingsChange }) {
  const [status, setStatus] = useState({ type: "", message: "" });
  const [loading, setLoading] = useState(false);
  const [auth, setAuth] = useState({ open: false, mode: "", password: "" });
  // Envelope facts of the picked backup (read-only; never a secret). Shown
  // in the restore warning; cleared whenever the pick is used or dismissed.
  const [pendingEnvelope, setPendingEnvelope] = useState(null);
  const pendingFileRef = useRef(null);
  const importFileRef = useRef(null);
  const [databaseFile, setDatabaseFile] = useState(DEFAULT_DATABASE_FILE);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/environment", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.databaseFile) setDatabaseFile(data.databaseFile);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleExport = async (password) => {
    setLoading(true);
    setStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/settings/database", {
        headers: { "x-9r-password": password },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to export database");
      }
      const payload = await res.json();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const stamp = new Date().toISOString().replace(/[.:]/g, "-");
      anchor.href = url;
      anchor.download = `${ACTIVE.backupFilePrefix}${stamp}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      setStatus({ type: "ok", message: "Database backup downloaded" });
    } catch (err) {
      setStatus({ type: "err", message: err.message || "Failed to export database" });
    } finally {
      setLoading(false);
    }
  };

  const handleImportPick = async (event) => {
    const file = event.target.files?.[0];
    if (importFileRef.current) importFileRef.current.value = "";
    if (!file) return;
    pendingFileRef.current = file;
    setStatus({ type: "", message: "" });
    // Envelope-only preview for the restore warning; a file that won't parse
    // still opens the dialog so the error can surface on confirm.
    try {
      setPendingEnvelope(readBackupEnvelope(JSON.parse(await file.text())));
    } catch {
      setPendingEnvelope(null);
    }
    setAuth({ open: true, mode: "restore", password: "" });
  };

  const runImport = async (password) => {
    const file = pendingFileRef.current;
    if (!file) return;
    setLoading(true);
    try {
      const raw = await file.text();
      const payload = JSON.parse(raw);
      const res = await fetch("/api/settings/database", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to import database");
      onSettingsChange?.();
      setStatus({ type: "ok", message: "Database imported successfully. Restart to apply." });
    } catch (err) {
      setStatus({ type: "err", message: err.message || "Invalid backup file" });
    } finally {
      pendingFileRef.current = null;
      setPendingEnvelope(null);
      setLoading(false);
    }
  };

  const handleAuthConfirm = async () => {
    const { mode, password } = auth;
    setAuth({ open: false, mode: "", password: "" });
    if (mode === "export") await handleExport(password);
    else if (mode === "import" || mode === "restore") await runImport(password);
  };

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
        <div className="py-4 space-y-3">
          <div>
            <p className="text-[15px] font-semibold text-text">Backup</p>
            <p className="mt-0.5 text-[13px] text-muted">
              Both ask for your password. A full-instance backup holds identities and provider
              secrets — keep the file private.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              icon="download"
              loading={loading}
              onClick={() => setAuth({ open: true, mode: "export", password: "" })}
            >
              Download
            </Button>
            <Button
              variant="secondary"
              icon="upload"
              disabled={loading}
              onClick={() => importFileRef.current?.click()}
            >
              Import
            </Button>
            <input
              ref={importFileRef}
              type="file"
              aria-label="Instance backup file"
              accept="application/json,.json"
              onChange={handleImportPick}
              className="hidden"
            />
          </div>
          {status.message && (
            <Callout variant={status.type === "ok" ? "ok" : "err"} title={status.message} />
          )}
        </div>
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
            Download/Import backup to move it between machines.
          </Callout>
        </div>
      </div>

      <Modal
        isOpen={auth.open}
        onClose={() => setAuth({ open: false, mode: "", password: "" })}
        title={auth.mode === "restore" ? "Replace database with this backup?" : "Confirm password"}
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setAuth({ open: false, mode: "", password: "" })}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button onClick={handleAuthConfirm} loading={loading} disabled={!auth.password}>
              {auth.mode === "restore" ? "Replace" : "Confirm"}
            </Button>
          </>
        }
      >
        {auth.mode === "restore" && (
          <div className="mb-3 space-y-2" role="alert">
            <Callout variant="warn" title="Import replaces this instance's data">
              <p>
                Everything in the current database — settings, connections, keys, combos — is
                replaced by the backup's contents. Download a fresh backup first if you might need
                the current state.
              </p>
            </Callout>
            {pendingEnvelope?.hashed && (
              <Callout variant="info" title="Full-instance backup (format v2)">
                <ul className="list-disc space-y-1 ps-5">
                  <li>
                    Contains user identities and password hashes, key references (no raw keys) and
                    provider secrets. Protect this file.
                  </li>
                  <li>
                    The master key is <strong>not</strong> in the file. It must already be
                    provisioned on this machine — the {ACTIVE.dataDirName} master-key file or the
                    operator's env — before restoring. It is never entered in this page.
                  </li>
                  <li>
                    A missing or mismatched master key fails the pre-restore check with nothing
                    changed; other failures mid-restore are not.
                  </li>
                </ul>
              </Callout>
            )}
            {pendingEnvelope && (
              <p className="text-[13px] text-muted">
                Backup file:{" "}
                {pendingEnvelope.formatVersion
                  ? `format v${pendingEnvelope.formatVersion}`
                  : "legacy format"}
                {pendingEnvelope.schemaVersion != null &&
                  ` · schema ${pendingEnvelope.schemaVersion}`}
                {pendingEnvelope.hashed &&
                  ` · key storage v${pendingEnvelope.apiKeyStorageVersion}`}{" "}
                · restart to apply.
              </p>
            )}
            {!pendingEnvelope && (
              <p className="text-[13px] text-warn">
                File could not be previewed; only its contents will decide.
              </p>
            )}
          </div>
        )}
        <p className="mb-3 text-sm text-muted">
          Enter your current password to{" "}
          {auth.mode === "export" ? "export" : "replace the database with this backup"}.
        </p>
        <Input
          type="password"
          autoComplete="current-password"
          value={auth.password}
          onChange={(e) => setAuth((s) => ({ ...s, password: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && auth.password) handleAuthConfirm();
          }}
          placeholder="Current password"
        />
      </Modal>
    </div>
  );
}

DataSection.propTypes = {
  onSettingsChange: PropTypes.func,
};

LegacyDataSection.propTypes = {
  onSettingsChange: PropTypes.func,
};
