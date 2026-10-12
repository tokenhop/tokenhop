// YAN-373: pure draft <-> payload helpers for the six SSO group-policy keys.

export const ROLE_OPTIONS = [
  { value: "pending", label: "Pending approval" },
  { value: "user", label: "User" },
];

export const MAP_ROLE_OPTIONS = [
  { value: "manager", label: "Manager" },
  { value: "member", label: "Member" },
  { value: "viewer", label: "Viewer" },
];

let rowSeq = 0;
export function nextRowId() {
  rowSeq += 1;
  return rowSeq;
}

/** Editable form state derived from the server settings object. */
export function toDraft(settings) {
  const map = Array.isArray(settings.ssoGroupWorkspaceMap) ? settings.ssoGroupWorkspaceMap : [];
  return {
    groupsClaim:
      typeof settings.ssoGroupsClaim === "string" && settings.ssoGroupsClaim
        ? settings.ssoGroupsClaim
        : "groups",
    samlGroupsAttribute:
      typeof settings.samlAttributeGroups === "string" && settings.samlAttributeGroups
        ? settings.samlAttributeGroups
        : "groups",
    allowedGroupsText: (Array.isArray(settings.ssoAllowedGroups)
      ? settings.ssoAllowedGroups
      : []
    ).join("\n"),
    adminGroupsText: (Array.isArray(settings.ssoAdminGroups) ? settings.ssoAdminGroups : []).join(
      "\n",
    ),
    defaultRole: settings.ssoDefaultRole === "user" ? "user" : "pending",
    map: map.map((entry) => ({
      id: `row-${nextRowId()}`,
      group: typeof entry.group === "string" ? entry.group : "",
      workspaceId: typeof entry.workspaceId === "string" ? entry.workspaceId : "",
      role: MAP_ROLE_OPTIONS.some((o) => o.value === entry.role) ? entry.role : "member",
    })),
  };
}

/** Draft → the exact six-key policy object (the PATCH body and preview payload). */
export function toPayload(draft) {
  const splitLines = (text) =>
    String(text || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  return {
    ssoGroupsClaim: draft.groupsClaim.trim(),
    samlAttributeGroups: draft.samlGroupsAttribute.trim(),
    ssoAllowedGroups: splitLines(draft.allowedGroupsText),
    ssoAdminGroups: splitLines(draft.adminGroupsText),
    ssoDefaultRole: draft.defaultRole,
    ssoGroupWorkspaceMap: draft.map.map(({ group, workspaceId, role }) => ({
      group: group.trim(),
      workspaceId,
      role,
    })),
  };
}

/** Client-side shape check shared by Save and Preview. Returns "" when valid. */
export function validatePayload(payload) {
  if (!payload.ssoGroupsClaim) return "The OIDC groups claim cannot be empty.";
  if (!payload.samlAttributeGroups) return "The SAML groups attribute cannot be empty.";
  if (payload.ssoGroupWorkspaceMap.some((e) => !e.group || !e.workspaceId)) {
    return "Every mapping needs a group and a workspace.";
  }
  return "";
}
