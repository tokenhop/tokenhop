/**
 * Pure provider-detail helpers for the Signal redesign (YAN-297).
 *
 * Pure module: no React, no imports from src/. Mirrors the current detail page
 * semantics: reorder renumbers every priority, share falls back to an equal
 * split when all weights are exhausted, and a blank sticky limit inherits the
 * global strategy default.
 */

/**
 * Move the connection at `fromIndex` to `toIndex` and renumber priorities
 * 1-based. The server (`reorderInTx`) renumbers to dense 1..n on every
 * priority PUT, so the client must persist 1-based values to match.
 * Out-of-range moves return the original array unchanged.
 * @param {Array<object>} connections
 * @param {number} fromIndex
 * @param {number} toIndex
 * @returns {Array<object>}
 */
export function reorderConnections(connections, fromIndex, toIndex) {
  if (!Array.isArray(connections)) return connections;
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return connections;
  if (fromIndex < 0 || fromIndex >= connections.length) return connections;
  if (toIndex < 0 || toIndex >= connections.length) return connections;
  if (fromIndex === toIndex) return connections;
  const next = [...connections];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next.map((connection, index) => ({ ...connection, priority: index + 1 }));
}

/**
 * Simulate the server renumber (`reorderInTx` in connectionsRepo.js) for one
 * priority PUT: rows sort by (priority asc, updatedAt desc) and are renumbered
 * dense 1..n. Processing PUTs strictly in send order (sequential persistence)
 * makes the final server order deterministic; concurrent PUTs can arrive in
 * any order and scramble ties, which is why the client must await each PUT.
 * @param {Array<{id: string, priority: number, updatedAt?: string}>} rows
 * @param {string} id
 * @param {number} priority
 * @param {string} updatedAt ISO timestamp of this PUT
 * @returns {Array<{id: string, priority: number, updatedAt?: string}>}
 */
export function applyServerPriorityPut(rows, id, priority, updatedAt) {
  const next = rows.map((row) => (row.id === id ? { ...row, priority, updatedAt } : row));
  const sorted = [...next].sort((a, b) => {
    const diff = (a.priority || 0) - (b.priority || 0);
    if (diff !== 0) return diff;
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
  return sorted.map((row, index) => ({ ...row, priority: index + 1 }));
}

/**
 * Connection ids in persisted priority order (missing priorities sort last).
 * @param {Array<object>} connections
 * @returns {Array<string>}
 */
export function connectionIdsInPriorityOrder(connections) {
  return sortByPriority(connections).map((connection) => connection.id);
}

/**
 * Resolve a drag-and-drop move in priority order. DnD items are rendered in
 * priority order, so indices are taken from that order (not the fetch order).
 * @param {Array<object>} connections
 * @param {string} activeId
 * @param {string} overId
 * @returns {{fromIndex: number, toIndex: number} | null}
 */
export function dragMoveIndices(connections, activeId, overId) {
  if (!activeId || !overId || activeId === overId) return null;
  const ordered = connectionIdsInPriorityOrder(connections);
  const fromIndex = ordered.indexOf(activeId);
  const toIndex = ordered.indexOf(overId);
  if (fromIndex === -1 || toIndex === -1) return null;
  return { fromIndex, toIndex };
}

/**
 * Connections sorted by persisted priority (missing priorities sort last).
 * @param {Array<object>} connections
 * @returns {Array<object>}
 */
export function sortByPriority(connections) {
  return [...(connections || [])].sort(
    (a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * Approximate traffic share for one active connection. Mirrors weighted
 * fail-open: when no active peer has positive weight, every active peer gets an
 * equal share.
 * @param {{weight?: number}|null} effectiveWeight
 * @param {number} totalWeight
 * @param {number} activeCount
 * @returns {number}
 */
export function weightSharePct(effectiveWeight, totalWeight, activeCount) {
  if (!(totalWeight > 0)) return 100 / Math.max(1, activeCount);
  const weight = Math.max(0, effectiveWeight?.weight || 0);
  return (weight / totalWeight) * 100;
}

/**
 * Remaining cooldown text from an ISO timestamp, matching the detail page.
 * @param {string|number|Date} until
 * @returns {string}
 */
export function formatCooldownRemaining(until) {
  const diff = new Date(until).getTime() - Date.now();
  if (!(diff > 0)) return "";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/**
 * Blank is valid (weighted auto / round-robin default). Otherwise integer 1..100.
 * @param {string|number|null|undefined} stickyLimit
 * @returns {string}
 */
export function stickyLimitError(stickyLimit) {
  if (stickyLimit === "" || stickyLimit == null) return "";
  const limit = Number(stickyLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return "Sticky limit must be a whole number between 1 and 100.";
  }
  return "";
}

/**
 * Bulk-selection state transitions for detail-page connections.
 * @param {Array<string>} selectedIds
 * @param {{type: string, id?: string, allIds?: Array<string>, existingIds?: Array<string>}} action
 * @returns {Array<string>}
 */
export function selectionReducer(selectedIds, action) {
  const selected = Array.isArray(selectedIds) ? selectedIds : [];
  switch (action?.type) {
    case "toggle": {
      if (!action.id) return selected;
      return selected.includes(action.id)
        ? selected.filter((id) => id !== action.id)
        : [...selected, action.id];
    }
    case "select-all": {
      const allIds = Array.isArray(action.allIds) ? action.allIds : [];
      const allSelected = allIds.length > 0 && allIds.every((id) => selected.includes(id));
      return allSelected ? [] : [...allIds];
    }
    case "clear":
      return [];
    case "prune": {
      const existing = new Set(action.existingIds || []);
      return selected.filter((id) => existing.has(id));
    }
    default:
      return selected;
  }
}
