"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import Button from "./Button";
import Callout from "./Callout";
import Select from "./Select";
import Checkbox from "./Checkbox";
import { Spinner } from "./Loading";
import {
  confirmWarningsOf,
  issueDetailsText,
  moveCapabilities,
  moveConflictOf,
  moveErrorMessage,
  moveItemKey,
  moveTargets,
  requestMove,
} from "@/shared/utils/workspaceMove";

/**
 * Short name for rows the caller only partially knows (browsing a 500-row
 * catalog: "400 more" stays honest, never "400 others not shown").
 */
function shortLine(item) {
  if (item.type === "connection") return item.label || "1 connection";
  if (item.type === "node") return item.label || "1 provider node";
  if (item.type === "combo") return item.label || "1 combo";
  if (item.type === "alias") return `alias "${item.id}"`;
  if (item.type === "customModel") return `custom model "${item.id}"`;
  if (item.type === "disabledModel") return `disabled models for "${item.id}"`;
  return item.label || "1 API key";
}

function PreviewItem({ icon, conflict, issue, labels }) {
  const named = { ...issue, label: labels.get(moveItemKey(issue)) || issue.label };
  // Server details are objects (e.g. {count}); only safe text renders.
  const detailsText = issueDetailsText(issue);
  const tone = conflict ? "text-err" : issue.code === "GRANTS_REVOKED" ? "text-warn" : "text-muted";
  return (
    <li className="flex items-start gap-2 text-sm">
      <span className={`material-symbols-outlined shrink-0 text-[18px] ${tone}`} aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="font-medium text-text">{shortLine(named)}</span>
        <span className="block text-xs text-muted">{issue.message}</span>
        {detailsText ? (
          <span className="mt-0.5 block text-xs whitespace-pre-line text-muted">{detailsText}</span>
        ) : null}
      </span>
    </li>
  );
}

PreviewItem.propTypes = {
  icon: PropTypes.string.isRequired,
  conflict: PropTypes.bool.isRequired,
  issue: PropTypes.object.isRequired,
  labels: PropTypes.instanceOf(Map).isRequired,
};

/**
 * Shared move-items-between-workspaces dialog (YAN-701). Reuses Modal.
 * Flow: pick target → preview (never mutates) → conflicts block, warnings need an explicit
 * checkbox → Move sends confirm:true.
 */
export default function MoveToWorkspaceDialog({
  isOpen,
  onClose,
  view,
  sourceWorkspaceId,
  sourceName,
  items,
  onMoved,
}) {
  // Callers pass fresh arrays every render; key on content so a parent
  // re-render never resets an open dialog.
  const itemsKey = items.map(moveItemKey).join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: itemsKey is the content key for items
  const caps = useMemo(() => moveCapabilities(items), [itemsKey]);
  const targets = useMemo(
    () => moveTargets(view, sourceWorkspaceId, caps),
    [view, sourceWorkspaceId, caps],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: itemsKey is the content key for items
  const labels = useMemo(() => new Map(items.map((i) => [moveItemKey(i), i.label])), [itemsKey]);
  const [targetId, setTargetId] = useState("");
  const [phase, setPhase] = useState("pick"); // pick | previewing | confirm | submitting
  const [conflicts, setConflicts] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [movingWarnings, setMovingWarnings] = useState([]); // preview-fresh confirm set
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset runs on open or when the item set changes; setters are stable
  useEffect(() => {
    if (!isOpen) return;
    setTargetId("");
    setPhase("pick");
    setConflicts([]);
    setWarnings([]);
    setMovingWarnings([]);
    setAcknowledged(false);
    setError("");
  }, [isOpen, sourceWorkspaceId, itemsKey]);

  // Default the target to the first eligible workspace.
  useEffect(() => {
    if (isOpen && phase === "pick" && !targets.some((w) => w.id === targetId) && targets.length) {
      setTargetId(targets[0].id);
    }
  }, [isOpen, phase, targetId, targets]);

  const targetName = targets.find((w) => w.id === targetId)?.name || "";
  const busy = phase === "previewing" || phase === "submitting";
  const moveCount = items.length;
  const needsAck = movingWarnings.length > 0;
  const moveDisabled = busy || !targetId || conflicts.length > 0 || (needsAck && !acknowledged);

  const preview = async (id) => {
    if (!id || busy) return;
    requestRef.current += 1;
    const myRequest = requestRef.current;
    setPhase("previewing");
    setError("");
    setAcknowledged(false);
    try {
      const { ok, status, data } = await requestMove(sourceWorkspaceId, {
        targetWorkspaceId: id,
        items: items.map(({ type, id: itemId }) => ({ type, id: itemId })),
        preview: true,
      });
      if (requestRef.current !== myRequest || !isOpen) return;
      if (!ok) {
        setPhase("pick");
        setError(
          status === 403
            ? "You can't move these items into that workspace."
            : "Could not check this move. Try again.",
        );
        return;
      }
      setConflicts(data?.conflicts || []);
      setWarnings(data?.warnings || []);
      setMovingWarnings(data?.warnings || []);
      setPhase("confirm");
    } catch {
      if (requestRef.current !== myRequest || !isOpen) return;
      setPhase("pick");
      setError("Could not check this move. Try again.");
    }
  };

  const move = async () => {
    if (moveDisabled) return;
    requestRef.current += 1;
    const myRequest = requestRef.current;
    setPhase("submitting");
    setError("");
    try {
      const { ok, status, data } = await requestMove(sourceWorkspaceId, {
        targetWorkspaceId: targetId,
        items: items.map(({ type, id: itemId }) => ({ type, id: itemId })),
        preview: false,
        confirm: true,
      });
      if (requestRef.current !== myRequest || !isOpen) return;
      if (!ok) {
        const raced = confirmWarningsOf(data);
        if (raced) {
          // Warnings changed since the preview: show the fresh set and make
          // the user acknowledge again before anything moves.
          setWarnings(raced);
          setMovingWarnings(raced);
          setAcknowledged(false);
          setPhase("confirm");
          setError("Something changed since the check. Review the updated list and confirm again.");
          return;
        }
        const clash = moveConflictOf(data);
        if (status === 409 && clash) {
          setConflicts(clash);
          setAcknowledged(false);
          setPhase("confirm");
          return;
        }
        setPhase("confirm");
        setError(moveErrorMessage(status));
        return;
      }
      onMoved?.(data?.moved);
      onClose?.();
    } catch {
      if (requestRef.current !== myRequest || !isOpen) return;
      setPhase("confirm");
      setError("Could not move these items. Try again.");
    }
  };

  const close = () => {
    if (busy) return;
    requestRef.current += 1;
    onClose?.();
  };

  const title = moveCount === 1 ? `Move ${shortLine(items[0])}` : `Move ${moveCount} items`;

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      title={title}
      size="lg"
      description={`From ${sourceName || "this workspace"}. History stays with the original workspace.`}
      closeOnOverlay={!busy}
      closeOnEscape={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          {phase === "confirm" ? (
            <Button
              variant="primary"
              icon="sync_alt"
              onClick={move}
              loading={phase === "submitting"}
              disabled={moveDisabled}
            >
              {needsAck ? "Move and apply changes" : "Move"}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => preview(targetId)}
              loading={phase === "previewing"}
              disabled={!targetId || busy}
            >
              Check move
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2 rounded-xl border border-line bg-raised px-3 py-2 text-sm">
          <span
            className="material-symbols-outlined shrink-0 text-[18px] text-muted"
            aria-hidden="true"
          >
            group
          </span>
          <span className="min-w-0 truncate text-muted">
            {sourceName || "This workspace"}
            <span
              className="material-symbols-outlined mx-1 align-middle text-[16px] rtl:-scale-x-100"
              aria-hidden="true"
            >
              arrow_forward
            </span>
            <span className="font-medium text-text">
              {phase === "confirm" && targetName ? targetName : "choose a workspace"}
            </span>
          </span>
        </div>

        {targets.length === 0 ? (
          <Callout variant="warn" title="No workspace to move into">
            You manage no other workspace that accepts these items.
          </Callout>
        ) : (
          <Select
            label="Move to"
            value={targetId}
            onChange={(e) => {
              const next = e.target.value;
              setTargetId(next);
              if (phase === "confirm") {
                setPhase("pick");
                setConflicts([]);
                setWarnings([]);
                setMovingWarnings([]);
                setAcknowledged(false);
                setError("");
              }
            }}
            options={targets.map((w) => ({
              value: w.id,
              label: `${w.name}${w.kind === "personal" ? " (personal)" : ""}`,
            }))}
            placeholder="Choose a workspace"
            disabled={busy}
          />
        )}

        {phase === "previewing" ? (
          <p className="flex items-center gap-2 text-sm text-muted" role="status">
            <Spinner size="sm" /> Checking for name clashes and broken links…
          </p>
        ) : null}

        {phase === "confirm" ? (
          <div className="flex flex-col gap-3" aria-live="polite">
            {conflicts.length > 0 ? (
              <Callout
                variant="err"
                title={`${conflicts.length} clash${conflicts.length === 1 ? "" : "es"} block this move`}
              >
                <ul className="mt-2 flex flex-col gap-2">
                  {conflicts.map((issue) => (
                    <PreviewItem
                      key={`c-${moveItemKey(issue)}-${issue.code}`}
                      icon="error"
                      conflict
                      issue={issue}
                      labels={labels}
                    />
                  ))}
                </ul>
                <p className="mt-2 text-xs">Rename in either workspace, or move fewer items.</p>
              </Callout>
            ) : (
              <p className="flex items-center gap-2 text-sm text-ok" role="status">
                <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                  check_circle
                </span>
                No clashes — {moveCount === 1 ? "this item" : `all ${moveCount} items`} can move.
              </p>
            )}

            {warnings.length > 0 ? (
              <Callout variant="warn" title="Review before moving">
                <ul className="mt-2 flex flex-col gap-2">
                  {warnings.map((issue) => (
                    <PreviewItem
                      key={`w-${moveItemKey(issue)}-${issue.code}`}
                      icon="warning"
                      conflict={false}
                      issue={issue}
                      labels={labels}
                    />
                  ))}
                </ul>
                <Checkbox
                  className="mt-3"
                  checked={acknowledged}
                  onChange={setAcknowledged}
                  disabled={busy}
                  label="I understand these changes"
                  description="Access, links or provider terms listed above change when the move completes."
                />
              </Callout>
            ) : null}

            <p className="text-xs text-muted">
              Usage and request history stays with {sourceName || "the original workspace"}.
            </p>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-lg bg-err-bg px-3 py-2 text-sm text-err">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

MoveToWorkspaceDialog.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  /** accountView(status) — supplies target list and capability checks. */
  view: PropTypes.shape({
    active: PropTypes.bool,
    workspaces: PropTypes.array,
    can: PropTypes.func,
  }),
  sourceWorkspaceId: PropTypes.string,
  sourceName: PropTypes.string,
  /** [{ type, id, label? }]; id per type contract (alias name, customModel key, providerAlias). */
  items: PropTypes.arrayOf(
    PropTypes.shape({
      type: PropTypes.oneOf([
        "connection",
        "node",
        "combo",
        "alias",
        "customModel",
        "disabledModel",
        "apiKey",
      ]).isRequired,
      id: PropTypes.string.isRequired,
      label: PropTypes.string,
    }),
  ).isRequired,
  /** Called with the server `moved` list after success; caller refreshes. */
  onMoved: PropTypes.func,
};
