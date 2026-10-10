/**
 * Client helpers for moving items between workspaces (YAN-701).
 * Pure except `requestMove`; the dialog and entry points wrap these.
 * Contract: POST /api/workspaces/:sourceId/move (preview, then confirm).
 */

const CONNECTIONS = "workspace.connections.manage";
const COMBOS = "workspace.combos.manage";
const KEYS = "workspace.keys.manage";

/** Capability the user needs in BOTH workspaces, per item type. */
const CAPABILITY = {
  connection: CONNECTIONS,
  node: CONNECTIONS,
  combo: COMBOS,
  alias: COMBOS,
  customModel: COMBOS,
  disabledModel: COMBOS,
  apiKey: KEYS,
};

/** @param {{type: string}[]} items @returns {string[]} distinct capabilities */
export function moveCapabilities(items) {
  return [...new Set((items || []).map((item) => CAPABILITY[item.type]).filter(Boolean))];
}

/** Stable React/Set key for one movable item. */
export const moveItemKey = (item) => `${item.type}:${item.id}`;

/**
 * Workspaces the user may move into: everything except the source where the
 * user holds every needed capability.
 * @param {{active: boolean, workspaces?: object[], can?: Function}} view accountView()
 * @param {string|null} sourceId
 * @param {string[]} capabilities from {@link moveCapabilities}
 */
export function moveTargets(view, sourceId, capabilities) {
  if (!view?.active || !sourceId || capabilities.length === 0) return [];
  return (view.workspaces || []).filter(
    (ws) => ws.id !== sourceId && capabilities.every((cap) => view.can(cap, ws.id)),
  );
}

/** True when the user may move these items out of `sourceId` and has a target. */
export function canMoveItems(view, sourceId, items) {
  const caps = moveCapabilities(items);
  if (!view?.active || !sourceId || caps.length === 0) return false;
  if (!caps.every((cap) => view.can(cap, sourceId))) return false;
  return moveTargets(view, sourceId, caps).length > 0;
}

/**
 * POST one move request. Resolves `{ ok, status, data }`; rejects only on a
 * network failure.
 * @param {string} sourceId
 * @param {{targetWorkspaceId: string, items: {type: string, id: string}[], preview?: boolean, confirm?: boolean}} body
 */
export async function requestMove(sourceId, body) {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(sourceId)}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

/** Plain-language message for a failed request (server codes are never shown). */
export function moveErrorMessage(status) {
  if (status === 403) return "You can't manage these items in both workspaces.";
  if (status === 404) return "That workspace isn't available. Reload the page and try again.";
  if (status === 400) return "These items can't be moved. Reload the page and try again.";
  if (status === 413) return "Too many items selected. Move fewer at a time.";
  if (status === 503) return "Workspace keys are temporarily unavailable. Try again later.";
  return "Could not move these items. Try again.";
}

/**
 * Guarded details line for a preview conflict/warning. The server sends
 * `details` as an object (`{ count: n }`); rendering it raw crashes React,
 * so only safe primitives and known count shapes become text.
 * @param {{ code?: string, details?: unknown }} [issue]
 * @returns {string|null}
 */
export function issueDetailsText(issue) {
  const details = issue?.details;
  if (details == null) return null;
  if (typeof details === "string") return details;
  if (typeof details === "number" || typeof details === "boolean") return String(details);
  if (typeof details === "object") {
    const { count } = details;
    if (typeof count === "number" && Number.isFinite(count)) {
      const plural = (one, many) => (count === 1 ? one : many);
      if (issue?.code === "GRANTS_REVOKED")
        return plural("1 active grant", `${count} active grants`);
      if (issue?.code === "COMBO_REF_NOT_MOVING")
        return plural("1 item stays behind", `${count} items stay behind`);
      if (issue?.code === "KEY_COMBO_REF")
        return plural("1 key stays behind", `${count} keys stay behind`);
      if (issue?.code === "COMBO_REFERENCED_BY_STAYING")
        return plural(
          "1 combo stays behind and references it",
          `${count} combos stay behind and reference it`,
        );
      return plural("1 affected", `${count} affected`);
    }
    return null; // unknown object shape: never render raw
  }
  return null;
}

/**
 * Conflicts from a failed move response, or null. Matches the route contract
 * `{ error: "Move has conflicts", code: "move_conflict", conflicts }`.
 */
export function moveConflictOf(data) {
  if (data?.code === "move_conflict" && Array.isArray(data.conflicts)) return data.conflicts;
  return null;
}

/**
 * Fresh warnings from a `confirm_required` race (another change landed
 * between preview and move), or null. Matches the route contract
 * `{ error: "Move needs confirmation", code: "confirm_required", warnings }`.
 */
export function confirmWarningsOf(data) {
  if (data?.code === "confirm_required" && Array.isArray(data.warnings)) return data.warnings;
  return null;
}
