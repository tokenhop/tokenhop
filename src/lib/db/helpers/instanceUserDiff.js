// YAN-375: identity guard for full-instance imports. Read-only: compares the
// backup's users with the live users and refuses a different-user restore
// unless an owner forces it. Diffs carry identity metadata only (id, email,
// username, role) — never hashes, tokens or any other column. Malformed
// entries are skipped here; the full preflight validator rejects them.

const pub = (u) => ({
  id: u.id,
  email: u.email ?? null,
  username: u.username ?? null,
  instanceRole: u.instanceRole ?? null,
});
const norm = (v) => (v == null ? null : String(v).toLowerCase());

function guardError(code, message, diff) {
  const error = Object.assign(new Error(message), { code });
  if (diff) error.diff = diff;
  return error;
}

/**
 * @param {object} db Adapter (sync API).
 * @param {object} payload Import snapshot.
 * @param {{force?: boolean, actor?: {instanceRole?: string}}} [opts]
 *   actor must come from the authenticated session, never from the payload.
 * @returns {{diff: {onlyInBackup: object[], onlyInInstance: object[], roleChanged: object[]}|null, forced: boolean}}
 * @throws {Error} code FORBIDDEN | IMPORT_USER_MISMATCH (.diff)
 */
export function assertInstanceUsersMatch(db, payload, { force = false, actor } = {}) {
  if (!payload || !Array.isArray(payload.users) || !(payload.formatVersion >= 2)) {
    return { diff: null, forced: false };
  }
  if (force === true && actor?.instanceRole !== "owner") {
    throw guardError("FORBIDDEN", "Forced user replacement requires the instance owner");
  }

  const live = new Map(
    db.all("SELECT id, email, username, instanceRole FROM users").map((u) => [u.id, u]),
  );
  // Empty destination: nothing to protect, any backup users may land.
  if (live.size === 0) return { diff: null, forced: false };

  const diff = { onlyInBackup: [], onlyInInstance: [], roleChanged: [] };
  const seen = new Set();
  for (const b of payload.users) {
    if (!b || typeof b !== "object" || typeof b.id !== "string" || !b.id) continue;
    seen.add(b.id);
    const l = live.get(b.id);
    if (!l) {
      diff.onlyInBackup.push(pub(b));
    } else if (norm(l.email) !== norm(b.email) || norm(l.username) !== norm(b.username)) {
      // Same id, different person: both sides are reported.
      diff.onlyInBackup.push(pub(b));
      diff.onlyInInstance.push(pub(l));
    } else if (l.instanceRole !== b.instanceRole) {
      diff.roleChanged.push({ ...pub(b), previousInstanceRole: l.instanceRole });
    }
  }
  for (const l of live.values()) {
    if (!seen.has(l.id)) diff.onlyInInstance.push(pub(l));
  }

  const differs = diff.onlyInBackup.length || diff.onlyInInstance.length || diff.roleChanged.length;
  if (!differs) return { diff: null, forced: false };
  if (!force) {
    throw guardError(
      "IMPORT_USER_MISMATCH",
      "Backup users differ from this instance's users",
      diff,
    );
  }
  return { diff, forced: true };
}
