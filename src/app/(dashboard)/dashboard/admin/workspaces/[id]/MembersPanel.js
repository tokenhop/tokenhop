"use client";

import PropTypes from "prop-types";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Callout,
  Card,
  EmptyState,
  LoadingState,
  Select,
  SectionCard,
} from "@/shared/components";
import { TABLE_HEAD_CELL, TABLE_HEAD_ROW } from "@/shared/components/displayPrimitives";
import StatusPill from "@/shared/components/StatusPill";
import { ConfirmDialog } from "@/shared/components/Modal";
import {
  addMember,
  listMembers,
  listUsers,
  removeMember,
  setMemberRole,
} from "@/shared/utils/adminApi";
import { formatWhen } from "../../adminView";
import {
  WORKSPACE_ROLE_OPTIONS,
  pickerLabel,
  readonlyReason,
  workspaceRoleLabel,
} from "./workspaceView";

const PICKER_PAGE_SIZE = 100;
const memberName = (member) =>
  member.displayName || member.username || member.email || member.userId;

/** Role cell: editable select, or a pill plus the reason it is locked. */
function RoleCell({ member, busy, onChange }) {
  const reason = readonlyReason(member);
  if (!reason) {
    return (
      <Select
        aria-label={`Role for ${memberName(member)}`}
        options={WORKSPACE_ROLE_OPTIONS}
        value={member.role}
        placeholder={null}
        disabled={busy}
        onChange={(event) => onChange(member, event.target.value)}
      />
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <StatusPill variant="neutral" size="sm">
        {workspaceRoleLabel(member.role)}
      </StatusPill>
      <p className="text-xs text-muted">
        {reason === "idp"
          ? "Managed by your identity provider (SSO sync). Change it there."
          : "The workspace owner role can't be changed here."}
      </p>
    </div>
  );
}

RoleCell.propTypes = {
  member: PropTypes.shape({
    userId: PropTypes.string.isRequired,
    role: PropTypes.string.isRequired,
    source: PropTypes.string,
    displayName: PropTypes.string,
  }).isRequired,
  busy: PropTypes.bool.isRequired,
  onChange: PropTypes.func.isRequired,
};

/**
 * Member list plus add form for one workspace. Authorization is the server's:
 * 403/404 from any call is passed up through `onTerminal(status)`.
 * @param {{ workspaceId: string, onTerminal: (err: Error) => void }} props
 */
export default function MembersPanel({ workspaceId, onTerminal }) {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(null);
  // Remove failures render inside the open dialog (a panel error would sit behind the modal).
  const [removeError, setRemoveError] = useState("");
  const [users, setUsers] = useState([]);
  const [usersPage, setUsersPage] = useState(0);
  const [usersTotal, setUsersTotal] = useState(0);
  const [usersError, setUsersError] = useState("");
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState("member");

  const fail = useCallback(
    (err, fallback) => {
      if ([403, 404].includes(err?.status)) onTerminal(err);
      else setError(err?.message || fallback);
    },
    [onTerminal],
  );

  const reload = useCallback(async () => {
    try {
      const body = await listMembers(workspaceId);
      setMembers(Array.isArray(body.members) ? body.members : []);
    } catch (err) {
      fail(err, "Failed to load members.");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, fail]);

  useEffect(() => {
    reload();
  }, [reload]);

  const loadMoreUsers = useCallback(async (page) => {
    setUsersError("");
    try {
      const body = await listUsers({ page, pageSize: PICKER_PAGE_SIZE });
      // Strict Mode double-mounts the effect: merge by id so page 1 never
      // lands twice, and any repeated "load more" is idempotent.
      setUsers((prev) => {
        const byId = new Map(prev.map((u) => [u.id, u]));
        for (const u of body.users || []) byId.set(u.id, u);
        return [...byId.values()];
      });
      setUsersTotal(body.pagination?.totalItems ?? 0);
    } catch (err) {
      setUsersError(err?.message || "Could not load users. Paste a user ID instead.");
    }
  }, []);

  useEffect(() => {
    setUsersPage(1);
    loadMoreUsers(1);
  }, [loadMoreUsers]);

  const loadMore = () => {
    const next = usersPage + 1;
    setUsersPage(next);
    loadMoreUsers(next);
  };

  const candidates = useMemo(() => {
    const taken = new Set(members.map((member) => member.userId));
    return users.filter((user) => !taken.has(user.id));
  }, [users, members]);

  const mutate = async (fn, fallback) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await reload();
      return true;
    } catch (err) {
      fail(err, fallback);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onAdd = async (event) => {
    event.preventDefault();
    const id = userId.trim();
    if (!id) return;
    if (await mutate(() => addMember(workspaceId, { userId: id, role }), "Could not add member.")) {
      setUserId("");
    }
  };

  const onRole = (member, next) =>
    mutate(() => setMemberRole(workspaceId, member.userId, next), "Could not change the role.");

  const closeRemove = () => {
    setRemoving(null);
    setRemoveError("");
  };

  const confirmRemove = async () => {
    setRemoveError("");
    setBusy(true);
    try {
      await removeMember(workspaceId, removing.userId);
      closeRemove();
      await reload();
    } catch (err) {
      if ([403, 404].includes(err?.status)) onTerminal(err);
      else setRemoveError(err?.message || "Could not remove member.");
    } finally {
      setBusy(false);
    }
  };

  const removeButton = (member) =>
    member.source === "idp" ? null : (
      <Button
        variant="ghost"
        icon="remove"
        disabled={busy}
        aria-label={`Remove ${memberName(member)}`}
        onClick={() => {
          setRemoveError("");
          setRemoving(member);
        }}
      >
        Remove
      </Button>
    );

  const canLoadMore = users.length < usersTotal;

  return (
    <Card padding="none">
      <SectionCard
        icon="group"
        title="Members"
        subtitle="Who can use this workspace and in which role."
        className="border-0 shadow-none"
      />
      <div className="flex flex-col gap-4 px-5 pb-5">
        {error ? (
          <Callout variant="err" title="Member change failed">
            {error}
          </Callout>
        ) : null}

        <form onSubmit={onAdd} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          {usersError || users.length === 0 ? (
            <div className="min-w-0 flex-1">
              <label className="mb-1 block text-sm font-medium text-text" htmlFor="member-user-id">
                User ID
              </label>
              <input
                id="member-user-id"
                className="h-11 w-full rounded-lg border border-line bg-raised px-3 text-[16px] text-text sm:text-sm"
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
                dir="ltr"
                autoComplete="off"
              />
              {usersError ? <p className="mt-1 text-xs text-muted">{usersError}</p> : null}
            </div>
          ) : (
            <Select
              label="User"
              className="min-w-0 flex-1"
              placeholder="Choose a user"
              options={candidates.map((user) => ({ value: user.id, label: pickerLabel(user) }))}
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
            />
          )}
          <Select
            label="Role"
            options={WORKSPACE_ROLE_OPTIONS}
            placeholder={null}
            value={role}
            onChange={(event) => setRole(event.target.value)}
          />
          <Button type="submit" icon="person" loading={busy} disabled={!userId.trim()}>
            Add member
          </Button>
        </form>
        {canLoadMore ? (
          <Button variant="ghost" size="sm" className="self-start" onClick={loadMore}>
            Load more users ({users.length} of {usersTotal})
          </Button>
        ) : null}

        {loading ? (
          <LoadingState label="Loading members" lines={3} />
        ) : members.length === 0 ? (
          <EmptyState icon="group" title="No members" body="Add a member above." compact />
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block custom-scrollbar">
              <table className="w-full min-w-[640px] text-sm" aria-label="Workspace members">
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    {["Member", "Role", "Added", "Actions"].map((label) => (
                      <th
                        key={label}
                        scope="col"
                        className={`${TABLE_HEAD_CELL} px-3 py-3 text-start`}
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {members.map((member) => (
                    <tr
                      key={member.userId}
                      className="border-b border-line last:border-0 align-top"
                    >
                      <td className="max-w-[240px] px-3 py-3">
                        <p className="truncate font-medium text-text">{memberName(member)}</p>
                        {member.source === "idp" ? (
                          <StatusPill variant="info" size="sm">
                            SSO
                          </StatusPill>
                        ) : null}
                      </td>
                      <td className="px-3 py-3">
                        <RoleCell member={member} busy={busy} onChange={onRole} />
                      </td>
                      <td className="px-3 py-3 text-muted">{formatWhen(member.createdAt)}</td>
                      <td className="px-3 py-3">{removeButton(member)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="divide-y divide-line md:hidden">
              {members.map((member) => (
                <li key={member.userId} className="flex flex-col gap-2 py-3">
                  <p className="break-words font-medium text-text">{memberName(member)}</p>
                  <RoleCell member={member} busy={busy} onChange={onRole} />
                  <p className="text-xs text-muted">Added {formatWhen(member.createdAt)}</p>
                  {removeButton(member)}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <ConfirmDialog
        isOpen={Boolean(removing)}
        onClose={closeRemove}
        onConfirm={confirmRemove}
        error={removeError || undefined}
        title="Remove member"
        message={`Remove ${removing ? memberName(removing) : ""} from this workspace? They lose access immediately.`}
        confirmText="Remove"
      />
    </Card>
  );
}

MembersPanel.propTypes = {
  workspaceId: PropTypes.string.isRequired,
  onTerminal: PropTypes.func.isRequired,
};
