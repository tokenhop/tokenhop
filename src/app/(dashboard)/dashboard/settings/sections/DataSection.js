"use client";

import PropTypes from "prop-types";
import { useRef, useState } from "react";
import SectionCard from "@/shared/components/SectionCard";
import SettingRow from "@/shared/components/SettingRow";
import Toggle from "@/shared/components/Toggle";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import Modal from "@/shared/components/Modal";
import Callout from "@/shared/components/Callout";
import CopyField from "@/shared/components/CopyField";

/**
 * Data & backup section: read-only DB location and password-gated
 * download/import backup actions (parity with the legacy profile page),
 * plus the honest cloud-sync readout (the sync worker is not in this repo).
 */
export default function DataSection({ onSettingsChange }) {
  const [status, setStatus] = useState({ type: "", message: "" });
  const [loading, setLoading] = useState(false);
  const [auth, setAuth] = useState({ open: false, mode: "", password: "" });
  const pendingFileRef = useRef(null);
  const importFileRef = useRef(null);

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
      anchor.download = `9router-backup-${stamp}.json`;
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

  const handleImportPick = (event) => {
    const file = event.target.files?.[0];
    if (importFileRef.current) importFileRef.current.value = "";
    if (!file) return;
    pendingFileRef.current = file;
    setStatus({ type: "", message: "" });
    setAuth({ open: true, mode: "import", password: "" });
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
      setStatus({ type: "ok", message: "Database imported successfully" });
    } catch (err) {
      setStatus({ type: "err", message: err.message || "Invalid backup file" });
    } finally {
      pendingFileRef.current = null;
      setLoading(false);
    }
  };

  const handleAuthConfirm = async () => {
    const { mode, password } = auth;
    setAuth({ open: false, mode: "", password: "" });
    if (mode === "export") await handleExport(password);
    else if (mode === "import") await runImport(password);
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
              <CopyField value="~/.9router/db/data.sqlite" />
            </div>
          }
        />
        <div className="py-4 space-y-3">
          <div>
            <p className="text-[15px] font-semibold text-text">Backup</p>
            <p className="mt-0.5 text-[13px] text-muted">Both ask for your password.</p>
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
        title="Confirm password"
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
              Confirm
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-muted">
          Enter your current password to {auth.mode === "export" ? "export" : "import"} the
          database.
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
