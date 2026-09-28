"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import Textarea from "@/shared/components/Textarea";
import Toggle from "@/shared/components/Toggle";
import Modal, { ConfirmDialog } from "@/shared/components/Modal";
import { parseBatchImport, validateProxyUrl } from "@/shared/utils/proxyPools";

const ALLOWED_HINT = "http, https or socks5";

/**
 * Add/Edit proxy form. Uses Input/Textarea which each self-wire Field.
 * Validation mirrors the server allowlist; server errors show inline.
 */
export function ProxyForm({
  initial = {},
  saving = false,
  testing = false,
  serverError = null,
  onSave,
  onTest,
  onCancel,
  submitLabel = "Save proxy",
}) {
  const [name, setName] = useState(initial.name || "");
  const [proxyUrl, setProxyUrl] = useState(initial.proxyUrl || "");
  const [noProxy, setNoProxy] = useState(initial.noProxy || "");
  const [isActive, setIsActive] = useState(initial.isActive !== false);
  const [strictProxy, setStrictProxy] = useState(initial.strictProxy === true);
  const [touched, setTouched] = useState(false);

  const nameError = touched && !name.trim() ? "Name is required" : null;
  const urlError = touched ? validateProxyUrl(proxyUrl) : null;
  const invalid = Boolean(nameError || urlError) || !name.trim() || !proxyUrl.trim();

  const values = () => ({
    name: name.trim(),
    proxyUrl: proxyUrl.trim(),
    noProxy: noProxy.trim(),
    isActive,
    strictProxy,
  });

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (invalid) return;
        onSave?.(values());
      }}
    >
      <Input
        label="Name"
        required
        error={nameError}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. us-east-residential"
      />
      <Input
        label="Proxy URL"
        required
        hint={ALLOWED_HINT}
        error={urlError}
        value={proxyUrl}
        onChange={(e) => setProxyUrl(e.target.value)}
        placeholder="http://user:pass@host:port"
        inputClassName="font-mono"
        dir="ltr"
      />
      <Input
        label="No proxy"
        hint="Comma-separated hosts that bypass the proxy"
        value={noProxy}
        onChange={(e) => setNoProxy(e.target.value)}
        placeholder="localhost, 127.0.0.1"
        inputClassName="font-mono"
        dir="ltr"
      />
      <Toggle
        label="Active"
        description="Inactive pools are ignored by runtime resolution."
        checked={isActive}
        onChange={setIsActive}
        disabled={saving}
      />
      <Toggle
        label="Strict proxy"
        description="Fail the request instead of going direct if the proxy is down."
        checked={strictProxy}
        onChange={setStrictProxy}
        disabled={saving}
      />
      {serverError ? (
        <p role="alert" className="flex items-center gap-1 text-xs text-err">
          <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
            error
          </span>
          {serverError}
        </p>
      ) : null}
      <div className="mt-auto flex gap-2.5">
        <Button
          type="button"
          variant="secondary"
          loading={testing}
          disabled={testing || saving || !proxyUrl.trim()}
          onClick={() => onTest?.(values())}
          className="flex-1"
        >
          Test
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={saving}
          disabled={saving || testing}
          className="flex-1"
        >
          {submitLabel}
        </Button>
      </div>
      {onCancel ? (
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving || testing}>
          Cancel
        </Button>
      ) : null}
    </form>
  );
}

ProxyForm.propTypes = {
  initial: PropTypes.shape({
    name: PropTypes.string,
    proxyUrl: PropTypes.string,
    noProxy: PropTypes.string,
    isActive: PropTypes.bool,
    strictProxy: PropTypes.bool,
  }),
  saving: PropTypes.bool,
  testing: PropTypes.bool,
  serverError: PropTypes.node,
  onSave: PropTypes.func,
  onTest: PropTypes.func,
  onCancel: PropTypes.func,
  submitLabel: PropTypes.string,
};

/** Batch import modal: textarea, parsed preview with per-line errors, import. */
export function BatchImportModal({ isOpen, onClose, importing, onImport }) {
  const [text, setText] = useState("");
  const { entries, errors } = parseBatchImport(text);
  // ponytail: import dedupe compares normalized entry URLs against stored
  // raw `proxyUrl` values (which keep their original trailing-slash form).
  // Pools stored pre-redesign may re-import once; a normalized server-side
  // dedupe is the upgrade path. Keep the skip in-page so the user sees it.

  const close = () => {
    if (importing) return;
    setText("");
    onClose?.();
  };

  return (
    <Modal isOpen={isOpen} onClose={close} title="Batch import proxies" size="md">
      <Modal.Body>
        <div className="flex flex-col gap-4">
          <Textarea
            label="Proxy list"
            hint="One per line: full URL or host:port:user:pass. Lines with errors are skipped."
            error={errors.length > 0 ? errors.join("\n") : null}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            placeholder={"http://user:pass@127.0.0.1:7897\n127.0.0.1:7897:user:pass"}
            textareaClassName="font-mono"
            dir="ltr"
          />
          {entries.length > 0 && (
            <div className="flex flex-col gap-1.5" aria-live="polite">
              <p className="text-xs font-semibold text-muted">
                {entries.length} {entries.length === 1 ? "proxy" : "proxies"} ready to import
                {errors.length > 0
                  ? ` (${errors.length} invalid ${errors.length === 1 ? "line" : "lines"} skipped)`
                  : ""}
              </p>
              <ul className="flex max-h-40 list-none flex-col gap-1 overflow-y-auto p-0">
                {entries.map((entry) => (
                  <li
                    key={`${entry.lineNumber}-${entry.proxyUrl}`}
                    className="truncate rounded-lg bg-raised px-3 py-1.5 font-mono text-xs text-muted"
                    dir="ltr"
                  >
                    {entry.name}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" onClick={close} disabled={importing}>
          Cancel
        </Button>
        <Button
          variant="primary"
          loading={importing}
          disabled={importing || entries.length === 0}
          onClick={() => onImport?.(entries)}
        >
          {importing ? "Importing…" : `Import ${entries.length || ""}`.trim()}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

BatchImportModal.propTypes = {
  isOpen: PropTypes.bool,
  onClose: PropTypes.func,
  importing: PropTypes.bool,
  onImport: PropTypes.func,
};

/** Delete confirmation for one pool or a bulk selection. */
export function DeleteConfirm({ state, busy, onClose, onConfirm }) {
  if (!state) return null;
  const { count = 1, name = null } = state;
  return (
    <ConfirmDialog
      isOpen
      onClose={onClose}
      onConfirm={onConfirm}
      title={count > 1 ? `Delete ${count} proxy pools?` : "Delete proxy pool?"}
      message={
        count > 1
          ? "Bound pools are skipped automatically. This cannot be undone."
          : `Delete "${name}"? This cannot be undone.`
      }
      confirmText="Delete"
      variant="danger"
      loading={busy}
    />
  );
}

DeleteConfirm.propTypes = {
  state: PropTypes.shape({ count: PropTypes.number, name: PropTypes.string }),
  busy: PropTypes.bool,
  onClose: PropTypes.func.isRequired,
  onConfirm: PropTypes.func.isRequired,
};
