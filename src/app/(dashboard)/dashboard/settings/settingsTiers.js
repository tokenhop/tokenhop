/**
 * Three-tier settings layout (YAN-371): My account / Workspace / Instance.
 * Inactive (single-user, switch off) returns the legacy groups and sections
 * untouched, so the page renders exactly as before.
 */
import { SETTINGS_GROUPS, SETTINGS_SECTIONS } from "./registry";

/** Kept outside SETTINGS_SECTIONS so legacy search and the palette are unchanged. */
export const ACCOUNT_SECTION = {
  id: "account",
  title: "My account",
  subtitle: "Your profile, sign-ins and sessions.",
  icon: "person",
  rows: [
    { key: "profile", label: "Profile", keywords: "name email role" },
    { key: "password", label: "Password", keywords: "change password" },
    { key: "identities", label: "Linked sign-ins", keywords: "sso oidc saml unlink identity" },
    { key: "sessions", label: "Sign out everywhere", keywords: "sessions devices logout" },
    { key: "apiKeys", label: "API keys", keywords: "keys gateway" },
  ],
};

const ACCOUNT_GROUP = {
  id: "account",
  title: "My account",
  icon: "person",
  sections: ["account", "general", "about"],
};
const WORKSPACE_GROUP = {
  id: "workspace",
  title: "Workspace",
  icon: "groups",
  sections: ["routing", "token-saver", "providers"],
};
const INSTANCE_GROUP = {
  id: "instance",
  title: "Instance",
  icon: "admin_panel_settings",
  sections: [
    "security",
    "sso",
    "reliability",
    "network",
    "logs",
    "pricing",
    "data",
    "environment",
    "danger",
  ],
};

/**
 * Groups and sections the viewer may see.
 * @param {{ active: boolean, can?: (cap: string) => boolean }} view `accountView(status)`.
 * @returns {{ groups: object[], sections: object[], canManageInstance: boolean }}
 */
export function layoutFor(view) {
  if (!view?.active) {
    return { groups: SETTINGS_GROUPS, sections: SETTINGS_SECTIONS, canManageInstance: true };
  }
  const canManageInstance = view.can("instance.settings.manage");
  const groups = [
    ACCOUNT_GROUP,
    ...(view.can("workspace.preferences.manage") ? [WORKSPACE_GROUP] : []),
    ...(canManageInstance ? [INSTANCE_GROUP] : []),
  ];
  const visible = new Set(groups.flatMap((group) => group.sections));
  const sections = [ACCOUNT_SECTION, ...SETTINGS_SECTIONS].filter((s) => visible.has(s.id));
  return { groups, sections, canManageInstance };
}
