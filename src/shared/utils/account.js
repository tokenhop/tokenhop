/**
 * Pure account view for the multi-user chrome (YAN-371). No React or DOM.
 * Every new header, sidebar, nav and settings element keys on `view.active`,
 * so a single-user install renders exactly as before.
 */

import { can as principalCan } from "@/lib/users/principal";
import { translate } from "@/i18n/runtime";

/**
 * Display label for an instance role, translated at call time (literal
 * translate() calls so scripts/i18n-literals.mjs catalogs them). Unknown
 * roles fall back to "User".
 * @param {string} [role]
 * @returns {string}
 */
export function roleLabel(role) {
  if (role === "owner") return translate("Owner");
  if (role === "admin") return translate("Admin");
  return translate("User");
}

/**
 * Adapt the `/api/auth/status` principal to the shape the pure `can()` takes.
 * @param {object} [principal]
 * @returns {{ instanceRole: string, workspaceIds: string[],
 *   workspaceRoles: Record<string, string>, activeWorkspaceId: string|null }}
 */
export function toCapabilityPrincipal(principal) {
  const workspaces = Array.isArray(principal?.workspaces) ? principal.workspaces : [];
  return {
    instanceRole: principal?.role,
    workspaceIds: workspaces.map((w) => w.id),
    workspaceRoles: Object.fromEntries(workspaces.map((w) => [w.id, w.role])),
    activeWorkspaceId: principal?.activeWorkspaceId ?? null,
  };
}

/** Personal workspace first, then shared ones by name. */
function sortWorkspaces(list) {
  return [...list].sort((a, b) => {
    if ((a.kind === "personal") !== (b.kind === "personal")) return a.kind === "personal" ? -1 : 1;
    return String(a.name).localeCompare(String(b.name));
  });
}

const INACTIVE = Object.freeze({ active: false });

/**
 * Everything the account chrome needs, derived from an auth status payload.
 * Inactive (switch off, not enforced, anonymous) returns `{ active: false }`
 * with no `can`, so callers cannot gate on it by accident.
 * @param {object} [status] `/api/auth/status` payload.
 * @returns {{ active: false } | {
 *   active: true, name: string, email: string, roleLabel: string,
 *   loginMethod: string, workspaces: object[], activeWorkspace: object|null,
 *   can: (capability: string, workspaceId?: string|null) => boolean }}
 */
export function accountView(status) {
  const principal = status?.principal;
  if (status?.multiUserActive !== true || !principal?.user) return INACTIVE;
  const user = principal.user;
  const cap = toCapabilityPrincipal(principal);
  const workspaces = sortWorkspaces(
    Array.isArray(principal.workspaces) ? principal.workspaces : [],
  );
  const activeWorkspace = workspaces.find((w) => w.id === principal.activeWorkspaceId) || null;
  return {
    active: true,
    name: user.displayName || user.username || user.email || "Account",
    email: user.email || "",
    roleLabel: roleLabel(principal.role),
    loginMethod: status.loginMethod || "Password",
    workspaces,
    activeWorkspace,
    can: (capability, workspaceId = cap.activeWorkspaceId) =>
      principalCan(cap, capability, { workspaceId }),
  };
}

/** Initials for the avatar: first letters of up to two words. */
export function initialsOf(name) {
  const words = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}
