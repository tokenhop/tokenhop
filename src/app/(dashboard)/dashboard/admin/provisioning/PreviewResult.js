"use client";

// YAN-373: in-memory render of the one-shot preview result. What a NEW
// sign-in under the previewed draft policy would get; the signed-in admin's
// own account is never touched by a preview.

import PropTypes from "prop-types";
import { formatWhen } from "../adminView";
import { RolePill } from "../components/AdminShared";

export function PreviewResult({ result }) {
  const totalGroups = result.totalGroups;
  const shown = result.groups.length;
  const groupsTitle =
    shown === 0
      ? "Groups returned by the identity provider (none)"
      : totalGroups > shown
        ? `Groups returned by the identity provider (first ${shown} of ${totalGroups})`
        : `Groups returned by the identity provider (${shown})`;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Evaluated at {formatWhen(result.evaluatedAt)} using your {result.provider} identity. This
        shows what a NEW user signing in with these groups would get under the draft policy. Your
        account keeps its current role and access: a preview never changes it.
      </p>

      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold">{groupsTitle}</p>
        <p className="text-xs text-muted">
          Source: {result.groupsSource === "userinfo" ? "Userinfo endpoint" : "ID token"} ·{" "}
          {totalGroups} total
        </p>
        {shown === 0 ? (
          <p className="text-sm text-muted">
            The identity provider returned no groups. Every group rule below evaluates to a miss.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1" aria-label="Groups from the identity provider">
            {result.groups.map((group) => (
              <li
                key={group}
                className="rounded-full border border-line bg-raised/40 px-2 py-0.5 text-xs text-text"
              >
                {group}
              </li>
            ))}
          </ul>
        )}
      </div>

      <dl className="flex flex-col divide-y divide-line">
        <div className="flex items-center justify-between gap-4 py-2 text-sm">
          <dt className="text-muted">Sign-in decision</dt>
          <dd>{result.admit ? "Admitted" : "Denied"}</dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-2 text-sm">
          <dt className="text-muted">Admin groups</dt>
          <dd>{result.adminMatch ? "Matched" : "No match"}</dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-2 text-sm">
          <dt className="text-muted">New account role</dt>
          <dd>{result.wouldProvisionRole ? <RolePill role={result.wouldProvisionRole} /> : "—"}</dd>
        </div>
      </dl>

      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold">Workspace memberships</p>
        {result.memberships.length === 0 ? (
          <p className="text-sm text-muted">No groups matched a workspace mapping.</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Workspace memberships">
            {result.memberships.map((m) => (
              <li
                key={`${m.workspaceId}-${m.role}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-line bg-raised/40 px-3 py-2 text-sm"
              >
                <span className="min-w-0 truncate">{m.workspaceId}</span>
                <span className="text-muted">{m.role}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

PreviewResult.propTypes = {
  result: PropTypes.shape({
    provider: PropTypes.string,
    groupsSource: PropTypes.string,
    groups: PropTypes.arrayOf(PropTypes.string).isRequired,
    totalGroups: PropTypes.number.isRequired,
    admit: PropTypes.bool.isRequired,
    adminMatch: PropTypes.bool.isRequired,
    wouldProvisionRole: PropTypes.string,
    memberships: PropTypes.arrayOf(
      PropTypes.shape({ workspaceId: PropTypes.string, role: PropTypes.string }),
    ).isRequired,
    evaluatedAt: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  }).isRequired,
};
