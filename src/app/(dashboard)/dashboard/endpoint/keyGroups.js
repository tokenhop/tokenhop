/**
 * Hashed multi-user grouping: the caller's own keys, workspace service keys,
 * then every other user's key (managers only receive those). Empty groups are
 * dropped and every row lands in exactly one group. Without a known user the
 * list stays one unlabelled group, exactly as before.
 * @param {Array<{userId?: string|null, type?: string}>} keys
 * @param {string|null} currentUserId
 * @returns {Array<{id: string, label: string|null, rows: Array}>}
 */
export function groupKeys(keys, currentUserId) {
  if (!currentUserId) return [{ id: "all", label: null, rows: keys }];
  const mine = [];
  const service = [];
  const other = [];
  for (const k of keys) {
    if (k.userId === currentUserId) mine.push(k);
    else if (k.type === "service" || k.userId == null) service.push(k);
    else other.push(k);
  }
  return [
    { id: "mine", label: "My keys", rows: mine },
    { id: "service", label: "Workspace service keys", rows: service },
    { id: "other", label: "Other users' keys", rows: other },
  ].filter((g) => g.rows.length > 0);
}
