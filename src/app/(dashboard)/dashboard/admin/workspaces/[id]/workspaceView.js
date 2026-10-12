/**
 * Pure helpers for the admin workspace detail page (YAN-373).
 * No authorization logic: the server owns every allow/deny decision.
 */

/** Roles an admin may grant by hand; `owner` rows are bootstrap-only. */
export const WORKSPACE_ROLE_OPTIONS = [
  { value: "manager", label: "Manager" },
  { value: "member", label: "Member" },
  { value: "viewer", label: "Viewer" },
];

export const INVITE_STATE_LABELS = {
  live: "Live",
  consumed: "Used",
  revoked: "Revoked",
  expired: "Expired",
};

/** Label for a workspace role; unknown roles pass through. */
export function workspaceRoleLabel(role) {
  const hit = WORKSPACE_ROLE_OPTIONS.find((option) => option.value === role);
  if (hit) return hit.label;
  return role === "owner" ? "Owner" : String(role ?? "");
}

/**
 * Rows the admin cannot edit here: SSO-synced rows (the IdP owns them) and the
 * bootstrap owner row. The server still rejects these; this only explains why.
 * @param {{ source?: string, role?: string }} member
 * @returns {"idp"|"owner"|null}
 */
export function readonlyReason(member) {
  if (member?.source === "idp") return "idp";
  if (member?.role === "owner") return "owner";
  return null;
}

/**
 * Invite link for a freshly minted raw token. The token sits in the URL hash
 * so browsers never send it to the server or in a Referer header.
 * @param {string} token
 * @param {string} [origin]
 */
export function inviteLink(token, origin) {
  const base = origin || (typeof window !== "undefined" ? window.location.origin : "");
  return `${base}/invite#token=${encodeURIComponent(token)}`;
}

/** One-line picker label: name plus email when known. */
export function pickerLabel(user) {
  const name = user?.displayName || user?.username || user?.email || user?.id;
  const extra = user?.email && user.email !== name ? ` — ${user.email}` : "";
  return `${name}${extra}${user?.status === "disabled" ? " (disabled)" : ""}`;
}
