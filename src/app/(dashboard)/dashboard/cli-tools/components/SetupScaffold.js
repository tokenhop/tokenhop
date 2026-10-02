"use client";

import PropTypes from "prop-types";
import { ACTIVE } from "@/shared/brand";
import { useState } from "react";
import Button from "@/shared/components/Button";
import { ConfirmDialog } from "@/shared/components/Modal";
import Card from "@/shared/components/Card";
import Input from "@/shared/components/Input";
import IconButton from "@/shared/components/IconButton";
import StatusPill from "@/shared/components/StatusPill";
import Callout from "@/shared/components/Callout";
import { manualMissingInputs } from "@/lib/cliToolConfigs/shared";
import { useCliAccessStore } from "@/store/cliAccessStore";
import ToolTile from "./ToolTile";
import { LoadingState } from "@/shared/components/StateViews";

/**
 * Shared shell for every CLI-tool setup panel (board: Claude Code panel).
 * Header (lg tile, name, status pill, detected version), install/not-ready
 * states, aria-live result message, Apply / Manual config / Reset footer and
 * the written-file hint in mono. Per-tool cards own their data fetching and
 * POST bodies; this owns only the layout. The `saveStatus`, `onResetDefaults`,
 * `differsHint` and `onLoadFromFile` props add one quiet persistence row after
 * the card fields (host and remote).
 */
export default function SetupScaffold({
  tool,
  status,
  version,
  checking = false,
  checkingLabel = "Checking...",
  notInstalled = null,
  message = null,
  onApply,
  applyDisabled = false,
  applying = false,
  applyLabel = "Apply",
  onReset,
  resetDisabled = false,
  resetting = false,
  resetLabel = "Reset",
  onManualConfig,
  manualDisabled = false,
  manualConfigs = null,
  fileHint = "",
  confirmReset = true,
  hideActions = false,
  children,
  saveStatus,
  onResetDefaults,
  differsHint,
  onLoadFromFile,
}) {
  const localOnly = useCliAccessStore((s) => s.localOnly);
  const installedBlock = localOnly ? null : notInstalled;
  const showWriteActions = !hideActions && !localOnly;
  // Detection never runs off the host, so a missing CLI is not "Not installed".
  const pill =
    localOnly && status?.label === "Not installed"
      ? { label: "Manual setup", variant: "info" }
      : status;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resetError, setResetError] = useState(null);
  // Reset rewrites the named user config file, so confirm first. Cards with no
  // fileHint (Antigravity "Save mappings") reuse the slot for a safe action.
  const needsConfirm = confirmReset && Boolean(fileHint);
  const handleResetClick = needsConfirm
    ? () => {
        setResetError(null);
        setConfirmOpen(true);
      }
    : onReset;
  // Card resets resolve true on success. On failure the dialog stays open and
  // shows the error inline; Esc/Cancel stay safe.
  const handleConfirmReset = async () => {
    setResetError(null);
    const ok = await onReset?.();
    if (ok) setConfirmOpen(false);
    else setResetError("Reset failed. Check the message in the panel and try again.");
  };

  return (
    <Card
      padding="md"
      className="flex flex-col gap-4 sm:gap-5"
      role="region"
      aria-label={`${tool.name} setup`}
    >
      <div className="flex items-start gap-3.5">
        <ToolTile tool={tool} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="font-display text-[26px] leading-tight font-bold text-text">
            {tool.name}
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            {pill && !checking && (
              <StatusPill variant={pill.variant} size="sm" dot={pill.variant === "ok"}>
                {pill.label}
              </StatusPill>
            )}
            {version && <span className="font-mono text-xs text-muted">{version}</span>}
          </div>
        </div>
      </div>

      {checking ? (
        <LoadingState lines={2} label={checkingLabel} />
      ) : installedBlock ? (
        installedBlock
      ) : (
        <>
          <div className="flex flex-col gap-4">{children}</div>
          {(saveStatus || onResetDefaults || (differsHint && onLoadFromFile)) && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              {saveStatus && (
                <span
                  role="status"
                  aria-live="polite"
                  className={saveStatus === "error" ? "text-err" : ""}
                >
                  {saveStatus === "saving"
                    ? "Saving…"
                    : saveStatus === "saved"
                      ? "Saved"
                      : "Couldn't save"}
                </span>
              )}
              {onResetDefaults && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  icon="restart_alt"
                  onClick={onResetDefaults}
                >
                  Reset to defaults
                </Button>
              )}
              {differsHint && onLoadFromFile && (
                <>
                  <span>
                    Saved settings differ from <span className="font-mono">{differsHint}</span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    icon="upload_file"
                    onClick={onLoadFromFile}
                  >
                    Load from file
                  </Button>
                </>
              )}
            </div>
          )}
          {localOnly && Array.isArray(manualConfigs) && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[13px] text-muted">
                {manualMissingInputs(manualConfigs).length ? (
                  <>Complete the fields above to get the configuration.</>
                ) : manualConfigs.length === 1 ? (
                  <>1 file to edit by hand.</>
                ) : (
                  `${manualConfigs.length} files to edit by hand.`
                )}
              </p>
              {onManualConfig && (
                <Button
                  variant="primary"
                  size="sm"
                  icon="content_copy"
                  onClick={onManualConfig}
                  className="w-full sm:w-auto"
                >
                  Set up manually
                </Button>
              )}
            </div>
          )}
          {message && (
            <p
              role="status"
              aria-live="polite"
              className={`flex items-center gap-2 rounded-xl px-3 py-2 text-[13px] font-medium ${
                message.type === "success" ? "bg-ok-bg text-ok" : "bg-err-bg text-err"
              }`}
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                {message.type === "success" ? "check_circle" : "error"}
              </span>
              {message.text}
            </p>
          )}
          {showWriteActions && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Button
                variant="primary"
                size="sm"
                onClick={onApply}
                disabled={applyDisabled}
                loading={applying}
                icon="save"
                className="w-full sm:w-auto sm:flex-1"
              >
                {applyLabel}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={onManualConfig}
                disabled={manualDisabled}
                icon="content_copy"
                className="w-full sm:w-auto"
              >
                Manual config
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleResetClick}
                disabled={resetDisabled}
                loading={resetting}
                icon="restore"
                className="w-full sm:w-auto"
              >
                {resetLabel}
              </Button>
            </div>
          )}
          {fileHint && !localOnly && (
            <p className="font-mono text-xs text-muted">Writes {fileHint}</p>
          )}
        </>
      )}
      {needsConfirm && (
        <ConfirmDialog
          isOpen={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          onConfirm={handleConfirmReset}
          title={`Reset ${tool.name} settings?`}
          message={
            <span>
              This rewrites <span className="font-mono">{fileHint}</span>
              {` and removes the ${ACTIVE.name} configuration from it.`}
            </span>
          }
          confirmText="Reset"
          cancelText="Cancel"
          variant="danger"
          error={resetError}
        />
      )}
    </Card>
  );
}

SetupScaffold.propTypes = {
  tool: PropTypes.shape({
    name: PropTypes.string.isRequired,
    color: PropTypes.string,
  }).isRequired,
  status: PropTypes.shape({
    label: PropTypes.string.isRequired,
    variant: PropTypes.string.isRequired,
  }),
  version: PropTypes.string,
  checking: PropTypes.bool,
  checkingLabel: PropTypes.string,
  notInstalled: PropTypes.node,
  message: PropTypes.shape({
    type: PropTypes.string.isRequired,
    text: PropTypes.string.isRequired,
  }),
  onApply: PropTypes.func.isRequired,
  applyDisabled: PropTypes.bool,
  applying: PropTypes.bool,
  applyLabel: PropTypes.string,
  onReset: PropTypes.func.isRequired,
  resetDisabled: PropTypes.bool,
  resetting: PropTypes.bool,
  onManualConfig: PropTypes.func,
  manualDisabled: PropTypes.bool,
  manualConfigs: PropTypes.arrayOf(
    PropTypes.shape({
      file: PropTypes.string,
      format: PropTypes.string,
      mode: PropTypes.string,
      note: PropTypes.string,
      content: PropTypes.string,
    }),
  ),
  fileHint: PropTypes.string,
  confirmReset: PropTypes.bool,
  hideActions: PropTypes.bool,
  resetLabel: PropTypes.string,
  children: PropTypes.node,
  saveStatus: PropTypes.oneOf(["saving", "saved", "error", ""]),
  onResetDefaults: PropTypes.func,
  differsHint: PropTypes.node,
  onLoadFromFile: PropTypes.func,
};

/**
 * Not-installed block shared by every setup card: warning callout plus
 * Manual Config and How-to-install actions.
 */
export function NotInstalledBlock({
  toolName,
  onManualConfig,
  installTitle,
  installCommand,
  installHint,
  guideOpen,
  onToggleGuide,
  guideBody,
}) {
  return (
    <div className="flex flex-col gap-3">
      <Callout variant="warn" title={installTitle || `${toolName} not detected locally`}>
        {`Manual configuration is still available if ${ACTIVE.slug} is deployed on a remote server.`}
      </Callout>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onManualConfig} icon="content_copy">
          Manual config
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleGuide}
          icon={guideOpen ? "expand_less" : "help"}
          aria-expanded={guideOpen}
        >
          {guideOpen ? "Hide" : "How to install"}
        </Button>
      </div>
      {guideOpen && (
        <div className="flex flex-col gap-2 rounded-2xl border border-line bg-raised p-4">
          <h4 className="text-sm font-semibold text-text">Installation guide</h4>
          {installHint && <p className="text-[13px] text-muted">{installHint}</p>}
          {installCommand && (
            <pre className="overflow-x-auto rounded-xl border border-line bg-panel px-3 py-2 font-mono text-xs text-text">
              {installCommand}
            </pre>
          )}
          {guideBody}
        </div>
      )}
    </div>
  );
}

NotInstalledBlock.propTypes = {
  toolName: PropTypes.string.isRequired,
  onManualConfig: PropTypes.func.isRequired,
  installTitle: PropTypes.string,
  installCommand: PropTypes.string,
  installHint: PropTypes.string,
  guideOpen: PropTypes.bool,
  onToggleGuide: PropTypes.func.isRequired,
  guideBody: PropTypes.node,
};

/**
 * Labelled row: label stacked above the control on narrow screens.
 */
export function SetupRow({ label, hint, children }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-semibold text-text">
        {label}
        {hint && <span className="ms-1.5 font-normal text-muted">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

SetupRow.propTypes = {
  label: PropTypes.string.isRequired,
  hint: PropTypes.string,
  children: PropTypes.node.isRequired,
};

/**
 * Model mapping row: text input with clear affordance plus a model-picker
 * trigger. Combos picked from the modal render with a "combo" tag.
 *
 * @param {object} props
 * @param {string} props.label Row label (e.g. Opus).
 * @param {string} props.value Mapped model value.
 * @param {(next: string) => void} props.onChange
 * @param {() => void} props.onPick Open the model picker modal.
 * @param {boolean} [props.pickDisabled] Picker disabled (no active providers).
 * @param {string} [props.pickLabel] Accessible label for the picker button.
 * @param {boolean} [props.isCombo] Show the combo tag.
 */
export function ModelRow({
  label,
  value,
  onChange,
  onPick,
  pickDisabled = false,
  pickLabel,
  isCombo = false,
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="w-14 shrink-0 text-[13px] text-muted">{label}</span>
      <div className="relative min-w-0 flex-1">
        <input
          type="text"
          value={value || ""}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Not mapped"
          aria-label={`${label} model`}
          className="h-11 w-full min-w-0 rounded-xl border border-line bg-raised px-3 pe-16 font-mono text-[13px] text-text placeholder:text-subtle focus:border-coral focus:shadow-focus focus:outline-none"
        />
        <span className="absolute end-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
          {isCombo && value && (
            <span className="rounded-full bg-coral-bg px-2 py-0.5 text-[11px] font-semibold text-coral-ink">
              combo
            </span>
          )}
          {value && (
            <button
              type="button"
              onClick={() => onChange("")}
              aria-label={`Clear ${label} model`}
              className="flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:text-err"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                close
              </span>
            </button>
          )}
        </span>
      </div>
      <IconButton
        icon="list"
        label={pickLabel || `Pick ${label} model`}
        onClick={onPick}
        disabled={pickDisabled}
      />
    </div>
  );
}

ModelRow.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.string,
  onChange: PropTypes.func.isRequired,
  onPick: PropTypes.func.isRequired,
  pickDisabled: PropTypes.bool,
  pickLabel: PropTypes.string,
  isCombo: PropTypes.bool,
};

/**
 * Single-model input row (endpoint/key style cards): full-width input plus
 * picker button.
 */
export function SingleModelRow({
  value,
  onChange,
  onPick,
  pickDisabled = false,
  pickLabel = "Select model",
  placeholder = "provider/model-id",
}) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="relative min-w-0 flex-1">
        <Input
          value={value || ""}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          aria-label="Model"
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange("")}
            aria-label="Clear model"
            className="absolute top-1/2 end-2 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-muted transition-colors hover:text-err"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
              close
            </span>
          </button>
        )}
      </div>
      <IconButton icon="list" label={pickLabel} onClick={onPick} disabled={pickDisabled} />
    </div>
  );
}

SingleModelRow.propTypes = {
  value: PropTypes.string,
  onChange: PropTypes.func.isRequired,
  onPick: PropTypes.func.isRequired,
  pickDisabled: PropTypes.bool,
  pickLabel: PropTypes.string,
  placeholder: PropTypes.string,
};
