"use client";

import PropTypes from "prop-types";
import { useEffect, useId, useRef, useState } from "react";
import {
  Card,
  Button,
  IconButton,
  SettingRow,
  Toggle,
  EmptyState,
  StatusPill,
  Skeleton,
} from "@/shared/components";
import { maskKey, formatLastUsed, isNewKey, formatNumber } from "../endpointLogic";

/**
 * One-time reveal banner shown after a key is created. The plain key is never
 * retrievable again, so this is the only copy affordance.
 */
function CreatedBanner({ banner, copiedId, onCopy, onDismiss }) {
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
            icon={copiedId === "created-banner" ? "check" : "content_copy"}
            onClick={() => onCopy(banner.plainKey, "created-banner")}
          >
            {copiedId === "created-banner" ? "Copied" : "Copy key"}
          </Button>
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
    </>
  );
}

KeyStatusTags.propTypes = {
  apiKey: PropTypes.shape({
    isActive: PropTypes.bool,
    createdAt: PropTypes.string,
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
function KeyName({ apiKey, editing, setEditingId, loading, error, onRenameKey, clearRenameError }) {
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
        <IconButton
          icon="edit"
          aria-label={`Rename key ${apiKey.name}`}
          className="size-7"
          onClick={() => setEditingId(apiKey.id)}
        />
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
};

/**
 * API keys management card: require-key gate, one-time reveal banner, key
 * table on desktop and stacked cards on mobile. The create/delete modals live
 * in the parent — this card only fires callbacks.
 *
 * @param {object} props
 * @param {Array} props.keys Key rows {id,name,key,isActive,createdAt,lastUsed,requestsToday}.
 * @param {boolean} props.requireApiKey Toggle state for the 401 gate.
 * @param {(checked: boolean) => void} props.onToggleRequireApiKey
 * @param {() => void} props.onCreateKey Opens the create modal in the parent.
 * @param {{keyName: string, plainKey: string}|null} props.createdBanner Just-created key (one-time).
 * @param {() => void} props.onDismissBanner
 * @param {(text: string, id: string) => void} props.onCopy
 * @param {string|null} props.copiedId
 * @param {Set<string>} props.visibleIds Unmasked key ids.
 * @param {(id: string) => void} props.onToggleVisibility
 * @param {string|null} props.togglingId Row id mid-toggle.
 * @param {(id: string, checked: boolean) => void} props.onToggleKey
 * @param {string|null} props.deletingId Row id mid-delete.
 * @param {(id: string) => void} props.onDeleteKey Opens the delete confirm in the parent.
 * @param {(id: string, name: string) => Promise<boolean>} props.onRenameKey
 * @param {string|null} props.renamingId Row id mid-rename.
 * @param {Record<string, string>} props.renameErrors Per-row rename errors.
 * @param {(id: string) => void} props.clearRenameError
 * @param {boolean} props.loading Initial list load.
 */
export default function ApiKeysCard({
  keys,
  requireApiKey,
  onToggleRequireApiKey,
  onCreateKey,
  createdBanner,
  onDismissBanner,
  onCopy,
  copiedId,
  visibleIds,
  onToggleVisibility,
  togglingId,
  onToggleKey,
  deletingId,
  onDeleteKey,
  onRenameKey,
  renamingId,
  renameErrors,
  clearRenameError,
  loading,
}) {
  const [editingId, setEditingId] = useState(null);
  const showValue = (apiKey) => (visibleIds.has(apiKey.id) ? apiKey.key : maskKey(apiKey.key));
  const renderName = (apiKey) => (
    <KeyName
      apiKey={apiKey}
      editing={editingId === apiKey.id}
      setEditingId={setEditingId}
      loading={renamingId === apiKey.id}
      error={renameErrors[apiKey.id]}
      onRenameKey={onRenameKey}
      clearRenameError={clearRenameError}
    />
  );

  return (
    <Card
      id="require-api-key"
      title="API keys"
      icon="vpn_key"
      action={
        <>
          <StatusPill variant="neutral" size="sm">
            {keys.length}
          </StatusPill>
          <Button variant="primary" size="sm" icon="add" onClick={onCreateKey}>
            Create key
          </Button>
        </>
      }
    >
      <SettingRow
        label="Require API key"
        description="Requests without a valid key get a 401. The tunnel needs this on."
        settingKey="requireApiKey"
        control={
          <Toggle
            checked={requireApiKey}
            onChange={onToggleRequireApiKey}
            aria-label="Require API key"
          />
        }
      />

      {createdBanner && (
        <CreatedBanner
          banner={createdBanner}
          copiedId={copiedId}
          onCopy={onCopy}
          onDismiss={onDismissBanner}
        />
      )}

      {loading ? (
        <div className="flex flex-col gap-3 py-6" aria-live="polite" aria-busy="true">
          <span className="sr-only">Loading keys...</span>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : keys.length === 0 && !createdBanner ? (
        <EmptyState
          icon="vpn_key"
          title="No API keys yet"
          body="Create your first API key to call the endpoint."
          action={
            <Button variant="secondary" icon="add" onClick={onCreateKey}>
              Create key
            </Button>
          }
        />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-start text-xs text-muted">
                  <th scope="col" className="py-2 pe-3 text-start font-semibold">
                    Name
                  </th>
                  <th scope="col" className="py-2 pe-3 text-start font-semibold">
                    Key
                  </th>
                  <th scope="col" className="py-2 pe-3 text-start font-semibold">
                    Created
                  </th>
                  <th scope="col" className="py-2 pe-3 text-start font-semibold">
                    Last used
                  </th>
                  <th scope="col" className="py-2 pe-3 text-end font-semibold">
                    Today
                  </th>
                  <th scope="col" className="py-2 pe-3 text-start font-semibold">
                    On
                  </th>
                  <th scope="col" className="py-2 text-end">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys.map((apiKey) => (
                  <tr key={apiKey.id} className="border-b border-line last:border-b-0">
                    <td className="py-3 pe-3">{renderName(apiKey)}</td>
                    <td className="py-3 pe-3">
                      <code className="font-mono text-[13px] text-muted" dir="ltr">
                        {showValue(apiKey)}
                      </code>
                    </td>
                    <td className="py-3 pe-3 text-muted">
                      {apiKey.createdAt ? new Date(apiKey.createdAt).toLocaleDateString() : "—"}
                    </td>
                    <td className="py-3 pe-3 text-muted">{formatLastUsed(apiKey.lastUsed)}</td>
                    <td className="py-3 pe-3 text-end font-mono text-muted">
                      {formatNumber(apiKey.requestsToday)}
                    </td>
                    <td className="py-3 pe-3">
                      <Toggle
                        size="sm"
                        checked={apiKey.isActive !== false}
                        disabled={togglingId === apiKey.id}
                        onChange={(checked) => onToggleKey(apiKey.id, checked)}
                        aria-label={`Enable key ${apiKey.name}`}
                      />
                    </td>
                    <td className="py-3">
                      <div className="flex items-center justify-end gap-1">
                        <IconButton
                          icon={visibleIds.has(apiKey.id) ? "visibility_off" : "visibility"}
                          aria-label={visibleIds.has(apiKey.id) ? "Hide key" : "Show key"}
                          onClick={() => onToggleVisibility(apiKey.id)}
                        />
                        <IconButton
                          icon={copiedId === apiKey.id ? "check" : "content_copy"}
                          aria-label={`Copy key ${apiKey.name}`}
                          onClick={() => onCopy(apiKey.key, apiKey.id)}
                        />
                        <IconButton
                          icon="delete"
                          aria-label={`Delete key ${apiKey.name}`}
                          loading={deletingId === apiKey.id}
                          onClick={() => onDeleteKey(apiKey.id)}
                          className="hover:text-err"
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="flex flex-col gap-3 md:hidden">
            {keys.map((apiKey) => (
              <div
                key={apiKey.id}
                className="flex flex-col gap-2 rounded-xl border border-line bg-raised p-3"
              >
                {renderName(apiKey)}
                <div className="flex items-center gap-1">
                  <code
                    className="min-w-0 flex-1 truncate font-mono text-[13px] text-muted"
                    dir="ltr"
                  >
                    {showValue(apiKey)}
                  </code>
                  <IconButton
                    icon={visibleIds.has(apiKey.id) ? "visibility_off" : "visibility"}
                    aria-label={visibleIds.has(apiKey.id) ? "Hide key" : "Show key"}
                    onClick={() => onToggleVisibility(apiKey.id)}
                  />
                  <IconButton
                    icon={copiedId === apiKey.id ? "check" : "content_copy"}
                    aria-label={`Copy key ${apiKey.name}`}
                    onClick={() => onCopy(apiKey.key, apiKey.id)}
                  />
                </div>
                <p className="text-xs text-muted">
                  Created {apiKey.createdAt ? new Date(apiKey.createdAt).toLocaleDateString() : "—"}{" "}
                  · {formatLastUsed(apiKey.lastUsed)} · {formatNumber(apiKey.requestsToday)} today
                </p>
                <div className="flex items-center justify-between">
                  <Toggle
                    size="sm"
                    checked={apiKey.isActive !== false}
                    disabled={togglingId === apiKey.id}
                    onChange={(checked) => onToggleKey(apiKey.id, checked)}
                    aria-label={`Enable key ${apiKey.name}`}
                  />
                  <IconButton
                    icon="delete"
                    aria-label={`Delete key ${apiKey.name}`}
                    loading={deletingId === apiKey.id}
                    onClick={() => onDeleteKey(apiKey.id)}
                    className="hover:text-err"
                  />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

ApiKeysCard.propTypes = {
  keys: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      name: PropTypes.string.isRequired,
      key: PropTypes.string.isRequired,
      isActive: PropTypes.bool,
      createdAt: PropTypes.string,
      lastUsed: PropTypes.string,
      requestsToday: PropTypes.number,
    }),
  ).isRequired,
  requireApiKey: PropTypes.bool.isRequired,
  onToggleRequireApiKey: PropTypes.func.isRequired,
  onCreateKey: PropTypes.func.isRequired,
  createdBanner: PropTypes.shape({
    keyName: PropTypes.string.isRequired,
    plainKey: PropTypes.string.isRequired,
  }),
  onDismissBanner: PropTypes.func.isRequired,
  onCopy: PropTypes.func.isRequired,
  copiedId: PropTypes.string,
  visibleIds: PropTypes.instanceOf(Set).isRequired,
  onToggleVisibility: PropTypes.func.isRequired,
  togglingId: PropTypes.string,
  onToggleKey: PropTypes.func.isRequired,
  deletingId: PropTypes.string,
  onDeleteKey: PropTypes.func.isRequired,
  onRenameKey: PropTypes.func.isRequired,
  renamingId: PropTypes.string,
  renameErrors: PropTypes.objectOf(PropTypes.string).isRequired,
  clearRenameError: PropTypes.func.isRequired,
  loading: PropTypes.bool.isRequired,
};
