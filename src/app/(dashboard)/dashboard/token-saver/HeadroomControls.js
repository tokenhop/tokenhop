"use client";

import PropTypes from "prop-types";
import { useEffect, useState } from "react";
import { Button, Field, Input, Modal, StatusPill, Toggle } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import CopyStatus from "@/shared/components/CopyStatus";
import { headroomStatusLabel } from "./tokenSaverUtils";
import { fetchJson } from "./tokenSaverApi";

const HEADROOM_EXTRAS_INFO = {
  code: "tree-sitter AST compression for code responses",
  ml: "Kompress-v2 HF model for prose/agentic traces (~+1GB)",
};

/**
 * Compress-context card body: status pill, URL/timeout fields, user-messages
 * toggle, extras chips with install/uninstall, and the Manage modal
 * (start/stop/restart via the existing headroom API with progress + error).
 * @param {object} props
 * @param {object} props.headroom headroom status payload
 * @param {Array<string>} props.available extras ids
 * @param {Array<string>} props.pendingExtras extras staged for install
 * @param {(extra: string) => void} props.onTogglePending
 * @param {() => void} props.onInstall
 * @param {(extra: string) => void} props.onRemove
 * @param {(extra: string, value: boolean) => void} props.onToggleActive
 * @param {boolean} props.codeExtraOn
 * @param {boolean} props.mlExtraOn
 * @param {boolean} props.extrasLoading
 * @param {string} props.extrasError
 * @param {string|null} props.removingExtra
 * @param {string} props.installLog
 * @param {boolean} props.restartingProxy
 */
export function HeadroomControls({
  headroom,
  available,
  pendingExtras,
  onTogglePending,
  onInstall,
  onRemove,
  onToggleActive,
  codeExtraOn,
  mlExtraOn,
  extrasLoading,
  extrasError,
  removingExtra,
  installLog,
  restartingProxy,
}) {
  const extras = headroom.extras || {};
  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="me-1 text-[13px] text-muted">Extras</span>
        {available.map((extra) => {
          const installed = !!extras[extra];
          const pending = pendingExtras.includes(extra);
          if (installed) {
            const active = extra === "code" ? codeExtraOn : mlExtraOn;
            return (
              <span
                key={extra}
                className="inline-flex items-center gap-1.5 rounded-xl border border-ok/40 bg-ok-bg px-2 py-1 text-xs"
                title={HEADROOM_EXTRAS_INFO[extra]}
              >
                <Toggle
                  size="sm"
                  checked={active}
                  disabled={restartingProxy}
                  onChange={() => onToggleActive(extra, !active)}
                  aria-label={`Extra ${extra} active`}
                />
                <span className="font-medium">[{extra}]</span>
                <button
                  type="button"
                  onClick={() => onRemove(extra)}
                  disabled={removingExtra === extra}
                  className="text-err underline hover:opacity-80 disabled:opacity-50"
                >
                  {removingExtra === extra ? "Uninstalling…" : "Uninstall"}
                </button>
              </span>
            );
          }
          return (
            <label
              key={extra}
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-xl border px-2 py-1 text-xs transition-colors ${
                pending
                  ? "border-coral bg-coral-bg text-coral-ink"
                  : "border-line text-muted hover:bg-raised"
              }`}
              title={HEADROOM_EXTRAS_INFO[extra]}
            >
              <input
                type="checkbox"
                className="size-3"
                checked={pending}
                onChange={() => onTogglePending(extra)}
              />
              <span className="font-medium">[{extra}]</span>
              <span className="opacity-70">not installed{extra === "ml" ? " · ~1 GB" : ""}</span>
            </label>
          );
        })}
        {pendingExtras.length > 0 && (
          <Button variant="secondary" size="sm" loading={extrasLoading} onClick={onInstall}>
            Install [proxy,{pendingExtras.join(",")}]
          </Button>
        )}
      </div>
      {extrasError && <p className="mt-1 text-xs text-err">{extrasError}</p>}
      {restartingProxy && <p className="mt-1 text-xs text-muted">Restarting proxy…</p>}
      {(extrasLoading || removingExtra) && installLog && (
        <pre className="mt-2 max-h-32 overflow-auto rounded bg-raised p-2 font-mono text-[10px] break-words whitespace-pre-wrap text-muted">
          {installLog}
        </pre>
      )}
    </>
  );
}

HeadroomControls.propTypes = {
  headroom: PropTypes.object.isRequired,
  available: PropTypes.arrayOf(PropTypes.string).isRequired,
  pendingExtras: PropTypes.arrayOf(PropTypes.string).isRequired,
  onTogglePending: PropTypes.func.isRequired,
  onInstall: PropTypes.func.isRequired,
  onRemove: PropTypes.func.isRequired,
  onToggleActive: PropTypes.func.isRequired,
  codeExtraOn: PropTypes.bool.isRequired,
  mlExtraOn: PropTypes.bool.isRequired,
  extrasLoading: PropTypes.bool.isRequired,
  extrasError: PropTypes.string.isRequired,
  removingExtra: PropTypes.string,
  installLog: PropTypes.string.isRequired,
  restartingProxy: PropTypes.bool.isRequired,
};

/**
 * Headroom status pill props from the probe payload.
 * @param {object} status
 * @returns {{ variant: string, dot: boolean, label: string, running: boolean }}
 */
export function headroomPillProps(status) {
  const label = headroomStatusLabel(status);
  const running = label === "Running";
  const pill = running
    ? { variant: "ok", dot: true }
    : label === "External"
      ? { variant: "info", dot: true }
      : label === "Checking…"
        ? { variant: "neutral" }
        : { variant: "warn", dot: true };
  return { ...pill, label, running };
}

/**
 * Manage Headroom modal: proxy URL + timeout fields, start/stop/recheck with
 * progress and error states.
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {object} props.headroom status payload
 * @param {boolean} props.running
 * @param {string} props.label status label
 * @param {() => Promise<void>} props.onRecheck
 */
export function HeadroomModal({ open, onClose, headroom, running, label, onRecheck }) {
  const [urlDraft, setUrlDraft] = useState("");
  const [timeoutDraft, setTimeoutDraft] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState("");
  const { copied, error, copy } = useCopyToClipboard();

  useEffect(() => {
    if (open) {
      (async () => {
        try {
          const settings = await fetchJson("/api/settings");
          setUrlDraft(settings.headroomUrl || "http://localhost:8787");
          setTimeoutDraft(String(settings.headroomTimeoutMs ?? 3000));
        } catch {
          /* keep previous drafts */
        }
      })();
    }
  }, [open]);

  const savePatch = async (patch) => {
    try {
      await fetchJson("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      return true;
    } catch (error) {
      setActionError(error.message);
      return false;
    }
  };

  const handleAction = async (endpoint) => {
    setActionError("");
    setActionLoading(true);
    try {
      await fetchJson(`/api/headroom/${endpoint}`, { method: "POST" });
      await onRecheck();
    } catch (error) {
      setActionError(error.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleUrlBlur = async () => {
    const next = (urlDraft || "").trim() || "http://localhost:8787";
    setUrlDraft(next);
    if (await savePatch({ headroomUrl: next })) onRecheck();
  };

  const handleTimeoutBlur = async () => {
    const raw = Math.round(Number(timeoutDraft));
    const next = Number.isFinite(raw) && raw > 0 ? raw : 3000;
    setTimeoutDraft(String(next));
    await savePatch({ headroomTimeoutMs: next });
  };

  return (
    <Modal isOpen={open} title={running ? "Headroom" : "Setup Headroom"} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between text-sm">
          <span>Status</span>
          <span className={running ? "text-ok" : "text-warn"}>{label}</span>
        </div>
        {running && (
          <a
            href="/api/headroom/proxy/dashboard"
            target="_blank"
            rel="noreferrer"
            className="w-full rounded-xl border border-line px-4 py-2 text-center text-sm hover:bg-raised"
          >
            Open Headroom Dashboard
          </a>
        )}
        <Field
          label="Proxy URL"
          hint="Use a local proxy for Start/Stop, or an external Docker sidecar like http://headroom:8787."
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={urlDraft}
              onChange={(event) => setUrlDraft(event.target.value)}
              onBlur={handleUrlBlur}
              className="font-mono text-sm"
            />
          )}
        </Field>
        <Field label="Timeout (ms)" hint="Request timeout in milliseconds. Defaults to 3000 ms.">
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={timeoutDraft}
              onChange={(event) => setTimeoutDraft(event.target.value)}
              onBlur={handleTimeoutBlur}
              className="font-mono text-sm"
            />
          )}
        </Field>
        {headroom.managedPid ? (
          <Button
            onClick={() => handleAction("stop")}
            variant="ghost"
            fullWidth
            loading={actionLoading}
          >
            Stop Headroom
          </Button>
        ) : running ? (
          <p className="text-sm text-ok">
            Headroom proxy is reachable. You can enable the token saver.
          </p>
        ) : headroom.canStart ? (
          <Button onClick={() => handleAction("start")} fullWidth loading={actionLoading}>
            Start Headroom
          </Button>
        ) : headroom.localUrl === false ? (
          <p className="text-sm text-warn">
            Start Headroom separately at the configured URL, then recheck.
          </p>
        ) : !headroom.python ? (
          <p className="text-sm text-warn">
            Python ≥ 3.10 required for local managed mode. Install Python first, or use an external
            proxy URL.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">Install then click Start:</p>
            <div className="flex items-center gap-2">
              <pre className="flex-1 overflow-x-auto rounded bg-raised p-2 font-mono text-xs">
                {`pip install "headroom-ai[proxy]"`}
              </pre>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => copy(`pip install "headroom-ai[proxy]"`)}
              >
                {copied ? "Copied" : error ? "Couldn't copy" : "Copy"}
              </Button>
              <CopyStatus copied={copied} error={error} />
            </div>
          </div>
        )}
        {actionError && <p className="text-sm text-warn">{actionError}</p>}
        <div className="flex gap-2">
          <Button onClick={onRecheck} variant="ghost" fullWidth>
            Recheck
          </Button>
          <Button onClick={onClose} fullWidth>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}

HeadroomModal.propTypes = {
  open: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  headroom: PropTypes.object.isRequired,
  running: PropTypes.bool.isRequired,
  label: PropTypes.string.isRequired,
  onRecheck: PropTypes.func.isRequired,
};

/**
 * Headroom status pill element.
 * @param {{ variant: string, dot: boolean, label: string }} props
 */
export function HeadroomPill({ variant, dot, label }) {
  return (
    <StatusPill variant={variant} dot={dot} size="sm">
      {label}
    </StatusPill>
  );
}

HeadroomPill.propTypes = {
  variant: PropTypes.string.isRequired,
  dot: PropTypes.bool,
  label: PropTypes.string.isRequired,
};
