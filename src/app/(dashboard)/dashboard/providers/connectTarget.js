/**
 * Connect-flow workspace target (YAN-376). The server defaults new API-key
 * connections to Default and OAuth ones to the personal workspace, so the
 * dashboard always names the workspace explicitly while multi-user is active.
 */

/**
 * Workspaces the caller may add connections to.
 * @param {{active: boolean, workspaces?: Array, can?: Function}} view accountView()
 * @returns {Array<{id: string, name: string}>}
 */
export function manageableWorkspaces(view) {
  if (!view?.active) return [];
  return (view.workspaces || []).filter((w) => view.can("workspace.connections.manage", w.id));
}

/**
 * Default target: the active workspace when manageable, else the first one.
 * @returns {string|null}
 */
export function defaultTarget(view) {
  const list = manageableWorkspaces(view);
  const activeId = view?.activeWorkspace?.id;
  return list.find((w) => w.id === activeId)?.id ?? list[0]?.id ?? null;
}

/**
 * Append `workspaceId` to a connect URL; no target keeps the legacy URL.
 * @param {string} url
 * @param {string|null} workspaceId
 * @returns {string}
 */
export function withWorkspace(url, workspaceId) {
  if (!workspaceId) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}workspaceId=${encodeURIComponent(workspaceId)}`;
}
