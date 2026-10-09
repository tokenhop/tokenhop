"use client";

import PropTypes from "prop-types";
import { useState } from "react";
import { IconButton } from "@/shared/components";
import useAuthStatus from "@/shared/hooks/useAuthStatus";
import { accountView } from "@/shared/utils/account";
import OwnerBadge from "./OwnerBadge";
import ShareDialog from "./ShareDialog";

const ADMIN_ROLES = new Set(["owner", "admin"]);

/**
 * Per-connection sharing affordances (YAN-376): creator badge plus a Share
 * action for callers who may grant from the connection's workspace. Renders
 * nothing while multi-user is inactive, so single-user rows are unchanged.
 */
export default function ConnectionSharing({ connection, onShared }) {
  const status = useAuthStatus();
  const view = accountView(status);
  const [open, setOpen] = useState(false);
  if (!view.active) return null;

  const canShare = view.can("workspace.grants.manage", connection.workspaceId);
  const label = connection.name || connection.email || "connection";
  return (
    <>
      <OwnerBadge name={connection.createdByDisplayName} />
      {canShare && (
        <IconButton
          icon="share"
          aria-label={`Share ${label}`}
          className="size-7"
          onClick={() => setOpen(true)}
        />
      )}
      {canShare && (
        <ShareDialog
          isOpen={open}
          onClose={() => setOpen(false)}
          connection={connection}
          workspaces={view.workspaces}
          userId={status.principal?.user?.id ?? null}
          isInstanceAdmin={ADMIN_ROLES.has(status.principal?.role)}
          onShared={onShared}
        />
      )}
    </>
  );
}

ConnectionSharing.propTypes = {
  connection: PropTypes.shape({
    id: PropTypes.string.isRequired,
    workspaceId: PropTypes.string,
    name: PropTypes.string,
    email: PropTypes.string,
    createdByDisplayName: PropTypes.string,
  }).isRequired,
  onShared: PropTypes.func,
};
