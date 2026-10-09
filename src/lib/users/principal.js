// The request principal (YAN-353; ADR-0002/0004) and the fixed role →
// capability map (YAN-357). Pure: no imports, it sits in the proxy bundle.

/**
 * @typedef {"owner"|"admin"|"user"|"pending"} InstanceRole
 * @typedef {"owner"|"manager"|"member"|"viewer"} WorkspaceRole
 * @typedef {object} Principal
 * @property {string} userId
 * @property {InstanceRole} instanceRole
 * @property {string[]} workspaceIds Workspaces the user belongs to.
 * @property {Record<string, WorkspaceRole>} [workspaceRoles] Membership role per workspace id.
 * @property {string|null} activeWorkspaceId
 * @property {string} [apiKeyId] Set when the request came in with a gateway key.
 * @property {"session"|"apiKey"|"cli"|"local"} via
 */

const INSTANCE_ADMIN = [
  "instance.users.manage",
  "instance.hostOps",
  "instance.settings.manage",
  "instance.budgets.raise",
  "instance.audit.read",
];
const INSTANCE_OWNER = [...INSTANCE_ADMIN, "instance.ownership.transfer", "instance.keys.rotate"];

// Workspace role → capabilities inside that workspace.
const WS_VIEWER = ["workspace.budgets.read", "workspace.usage.read"];
const WS_MEMBER = [...WS_VIEWER, "workspace.connections.use", "workspace.keys.create"];
const WS_MANAGER = [
  ...WS_MEMBER,
  "workspace.members.manage",
  "workspace.connections.manage",
  "workspace.connections.metadata.read",
  "workspace.grants.manage",
  "workspace.keys.manage",
  "workspace.combos.manage",
  "workspace.budgets.lower",
  "workspace.preferences.manage",
  "workspace.audit.read",
];

// Instance owner/admin: oversight in every workspace (never secrets or use;
// audit rows are redacted at write, so reading them is oversight, YAN-376)…
const ADMIN_ANY_WORKSPACE = new Set([
  "workspace.connections.metadata.read",
  "workspace.grants.manage",
  "workspace.budgets.read",
  "workspace.usage.read",
  "workspace.audit.read",
]);
// …and management in the workspaces they belong to (ADR-0002 `x*`).
const ADMIN_MEMBER_WORKSPACE = new Set(
  WS_MANAGER.filter((c) => c !== "workspace.connections.use" && !ADMIN_ANY_WORKSPACE.has(c)),
);

const INSTANCE_CAPS = { owner: new Set(INSTANCE_OWNER), admin: new Set(INSTANCE_ADMIN) };
const WORKSPACE_CAPS = {
  owner: new Set(WS_MANAGER),
  manager: new Set(WS_MANAGER),
  member: new Set(WS_MEMBER),
  viewer: new Set(WS_VIEWER),
};

/** Every capability the route table may name (ADR-0002, plus `self.session`). */
export const CAPABILITIES = Object.freeze([
  ...INSTANCE_OWNER,
  ...WS_MANAGER,
  "gateway.use",
  "self.session",
]);
const KNOWN = new Set(CAPABILITIES);

/**
 * Whether `principal` may exercise `capability` on `resource` (ADR-0002). Pure.
 * Workspace capabilities need `resource.workspaceId`, except the admin
 * oversight ones. `pending` and unknown capabilities are always denied.
 * `workspace.connections.use` in another user's personal workspace is never
 * granted: nobody else is a member of it.
 * @param {Principal|null|undefined} principal
 * @param {string} capability e.g. "workspace.members.manage"
 * @param {{ workspaceId?: string|null }} [resource]
 * @returns {boolean}
 */
export function can(principal, capability, resource = {}) {
  const role = principal?.instanceRole;
  if (!KNOWN.has(capability) || !role || role === "pending") return false;
  if (capability.startsWith("instance.")) return INSTANCE_CAPS[role]?.has(capability) === true;
  if (!capability.startsWith("workspace.")) return true; // gateway.use, self.session
  const admin = role === "owner" || role === "admin";
  if (admin && ADMIN_ANY_WORKSPACE.has(capability)) return true;
  const wsRole = resource?.workspaceId ? principal.workspaceRoles?.[resource.workspaceId] : null;
  if (!wsRole) return false;
  if (admin && ADMIN_MEMBER_WORKSPACE.has(capability)) return true;
  return WORKSPACE_CAPS[wsRole]?.has(capability) === true;
}
