/**
 * Shared admin load guards (YAN-373): role/status row pills, the hidden (404)
 * vs denied (403) terminal states, and the generic error view. The nav hides
 * these pages while Users & teams is off; `hidden` is belt and suspenders.
 */
"use client";

import PropTypes from "prop-types";
import StatusPill from "@/shared/components/StatusPill";
import EmptyState from "@/shared/components/EmptyState";
import { ErrorState } from "@/shared/components/StateViews";
import { roleLabel } from "@/shared/utils/account";
import { ROLE_VARIANTS, adminLoadCopy, statusVariant, userSummary } from "../adminView";

/** Instance role pill, translated at render time. */
export function RolePill({ role }) {
  const fallback = roleLabel(role);
  return (
    <StatusPill variant={ROLE_VARIANTS[role] || "neutral"} size="sm">
      {role === "pending" ? "Pending approval" : fallback}
    </StatusPill>
  );
}

RolePill.propTypes = { role: PropTypes.string.isRequired };

/** Instance status pill. */
export function StatusBadge({ status }) {
  return (
    <StatusPill variant={statusVariant(status)} size="sm">
      {status === "active" ? "Active" : status === "disabled" ? "Disabled" : String(status || "—")}
    </StatusPill>
  );
}

StatusBadge.propTypes = { status: PropTypes.string.isRequired };

export function userName(user) {
  return userSummary(user);
}

/**
 * Render contract for admin data loaders. Server responses decide everything:
 * 404 -> hidden copy (switch off) on LIST pages (the route layout already
 * `notFound()`s there), so DETAIL pages never render it: their route loader
 * never runs while the switch is off. A detail 404 therefore means the item
 * is gone (or was never reachable by this principal — no distinction leaks).
 * 403 -> no access, other failure -> error with retry. The client never
 * checks `multiUserActive`: a fresh install has one user, and the owner must
 * reach these pages to invite the second.
 */
export function AdminGuard({ loadState, error, onRetry, gone, children }) {
  if (loadState === "hidden" || loadState === "denied") {
    const copy = adminLoadCopy(loadState);
    return <EmptyState icon="lock" title={copy.title} body={copy.body} />;
  }
  if (loadState === "gone") {
    return <EmptyState icon={gone.icon} title={gone.title} body={gone.body} action={gone.action} />;
  }
  if (loadState === "error") {
    return (
      <ErrorState
        title="Could not load this view"
        message={error || "Something went wrong while loading."}
        onRetry={onRetry}
      />
    );
  }
  return children;
}

AdminGuard.propTypes = {
  loadState: PropTypes.oneOf(["hidden", "denied", "gone", "error", null]),
  gone: PropTypes.shape({
    icon: PropTypes.string,
    title: PropTypes.string,
    body: PropTypes.string,
    action: PropTypes.node,
  }),
  error: PropTypes.string,
  onRetry: PropTypes.func,
  children: PropTypes.node,
};
