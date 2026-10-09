"use client";

import PropTypes from "prop-types";
import { useEffect, useId, useRef, useState } from "react";
import { Button, IconButton, StatusPill, Callout } from "@/shared/components";
import { isNewKey, isKeyExpired } from "../endpointLogic";
import CopyStatus from "@/shared/components/CopyStatus";

/**
 * One-time reveal banner shown after a key is created. The plain key is never
 * retrievable again, so this is the only copy affordance.
 */
export function CreatedBanner({ banner, copiedId, copyError, onCopy, onDismiss }) {
  return (
    <div role="alert" className="mb-4 flex gap-3 rounded-xl border border-lime/40 bg-lime-bg p-4">
      <span
        className="material-symbols-outlined shrink-0 text-[20px] text-lime-ink"
        aria-hidden="true"
      >
        vpn_key
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-text">
          {banner.keyName} is ready. Copy it now, it won&apos;t be shown again.
        </p>
        <code className="mt-1 block truncate font-mono text-sm text-text" dir="ltr">
          {banner.plainKey}
        </code>
        <div className="mt-2">
          <Button
            variant="secondary"
            size="sm"
            icon={
              copiedId === "created-banner"
                ? "check"
                : copyError === "created-banner"
                  ? "error"
                  : "content_copy"
            }
            onClick={() => onCopy(banner.plainKey, "created-banner")}
          >
            {copiedId === "created-banner"
              ? "Copied"
              : copyError === "created-banner"
                ? "Couldn't copy"
                : "Copy key"}
          </Button>
          <CopyStatus copied={copiedId} error={copyError} id="created-banner" />
        </div>
      </div>
      <IconButton icon="close" aria-label="Dismiss" onClick={onDismiss} className="self-start" />
    </div>
  );
}

CreatedBanner.propTypes = {
  banner: PropTypes.shape({
    keyName: PropTypes.string.isRequired,
    plainKey: PropTypes.string.isRequired,
  }).isRequired,
  copiedId: PropTypes.string,
  copyError: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  onDismiss: PropTypes.func.isRequired,
};

function KeyStatusTags({ apiKey }) {
  return (
    <>
      {apiKey.isActive === false && (
        <StatusPill variant="warn" size="sm">
          Paused
        </StatusPill>
      )}
      {isNewKey(apiKey.createdAt) && apiKey.isActive !== false && (
        <StatusPill variant="live" size="sm">
          New
        </StatusPill>
      )}
      {apiKey.type && (
        <StatusPill variant="neutral" size="sm">
          {apiKey.type === "service" ? "Service" : "User"}
        </StatusPill>
      )}
      {Boolean(apiKey.legacy) && (
        <StatusPill variant="neutral" size="sm" title="Rotate recommended">
          Legacy
        </StatusPill>
      )}
      {isKeyExpired(apiKey.expiresAt) && (
        <StatusPill variant="warn" size="sm">
          Expired
        </StatusPill>
      )}
    </>
  );
}

KeyStatusTags.propTypes = {
  apiKey: PropTypes.shape({
    isActive: PropTypes.bool,
    createdAt: PropTypes.string,
    type: PropTypes.string,
    legacy: PropTypes.oneOfType([PropTypes.bool, PropTypes.number]),
    expiresAt: PropTypes.string,
  }).isRequired,
};

/**
 * Inline rename control for one key row. Enter saves, Escape cancels; the
 * input stays open on save failure so the error below it can be read.
 *
 * @param {object} props
 * @param {{id: string, name: string}} props.apiKey
 * @param {boolean} props.editing Whether this row is in edit mode.
 * @param {(id: string|null) => void} props.setEditingId Shared edit-state setter.
 * @param {boolean} props.loading Rename request in flight.
 * @param {string} [props.error] Per-row rename error, announced via aria-describedby.
 * @param {(id: string, name: string) => Promise<boolean>} props.onRenameKey
 * @param {(id: string) => void} props.clearRenameError
 */
export function KeyName({
  apiKey,
  editing,
  setEditingId,
  loading,
  error,
  onRenameKey,
  clearRenameError,
  canRename = true,
}) {
  const [value, setValue] = useState(apiKey.name);
  const inputRef = useRef(null);
  const pendingRef = useRef(false);
  const inputId = useId();

  // Desktop table and mobile card both mount. Focus only the visible editor.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-run when edit mode opens/closes.
  useEffect(() => {
    if (editing) {
      setValue(apiKey.name);
      if (inputRef.current?.getClientRects().length) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    }
  }, [editing]);

  const cancel = () => {
    if (loading || pendingRef.current) return;
    setValue(apiKey.name);
    clearRenameError(apiKey.id);
    setEditingId(null);
  };

  // pendingRef blocks a double Enter before the parent's renamingId arrives.
  const save = async () => {
    if (loading || pendingRef.current) return;
    pendingRef.current = true;
    try {
      if (await onRenameKey(apiKey.id, value)) setEditingId(null);
    } finally {
      pendingRef.current = false;
    }
  };

  if (!editing) {
    return (
      <span className="flex flex-wrap items-center gap-1.5 font-medium text-text">
        {apiKey.name}
        <KeyStatusTags apiKey={apiKey} />
        {canRename && (
          <IconButton
            icon="edit"
            aria-label={`Rename key ${apiKey.name}`}
            className="size-7"
            onClick={() => setEditingId(apiKey.id)}
          />
        )}
      </span>
    );
  }

  return (
    <span className="flex flex-col gap-1">
      <span className="flex items-center gap-1">
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          value={value}
          disabled={loading}
          onChange={(e) => {
            setValue(e.target.value);
            clearRenameError(apiKey.id);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          aria-label={`Rename key ${apiKey.name}`}
          aria-describedby={error ? `${inputId}-error` : undefined}
          aria-invalid={error ? true : undefined}
          className="w-full min-w-0 rounded-lg border border-line bg-raised px-2 py-1 text-sm text-text transition-colors duration-150 focus:border-coral focus:shadow-focus focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-err"
        />
        <IconButton
          icon="check"
          aria-label="Save name"
          loading={loading}
          className="size-7"
          onClick={save}
        />
        <IconButton
          icon="close"
          aria-label="Cancel rename"
          disabled={loading}
          className="size-7"
          onClick={cancel}
        />
      </span>
      {error && (
        <span id={`${inputId}-error`} role="alert" className="text-xs text-err">
          {error}
        </span>
      )}
    </span>
  );
}

KeyName.propTypes = {
  apiKey: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    isActive: PropTypes.bool,
    createdAt: PropTypes.string,
  }).isRequired,
  editing: PropTypes.bool.isRequired,
  setEditingId: PropTypes.func.isRequired,
  loading: PropTypes.bool,
  error: PropTypes.string,
  onRenameKey: PropTypes.func.isRequired,
  clearRenameError: PropTypes.func.isRequired,
  canRename: PropTypes.bool,
};

/**
 * One-time migration notice for hashed storage: keys keep working, but only
 * the prefix shows from now on. Authority is the server-side spec214 flag in
 * the key context — visible until `migrationAcknowledged` is true, including
 * across browsers and reloads. The dismiss action renders for managers only
 * and hides the notice only on PATCH success; failure keeps the notice with
 * the nonsecret server error. Members/viewers see the notice, no action.
 */
export function MigrationNotice({ notice }) {
  if (!notice.visible) return null;
  return (
    <div className="mb-4">
      <Callout variant="info" title="Keys are now stored as hashes">
        Existing keys keep working. Full keys are no longer stored or shown — only the prefix is
        displayed. Create a new key to get a copyable secret.
        {notice.canDismiss && (
          <div className="mt-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={notice.dismiss}
              disabled={notice.dismissing}
              loading={notice.dismissing}
            >
              Got it
            </Button>
            {notice.error && (
              <p className="mt-1 text-xs text-err" role="alert">
                {notice.error}
              </p>
            )}
          </div>
        )}
      </Callout>
    </div>
  );
}

MigrationNotice.propTypes = {
  notice: PropTypes.shape({
    visible: PropTypes.bool.isRequired,
    canDismiss: PropTypes.bool.isRequired,
    dismissing: PropTypes.bool.isRequired,
    error: PropTypes.string,
    dismiss: PropTypes.func.isRequired,
  }).isRequired,
};
