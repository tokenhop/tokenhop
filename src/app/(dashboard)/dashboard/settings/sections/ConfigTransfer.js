"use client";

import PropTypes from "prop-types";
import { useRef, useState } from "react";
import { MAX_CONFIG_BYTES } from "@/lib/settingsConfigDoc.js";
import Badge from "@/shared/components/Badge";
import Button from "@/shared/components/Button";
import Callout from "@/shared/components/Callout";
import Input from "@/shared/components/Input";
import Modal from "@/shared/components/Modal";

const STATUS_VARIANT = { changed: "warn", added: "info", unchanged: "neutral" };
const GROUPS = [
  ["settings", "Settings"],
  ["combos", "Combos"],
  ["pricing", "Pricing overrides"],
];
const SCOPE_NOTE =
  "Configuration only: settings, combos and pricing overrides. Passwords, secrets and provider accounts are never included. URL credentials are redacted; masked URL settings keep their current values on import. For a full backup, use Data & backup.";

async function postImport(body) {
  const res = await fetch("/api/settings/config/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const details = (data.errors ?? []).slice(1);
    throw new Error([data.error || "Import failed", ...details].join(" · "));
  }
  return data;
}

function downloadJson(doc) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `9router-config-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** One expandable diff group (changed/added/unchanged counts + entries). */
function DiffGroup({ label, section }) {
  const [open, setOpen] = useState(false);
  if (!section || section.entries.length === 0) return null;
  return (
    <div className="rounded-xl border border-line">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-11 w-full flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-start text-sm outline-none focus-visible:shadow-focus"
      >
        <span
          className="material-symbols-outlined text-[18px] text-muted rtl:-scale-x-100"
          aria-hidden="true"
        >
          {open ? "expand_more" : "chevron_right"}
        </span>
        <span className="font-semibold text-text">{label}</span>
        <span className="ms-auto flex flex-wrap gap-1">
          {["changed", "added", "unchanged"].map((status) =>
            section[status] > 0 ? (
              <Badge key={status} variant={STATUS_VARIANT[status]}>
                {`${section[status]} ${status}`}
              </Badge>
            ) : null,
          )}
        </span>
      </button>
      {open && (
        <ul className="max-h-56 space-y-1.5 overflow-y-auto border-t border-line px-3 py-2">
          {section.entries.map((entry) => (
            <li key={entry.key} className="flex flex-wrap items-center gap-2 text-[13px]">
              <Badge variant={STATUS_VARIANT[entry.status]}>{entry.status}</Badge>
              <code className="break-all font-mono text-text">{entry.key}</code>
              {entry.restart && <Badge variant="neutral">restart</Badge>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

DiffGroup.propTypes = {
  label: PropTypes.string.isRequired,
  section: PropTypes.shape({
    changed: PropTypes.number,
    added: PropTypes.number,
    unchanged: PropTypes.number,
    entries: PropTypes.arrayOf(
      PropTypes.shape({
        key: PropTypes.string.isRequired,
        status: PropTypes.oneOf(["changed", "added", "unchanged"]).isRequired,
        restart: PropTypes.bool,
      }),
    ),
  }),
};

/**
 * Settings header actions: "Export config" (password-confirmed download of
 * the versioned config document) and "Import" (file → password → validated
 * preview diff → confirm → atomic apply). Distinct from the full DB backup in
 * Data & backup; copy says so.
 */
export default function ConfigTransfer({ onSettingsChange }) {
  const [status, setStatus] = useState({ type: "", message: "" });
  const [busy, setBusy] = useState(false);
  const [auth, setAuth] = useState({ open: false, mode: "", password: "" });
  const [preview, setPreview] = useState(null);
  const docRef = useRef(null);
  const passwordRef = useRef("");
  const fileRef = useRef(null);

  const closeAuth = () => setAuth({ open: false, mode: "", password: "" });
  const closePreview = () => {
    docRef.current = null;
    passwordRef.current = "";
    setPreview(null);
  };

  const runExport = async (password) => {
    setBusy(true);
    try {
      const res = await fetch("/api/settings/config/export", {
        headers: { "x-9r-password": password },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Export failed");
      downloadJson(data);
      setStatus({ type: "ok", message: "Configuration exported" });
    } catch (err) {
      setStatus({ type: "err", message: err.message || "Export failed" });
    } finally {
      setBusy(false);
    }
  };

  const runPreview = async (password) => {
    setBusy(true);
    try {
      const data = await postImport({ doc: docRef.current, mode: "preview", password });
      passwordRef.current = password;
      setPreview(data);
    } catch (err) {
      docRef.current = null;
      setStatus({ type: "err", message: err.message });
    } finally {
      setBusy(false);
    }
  };

  const runApply = async () => {
    setBusy(true);
    try {
      const data = await postImport({
        doc: docRef.current,
        mode: "apply",
        password: passwordRef.current,
      });
      closePreview();
      onSettingsChange?.();
      setStatus({
        type: "ok",
        message: data.restartRequired
          ? "Configuration imported. Some changes apply after a restart."
          : "Configuration imported",
      });
    } catch (err) {
      setPreview((p) => (p ? { ...p, applyError: err.message } : p));
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    setStatus({ type: "", message: "" });
    if (file.size > MAX_CONFIG_BYTES) {
      setStatus({ type: "err", message: "That file is too large (max 1 MB)" });
      return;
    }
    try {
      docRef.current = JSON.parse(await file.text());
    } catch {
      docRef.current = null;
      setStatus({ type: "err", message: "That file isn't valid JSON" });
      return;
    }
    setAuth({ open: true, mode: "import", password: "" });
  };

  const confirmAuth = () => {
    const { mode, password } = auth;
    closeAuth();
    if (mode === "export") runExport(password);
    else runPreview(password);
  };

  const hasChanges =
    preview && GROUPS.some(([g]) => preview.diff[g].changed + preview.diff[g].added > 0);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          icon="download"
          loading={busy && auth.mode === "export"}
          disabled={busy}
          onClick={() => {
            setStatus({ type: "", message: "" });
            setAuth({ open: true, mode: "export", password: "" });
          }}
        >
          Export config
        </Button>
        <Button
          variant="secondary"
          icon="upload"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          Import
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          onChange={handleFile}
          className="hidden"
          tabIndex={-1}
          aria-hidden="true"
        />
      </div>
      <div aria-live="polite" aria-atomic="true">
        {status.message && (
          <Callout variant={status.type === "ok" ? "ok" : "err"} title={status.message} />
        )}
      </div>

      <Modal
        isOpen={auth.open}
        onClose={closeAuth}
        title="Confirm password"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={closeAuth}>
              Cancel
            </Button>
            <Button onClick={confirmAuth} disabled={!auth.password}>
              Confirm
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-muted">
          {auth.mode === "export"
            ? "Enter your current password to export the configuration."
            : "Enter your current password to check this configuration file."}
        </p>
        <Input
          type="password"
          autoComplete="current-password"
          aria-label="Current password"
          value={auth.password}
          onChange={(e) => setAuth((s) => ({ ...s, password: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && auth.password) confirmAuth();
          }}
          placeholder="Current password"
        />
        <p className="mt-3 text-[13px] text-muted">{SCOPE_NOTE}</p>
      </Modal>

      <Modal
        isOpen={Boolean(preview)}
        onClose={closePreview}
        title="Import configuration"
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={closePreview} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={runApply} loading={busy} disabled={!hasChanges}>
              Apply import
            </Button>
          </>
        }
      >
        {preview && (
          <div className="space-y-3">
            <p className="text-sm text-muted">{SCOPE_NOTE}</p>
            {preview.redactedSettings?.length > 0 && (
              <Callout variant="info" title="URLs with credentials were masked on export">
                <p>
                  {preview.redactedSettings.join(", ")}: these keep their current values unless you
                  re-enter the full URL before applying.
                </p>
              </Callout>
            )}
            {preview.warnings?.length > 0 && (
              <Callout variant="warn" title="Some entries will be skipped">
                <ul className="list-disc ps-5">
                  {preview.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Callout>
            )}
            {preview.restartRequired && (
              <Callout variant="info" title="Some changes apply after a restart" />
            )}
            {!hasChanges && (
              <Callout variant="ok" title="Nothing to change: this matches your current setup" />
            )}
            {GROUPS.map(([group, label]) => (
              <DiffGroup key={group} label={label} section={preview.diff[group]} />
            ))}
            <p className="text-[13px] text-muted">
              Import adds and updates entries. Nothing is removed. All changes apply together or not
              at all.
            </p>
            {preview.applyError && (
              <div role="alert">
                <Callout variant="err" title={preview.applyError} />
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

ConfigTransfer.propTypes = {
  onSettingsChange: PropTypes.func,
};
