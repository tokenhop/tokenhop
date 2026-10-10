"use client";

import PropTypes from "prop-types";
import { Fragment, useState } from "react";
import {
  Card,
  Button,
  IconButton,
  SettingRow,
  Toggle,
  EmptyState,
  StatusPill,
  Callout,
} from "@/shared/components";
import {
  maskKey,
  formatPrefix,
  formatLastUsed,
  formatNumber,
  formatExpiry,
  isKeyExpired,
  scopeSummary,
} from "../endpointLogic";
import { groupKeys } from "../keyGroups";
import CopyStatus from "@/shared/components/CopyStatus";
import { LoadingState } from "@/shared/components/StateViews";

import { CreatedBanner, KeyName, MigrationNotice } from "./ApiKeyDetails";
import MoveToWorkspaceButton from "@/shared/components/MoveToWorkspaceButton";

/**
 * API keys management card: require-key gate, one-time reveal banner, key
 * table on desktop and stacked cards on mobile. The create/delete modals live
 * in the parent — this card only fires callbacks.
 *
 * Hashed storage (`hashedMode`): prefix-only rows with no eye/copy
 * affordances, Type/Scope/Expires columns, a one-time migration notice plus a
 * persistent legacy-rotation callout, and a capability-gated Create button
 * (viewers get no affordance). Legacy render is byte-identical to before.
 *
 * @param {object} props
 * @param {Array} props.keys Key rows {id,name,key?,prefix?,type?,legacy?,allowedModels?,expiresAt?,isActive,createdAt,lastUsed,requestsToday}.
 * @param {boolean} props.requireApiKey Toggle state for the 401 gate.
 * @param {(checked: boolean) => void} props.onToggleRequireApiKey
 * @param {() => void} props.onCreateKey Opens the create modal in the parent.
 * @param {{keyName: string, plainKey: string}|null} props.createdBanner Just-created key (one-time).
 * @param {() => void} props.onDismissBanner
 * @param {(text: string, id: string) => void} props.onCopy
 * @param {string|null} props.copiedId
 * @param {Set<string>} props.visibleIds Unmasked key ids (legacy only).
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
 * @param {boolean} [props.hashedMode] Stored-prefix rendering + hashed chrome.
 * @param {boolean} [props.canCreate] Viewer gate for the Create button.
 * @param {boolean} [props.canManage] Hashed-mode gate for rename, pause and delete.
 * @param {string|null} [props.currentUserId] Signed-in user id; enables the My keys / Workspace service keys grouping (hashed multi-user only).
 * @param {string|null} [props.workspaceId] Source workspace for "Move to workspace" (hashed multi-user only).
 * @param {() => void} [props.onMoved] Reload keys after a move.
 * @param {{ visible: boolean, canDismiss: boolean, dismissing: boolean, error: string|null, dismiss: () => void }|null} [props.migrationNotice] Server-flag migration notice state.
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
  copyError,
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
  hashedMode = false,
  canCreate = true,
  canManage = true,
  currentUserId = null,
  migrationNotice = null,
  workspaceId = null,
  onMoved,
}) {
  const [editingId, setEditingId] = useState(null);
  const showValue = (apiKey) =>
    hashedMode
      ? formatPrefix(apiKey.prefix)
      : visibleIds.has(apiKey.id)
        ? apiKey.key
        : maskKey(apiKey.key);
  const canMutate = !hashedMode || canManage;
  const toggleDisabled = (apiKey) =>
    !canMutate || togglingId === apiKey.id || (hashedMode && isKeyExpired(apiKey.expiresAt));
  const renderName = (apiKey) => (
    <KeyName
      apiKey={apiKey}
      editing={editingId === apiKey.id}
      setEditingId={setEditingId}
      loading={renamingId === apiKey.id}
      error={renameErrors[apiKey.id]}
      onRenameKey={onRenameKey}
      clearRenameError={clearRenameError}
      canRename={canMutate}
    />
  );
  const hasLegacy = hashedMode && keys.some((k) => Boolean(k.legacy));
  // Hashed multi-user only: headings need identity attribution; everywhere
  // else the card keeps its single flat list.
  const grouped = hashedMode && currentUserId ? groupKeys(keys, currentUserId) : null;
  const ordered = grouped ? grouped.flatMap((g) => g.rows) : keys;
  const headingOf = new Map(grouped?.filter((g) => g.label).map((g) => [g.rows[0].id, g.label]));

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
          {canCreate && (
            <Button variant="primary" size="sm" icon="add" onClick={onCreateKey}>
              Create key
            </Button>
          )}
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
          copyError={copyError}
          onCopy={onCopy}
          onDismiss={onDismissBanner}
        />
      )}

      {hashedMode && migrationNotice && <MigrationNotice notice={migrationNotice} />}

      {hasLegacy && (
        <div className="mb-4">
          <Callout variant="warn" title="Legacy keys still work but are weaker">
            Create a new key and delete the old one to rotate.
          </Callout>
        </div>
      )}

      <CopyStatus
        copied={copiedId === "created-banner" ? null : copiedId}
        error={copyError === "created-banner" ? null : copyError}
      />
      {loading ? (
        <LoadingState lines={3} label="Loading API keys" className="py-4" />
      ) : keys.length === 0 && !createdBanner ? (
        <EmptyState
          icon="vpn_key"
          title="No API keys yet"
          body="Create your first API key to call the endpoint."
          action={
            canCreate ? (
              <Button variant="secondary" icon="add" onClick={onCreateKey}>
                Create key
              </Button>
            ) : undefined
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
                  {hashedMode && (
                    <>
                      <th scope="col" className="py-2 pe-3 text-start font-semibold">
                        Scope
                      </th>
                      <th scope="col" className="py-2 pe-3 text-start font-semibold">
                        Expires
                      </th>
                    </>
                  )}
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
              {(grouped ?? [{ id: "all", label: null, rows: keys }]).map((group) => (
                <tbody key={group.id}>
                  {group.label && (
                    <tr className="border-b border-line">
                      <th
                        scope="rowgroup"
                        colSpan={9}
                        className="pt-4 pb-1 text-start text-xs font-semibold text-text"
                      >
                        {group.label}
                      </th>
                    </tr>
                  )}
                  {group.rows.map((apiKey) => (
                    <tr key={apiKey.id} className="border-b border-line last:border-b-0">
                      <td className="py-3 pe-3">{renderName(apiKey)}</td>
                      <td className="py-3 pe-3">
                        <code className="font-mono text-[13px] text-muted" dir="ltr">
                          {showValue(apiKey)}
                        </code>
                      </td>
                      {hashedMode && (
                        <>
                          <td className="py-3 pe-3 text-muted">
                            {scopeSummary(apiKey.allowedModels, apiKey.allowedCombos)}
                          </td>
                          <td className="py-3 pe-3 text-muted">{formatExpiry(apiKey.expiresAt)}</td>
                        </>
                      )}
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
                          disabled={toggleDisabled(apiKey)}
                          title={
                            hashedMode && isKeyExpired(apiKey.expiresAt)
                              ? "This key expired"
                              : undefined
                          }
                          onChange={(checked) => onToggleKey(apiKey.id, checked)}
                          aria-label={`Enable key ${apiKey.name}`}
                        />
                      </td>
                      <td className="py-3">
                        <div className="flex items-center justify-end gap-1">
                          {!hashedMode && (
                            <>
                              <IconButton
                                icon={visibleIds.has(apiKey.id) ? "visibility_off" : "visibility"}
                                aria-label={visibleIds.has(apiKey.id) ? "Hide key" : "Show key"}
                                onClick={() => onToggleVisibility(apiKey.id)}
                              />
                              <IconButton
                                icon={
                                  copiedId === apiKey.id
                                    ? "check"
                                    : copyError === apiKey.id
                                      ? "error"
                                      : "content_copy"
                                }
                                aria-label={
                                  copyError === apiKey.id
                                    ? `Couldn't copy key ${apiKey.name}`
                                    : `Copy key ${apiKey.name}`
                                }
                                onClick={() => onCopy(apiKey.key, apiKey.id)}
                              />
                            </>
                          )}
                          {hashedMode && canMutate && (
                            <MoveToWorkspaceButton
                              label={`Move key ${apiKey.name} to another workspace`}
                              items={[
                                {
                                  type: "apiKey",
                                  id: apiKey.id,
                                  label: `API key "${apiKey.name}"`,
                                },
                              ]}
                              sourceWorkspaceId={workspaceId}
                              onMoved={onMoved}
                            />
                          )}
                          {canMutate && (
                            <IconButton
                              icon="delete"
                              aria-label={`Delete key ${apiKey.name}`}
                              loading={deletingId === apiKey.id}
                              onClick={() => onDeleteKey(apiKey.id)}
                              className="hover:text-err"
                            />
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>

          {/* Mobile cards */}
          <div className="flex flex-col gap-3 md:hidden">
            {ordered.map((apiKey) => (
              <Fragment key={apiKey.id}>
                {headingOf.has(apiKey.id) && (
                  <p className="mt-2 text-xs font-semibold text-text">{headingOf.get(apiKey.id)}</p>
                )}
                <div className="flex flex-col gap-2 rounded-xl border border-line bg-raised p-3">
                  {renderName(apiKey)}
                  <div className="flex items-center gap-1">
                    <code
                      className="min-w-0 flex-1 truncate font-mono text-[13px] text-muted"
                      dir="ltr"
                    >
                      {showValue(apiKey)}
                    </code>
                    {!hashedMode && (
                      <>
                        <IconButton
                          icon={visibleIds.has(apiKey.id) ? "visibility_off" : "visibility"}
                          aria-label={visibleIds.has(apiKey.id) ? "Hide key" : "Show key"}
                          onClick={() => onToggleVisibility(apiKey.id)}
                        />
                        <IconButton
                          icon={
                            copiedId === apiKey.id
                              ? "check"
                              : copyError === apiKey.id
                                ? "error"
                                : "content_copy"
                          }
                          aria-label={
                            copyError === apiKey.id
                              ? `Couldn't copy key ${apiKey.name}`
                              : `Copy key ${apiKey.name}`
                          }
                          onClick={() => onCopy(apiKey.key, apiKey.id)}
                        />
                      </>
                    )}
                  </div>
                  {hashedMode && (
                    <p className="text-xs text-muted">
                      {scopeSummary(apiKey.allowedModels, apiKey.allowedCombos)} · Expires{" "}
                      {formatExpiry(apiKey.expiresAt)}
                    </p>
                  )}
                  <p className="text-xs text-muted">
                    Created{" "}
                    {apiKey.createdAt ? new Date(apiKey.createdAt).toLocaleDateString() : "—"} ·{" "}
                    {formatLastUsed(apiKey.lastUsed)} · {formatNumber(apiKey.requestsToday)} today
                  </p>
                  <div className="flex items-center justify-between">
                    <Toggle
                      size="sm"
                      checked={apiKey.isActive !== false}
                      disabled={toggleDisabled(apiKey)}
                      title={
                        hashedMode && isKeyExpired(apiKey.expiresAt)
                          ? "This key expired"
                          : undefined
                      }
                      onChange={(checked) => onToggleKey(apiKey.id, checked)}
                      aria-label={`Enable key ${apiKey.name}`}
                    />
                    {hashedMode && canMutate && (
                      <MoveToWorkspaceButton
                        label={`Move key ${apiKey.name} to another workspace`}
                        items={[
                          { type: "apiKey", id: apiKey.id, label: `API key "${apiKey.name}"` },
                        ]}
                        sourceWorkspaceId={workspaceId}
                        onMoved={onMoved}
                      />
                    )}
                    {canMutate && (
                      <IconButton
                        icon="delete"
                        aria-label={`Delete key ${apiKey.name}`}
                        loading={deletingId === apiKey.id}
                        onClick={() => onDeleteKey(apiKey.id)}
                        className="hover:text-err"
                      />
                    )}
                  </div>
                </div>
              </Fragment>
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
      key: PropTypes.string,
      prefix: PropTypes.string,
      type: PropTypes.string,
      userId: PropTypes.string,
      legacy: PropTypes.oneOfType([PropTypes.bool, PropTypes.number]),
      allowedModels: PropTypes.arrayOf(PropTypes.string),
      allowedCombos: PropTypes.arrayOf(PropTypes.string),
      expiresAt: PropTypes.string,
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
  copyError: PropTypes.string,
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
  hashedMode: PropTypes.bool,
  canCreate: PropTypes.bool,
  canManage: PropTypes.bool,
  currentUserId: PropTypes.string,
  workspaceId: PropTypes.string,
  onMoved: PropTypes.func,
  migrationNotice: PropTypes.shape({
    visible: PropTypes.bool.isRequired,
    canDismiss: PropTypes.bool.isRequired,
    dismissing: PropTypes.bool.isRequired,
    error: PropTypes.string,
    dismiss: PropTypes.func.isRequired,
  }),
};
