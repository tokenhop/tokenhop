"use client";

import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import Button from "./Button";
import IconButton from "./IconButton";
import MoveToWorkspaceDialog from "./MoveToWorkspaceDialog";
import useAuthStatus from "@/shared/hooks/useAuthStatus";
import { accountView } from "@/shared/utils/account";
import { canMoveItems } from "@/shared/utils/workspaceMove";

/**
 * "Move to workspace" trigger plus its dialog (YAN-701). Renders nothing
 * unless multi-user is active and the caller can manage these items in the
 * source workspace and at least one other workspace.
 *
 * @param {object} props
 * @param {{type: string, id: string, label?: string}[]} props.items
 * @param {string|null} [props.sourceWorkspaceId] Defaults to the active workspace.
 * @param {"icon"|"button"|"stack"} [props.variant="icon"] stack = icon over a 10px caption (connection rows).
 * @param {string} [props.label] Visible/accessible name, e.g. `Move "work-key"`.
 * @param {() => void} [props.onMoved] Refresh the surrounding list.
 */
export default function MoveToWorkspaceButton({
  items,
  sourceWorkspaceId,
  variant = "icon",
  label = "Move to workspace",
  className,
  onMoved,
}) {
  const status = useAuthStatus();
  const view = useMemo(() => accountView(status), [status]);
  const [open, setOpen] = useState(false);
  const sourceId = sourceWorkspaceId || (view.active ? view.activeWorkspace?.id : null) || null;
  if (!view.active || !canMoveItems(view, sourceId, items)) return null;
  const sourceName = view.workspaces.find((w) => w.id === sourceId)?.name;

  let trigger;
  if (variant === "button") {
    trigger = (
      <Button
        size="sm"
        variant="secondary"
        icon="sync_alt"
        onClick={() => setOpen(true)}
        className={className}
      >
        {label}
      </Button>
    );
  } else if (variant === "stack") {
    trigger = (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={label}
        className={
          className ||
          "flex flex-col items-center rounded px-2 py-1 text-muted hover:text-text focus-visible:shadow-focus focus-visible:outline-none"
        }
      >
        <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
          sync_alt
        </span>
        <span className="text-[10px] leading-tight">Move</span>
      </button>
    );
  } else {
    trigger = (
      <IconButton
        icon="sync_alt"
        label={label}
        className={className}
        onClick={() => setOpen(true)}
      />
    );
  }

  return (
    <>
      {trigger}
      <MoveToWorkspaceDialog
        isOpen={open}
        onClose={() => setOpen(false)}
        view={view}
        sourceWorkspaceId={sourceId}
        sourceName={sourceName}
        items={items}
        onMoved={() => onMoved?.()}
      />
    </>
  );
}

MoveToWorkspaceButton.propTypes = {
  items: PropTypes.arrayOf(
    PropTypes.shape({
      type: PropTypes.string.isRequired,
      id: PropTypes.string.isRequired,
      label: PropTypes.string,
    }),
  ).isRequired,
  sourceWorkspaceId: PropTypes.string,
  variant: PropTypes.oneOf(["icon", "button", "stack"]),
  label: PropTypes.string,
  className: PropTypes.string,
  onMoved: PropTypes.func,
};
