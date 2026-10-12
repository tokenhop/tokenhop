"use client";

import PropTypes from "prop-types";
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Callout,
  Card,
  CopyStatus,
  EmptyState,
  Input,
  LoadingState,
  SectionCard,
  Select,
} from "@/shared/components";
import { copyTextToClipboard } from "@/shared/components/formPrimitives";
import StatusPill from "@/shared/components/StatusPill";
import { ConfirmDialog } from "@/shared/components/Modal";
import { createInvitation, listInvitations, revokeInvitation } from "@/shared/utils/adminApi";
import { INVITE_VARIANTS, formatWhen } from "../../adminView";
import {
  INVITE_STATE_LABELS,
  WORKSPACE_ROLE_OPTIONS,
  inviteLink,
  workspaceRoleLabel,
} from "./workspaceView";

/**
 * One-time banner. The link lives only in this component's state until
 * dismissed; it is never written to storage, the URL or the console.
 */
function InviteBanner({ link, onDismiss }) {
  const [status, setStatus] = useState({ copied: null, error: null });

  const copy = async () => {
    try {
      await copyTextToClipboard(link);
      setStatus({ copied: "invite", error: null });
    } catch {
      setStatus({ copied: null, error: "invite" });
    }
  };

  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-xl border border-lime/40 bg-lime-bg p-4"
    >
      <p className="text-sm font-semibold text-text">
        Invitation created. Copy the link now — it won&apos;t be shown again.
      </p>
      <code className="block break-all font-mono text-xs text-text" dir="ltr">
        {link}
      </code>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" icon="content_copy" onClick={copy}>
          Copy link
        </Button>
        <Button variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
        <CopyStatus copied={status.copied} error={status.error} id="invite" />
      </div>
    </div>
  );
}

InviteBanner.propTypes = {
  link: PropTypes.string.isRequired,
  onDismiss: PropTypes.func.isRequired,
};

/**
 * Invitation list and create form. Raw token handling: the POST response
 * token becomes a hash-based link in local state and is dropped on dismiss.
 * @param {{ workspaceId: string, onTerminal: (err: Error) => void }} props
 */
export default function InvitationsPanel({ workspaceId, onTerminal }) {
  const [invitations, setInvitations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState("member");
  const [email, setEmail] = useState("");
  const [link, setLink] = useState("");
  const [revoking, setRevoking] = useState(null);
  // Revoke failures render inside the open dialog (a panel error would sit behind the modal).
  const [revokeError, setRevokeError] = useState("");

  const fail = useCallback(
    (err, fallback) => {
      if ([403, 404].includes(err?.status)) onTerminal(err);
      else setError(err?.message || fallback);
    },
    [onTerminal],
  );

  const reload = useCallback(async () => {
    try {
      const body = await listInvitations(workspaceId);
      setInvitations(Array.isArray(body.invitations) ? body.invitations : []);
    } catch (err) {
      fail(err, "Failed to load invitations.");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, fail]);

  useEffect(() => {
    reload();
  }, [reload]);

  const onCreate = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const input = email.trim() ? { role, email: email.trim() } : { role };
      const body = await createInvitation(workspaceId, input);
      setLink(inviteLink(body.token));
      setEmail("");
      await reload();
    } catch (err) {
      fail(err, "Could not create the invitation.");
    } finally {
      setBusy(false);
    }
  };

  const closeRevoke = () => {
    setRevoking(null);
    setRevokeError("");
  };

  const confirmRevoke = async () => {
    setBusy(true);
    setRevokeError("");
    try {
      await revokeInvitation(workspaceId, revoking.id);
      closeRevoke();
      await reload();
    } catch (err) {
      if ([403, 404].includes(err?.status)) onTerminal(err);
      else setRevokeError(err?.message || "Could not revoke the invitation.");
    } finally {
      setBusy(false);
    }
  };

  const revokeButton = (invitation) =>
    invitation.state === "live" ? (
      <Button
        variant="ghost"
        icon="block"
        aria-label={`Revoke invitation for ${invitation.email || workspaceRoleLabel(invitation.role)}`}
        onClick={() => {
          setRevokeError("");
          setRevoking(invitation);
        }}
      >
        Revoke
      </Button>
    ) : null;

  return (
    <Card padding="none">
      <SectionCard
        icon="mail"
        title="Invitations"
        subtitle="Single-use links that add someone to this workspace."
        className="border-0 shadow-none"
      />
      <div className="flex flex-col gap-4 px-5 pb-5">
        {link ? <InviteBanner link={link} onDismiss={() => setLink("")} /> : null}
        {error ? (
          <Callout variant="err" title="Invitation failed">
            {error}
          </Callout>
        ) : null}

        <form onSubmit={onCreate} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Select
            label="Role"
            options={WORKSPACE_ROLE_OPTIONS}
            placeholder={null}
            value={role}
            onChange={(event) => setRole(event.target.value)}
          />
          <Input
            label="Email (optional)"
            type="email"
            className="min-w-0 flex-1"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Button type="submit" icon="link" loading={busy}>
            Create invitation
          </Button>
        </form>

        {loading ? (
          <LoadingState label="Loading invitations" lines={3} />
        ) : invitations.length === 0 ? (
          <EmptyState
            icon="mail"
            title="No invitations"
            body="Created invitations are listed here."
            compact
          />
        ) : (
          <ul className="divide-y divide-line">
            {invitations.map((invitation) => (
              <li
                key={invitation.id}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
                    <span className="break-all">{invitation.email || "Any email"}</span>
                    <StatusPill variant={INVITE_VARIANTS[invitation.state] || "neutral"} size="sm">
                      {INVITE_STATE_LABELS[invitation.state] || String(invitation.state)}
                    </StatusPill>
                  </p>
                  <p className="text-xs text-muted">
                    {workspaceRoleLabel(invitation.role)} · created{" "}
                    {formatWhen(invitation.createdAt)} · expires {formatWhen(invitation.expiresAt)}
                  </p>
                </div>
                {revokeButton(invitation)}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        isOpen={Boolean(revoking)}
        onClose={closeRevoke}
        error={revokeError || undefined}
        onConfirm={confirmRevoke}
        title="Revoke invitation"
        message="Revoke this invitation? Its link stops working immediately."
        confirmText="Revoke"
      />
    </Card>
  );
}

InvitationsPanel.propTypes = {
  workspaceId: PropTypes.string.isRequired,
  onTerminal: PropTypes.func.isRequired,
};
