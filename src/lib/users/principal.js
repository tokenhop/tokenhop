// The request principal (YAN-353; ADR-0002/0004). YAN-355 builds it per
// request; YAN-357 replaces the `can` stub with the capability matrix.

/**
 * @typedef {"owner"|"admin"|"user"|"pending"} InstanceRole
 * @typedef {object} Principal
 * @property {string} userId
 * @property {InstanceRole} instanceRole
 * @property {string[]} workspaceIds Workspaces the user belongs to.
 * @property {string|null} activeWorkspaceId
 * @property {string} [apiKeyId] Set when the request came in with a gateway key.
 * @property {"session"|"apiKey"|"cli"|"local"} via
 */

/**
 * Whether `principal` may exercise `capability` on `resource`. Pure.
 * ponytail: owner-only stub (deny everyone else); YAN-357 fills in the
 * ADR-0002 role → capability matrix. Nothing calls this yet.
 * @param {Principal|null|undefined} principal
 * @param {string} _capability e.g. "workspace.members.manage"
 * @param {{ workspaceId?: string }} [_resource]
 * @returns {boolean}
 */
export function can(principal, _capability, _resource) {
  return principal?.instanceRole === "owner";
}
