// Pure SSO provisioning primitives. Deliberately import-free: protocol modules
// (oidc/saml) reuse the group reader/normalizer, and the transactional stage
// layers sync seams on top without pulling protocol/network code back in.

export const GROUPS_MAX_ENTRIES = 100;
export const GROUP_NAME_MAX_LENGTH = 256;
const GROUP_CLAIM_MAX_DEPTH = 5;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const ROLE_RANK = { viewer: 1, member: 2, manager: 3 };

const ABSENT = { present: false, groups: null, invalid: false };
const INVALID = { present: false, groups: null, invalid: true };

/**
 * Normalizes a group claim value: a scalar string or an array of strings.
 * Exact case-sensitive names are kept, deduplicated, and capped at
 * GROUPS_MAX_ENTRIES entries of at most GROUP_NAME_MAX_LENGTH chars.
 * Non-string, empty, oversize, and unsafe-name entries
 * (`__proto__`/`constructor`/`prototype`) are dropped, never coerced or
 * CSV-split. Any other top-level shape is invalid.
 * @param {string|string[]} value
 * @returns {{ groups: string[]|null, invalid: boolean }}
 */
export function normalizeGroups(value) {
  const entries = typeof value === "string" ? [value] : value;
  if (!Array.isArray(entries)) return { groups: null, invalid: true };
  const groups = [];
  for (const entry of entries) {
    if (groups.length >= GROUPS_MAX_ENTRIES) break;
    if (typeof entry !== "string" || entry === "" || entry.length > GROUP_NAME_MAX_LENGTH) continue;
    if (FORBIDDEN_SEGMENTS.has(entry)) continue;
    if (!groups.includes(entry)) groups.push(entry);
  }
  return { groups, invalid: false };
}

/**
 * Presence-aware safe dot-path reader for OIDC group claims. Read-only
 * own-property walk, depth <= 5, rejecting empty, `__proto__`, `constructor`
 * and `prototype` segments. Absent key => { present:false } without
 * invalidating; a present key with a bad shape => { present:true, invalid:true };
 * explicit [] is valid.
 * @param {object} source - claim object (id_token payload or UserInfo response)
 * @param {string} path - configured claim path, e.g. "groups" or "realm.access.groups"
 * @returns {{ present: boolean, groups: string[]|null, invalid: boolean }}
 */
export function readGroupsClaim(source, path) {
  const segments = typeof path === "string" ? path.split(".") : [];
  if (segments.length === 0 || segments.length > GROUP_CLAIM_MAX_DEPTH) return INVALID;
  if (segments.some((segment) => segment === "" || FORBIDDEN_SEGMENTS.has(segment))) return INVALID;

  let node = source;
  for (const segment of segments) {
    if (node === null || typeof node !== "object") return ABSENT;
    if (!Object.hasOwn(node, segment)) return ABSENT;
    node = node[segment];
  }
  const { groups, invalid } = normalizeGroups(node);
  return { present: true, groups, invalid };
}

/**
 * Pure admission/assignment resolution. Empty `settings.ssoAllowedGroups`
 * admits everyone; otherwise at least one group must match. `adminMatch` is any
 * hit on `ssoAdminGroups`. Memberships come from `ssoGroupWorkspaceMap` with the
 * highest role per workspaceId (manager > member > viewer). Inputs are never
 * mutated.
 * @param {string[]} groups - normalized user groups
 * @param {object} settings
 * @returns {{ admit: boolean, adminMatch: boolean, memberships: Array<{workspaceId: string, role: string}> }}
 */
export function resolveAssignments(groups, settings) {
  const userGroups = Array.isArray(groups) ? groups : [];
  const allowedGroups = Array.isArray(settings?.ssoAllowedGroups) ? settings.ssoAllowedGroups : [];
  const adminGroups = Array.isArray(settings?.ssoAdminGroups) ? settings.ssoAdminGroups : [];
  const groupWorkspaceMap = Array.isArray(settings?.ssoGroupWorkspaceMap)
    ? settings.ssoGroupWorkspaceMap
    : [];

  const admit = allowedGroups.length === 0 || userGroups.some((g) => allowedGroups.includes(g));
  const adminMatch = userGroups.some((g) => adminGroups.includes(g));

  const bestByWorkspace = new Map();
  for (const entry of groupWorkspaceMap) {
    if (!entry || typeof entry !== "object") continue;
    const { group, workspaceId, role } = entry;
    if (typeof group !== "string" || typeof workspaceId !== "string") continue;
    const rank = ROLE_RANK[role];
    if (!rank || !userGroups.includes(group)) continue;
    const current = bestByWorkspace.get(workspaceId);
    if (!current || rank > current.rank) bestByWorkspace.set(workspaceId, { rank, role });
  }
  const memberships = [...bestByWorkspace].map(([workspaceId, { role }]) => ({
    workspaceId,
    role,
  }));
  return { admit, adminMatch, memberships };
}

// ─── Transactional admission (YAN-359) ───
// DB/bootstrap imports stay dynamic inside ssoAdmit: saml.js imports this
// module statically and must not pull the DB layer in.

/** Fixed-code admission failure; `code` is the only thing callers branch on. */
export class SsoAdmissionError extends Error {
  /** @param {"denied"|"groups_unavailable"|"disabled"|"sync_failed"} code */
  constructor(code) {
    super(`SSO admission failed: ${code}`);
    this.name = "SsoAdmissionError";
    this.code = code;
  }
}

const nonEmptyString = (v) => typeof v === "string" && v !== "";
const DEFAULT_ROLES = new Set(["pending", "user"]);
const USER_ROW = `SELECT id, instanceRole, status, instanceRoleSource FROM users WHERE id = ?`;

// One sync transaction for a non-owner. Throws SsoAdmissionError / TenancyError.
function admitInTransaction(db, deps, { userId, key, email, displayName, groups }) {
  const { createUserWithPersonalWorkspaceSync, insertIdentitySync, syncIdpMembershipsSync } = deps;
  // Policy re-read inside the transaction: a change made while bootstrap/proof
  // awaited must not grant admin or memberships from a stale snapshot.
  const stored = db.get(`SELECT data FROM settings WHERE id = 1`)?.data;
  const settings = { ...deps.defaults, ...(stored ? deps.parseJson(stored, {}) : {}) };
  const assigned = resolveAssignments(groups, settings);
  if (!assigned.admit) throw new SsoAdmissionError("denied");
  let created = false;
  let row = userId ? db.get(USER_ROW, [userId]) : null;
  if (userId && !row) throw new SsoAdmissionError("sync_failed");

  if (!row) {
    if (settings?.requireLogin === false) {
      const n = db.get(`SELECT COUNT(*) AS n FROM users WHERE status = 'active'`)?.n ?? 0;
      if (n >= 1) throw new SsoAdmissionError("sync_failed");
    }
    const user = createUserWithPersonalWorkspaceSync(db, {
      email,
      displayName,
      instanceRole: DEFAULT_ROLES.has(settings?.ssoDefaultRole)
        ? settings.ssoDefaultRole
        : "pending",
      status: "active",
    });
    insertIdentitySync(db, user.id, { ...key, emailAtLink: deps.emailAtLink });
    row = db.get(USER_ROW, [user.id]);
    created = true;
  }
  if (row.status !== "active") throw new SsoAdmissionError("disabled");
  // Owners never reach this transaction (ssoAdmit returns first); refuse to sync one.
  if (row.instanceRole === "owner") throw new SsoAdmissionError("sync_failed");

  // Every configured target must still be a shared workspace, matched or not:
  // a stale map fails the login instead of silently skipping (plan contract 8).
  const map = Array.isArray(settings?.ssoGroupWorkspaceMap) ? settings.ssoGroupWorkspaceMap : [];
  for (const id of new Set(map.map((entry) => entry?.workspaceId))) {
    const ws =
      typeof id === "string" ? db.get(`SELECT kind FROM workspaces WHERE id = ?`, [id]) : null;
    if (!ws || ws.kind === "personal") throw new SsoAdmissionError("sync_failed");
  }

  const fromRole = row.instanceRole;
  let role = row.instanceRole;
  let source = row.instanceRoleSource ?? null;
  let changed = false;
  if (assigned.adminMatch && DEFAULT_ROLES.has(role)) {
    role = "admin";
    source = "idp";
    changed = true;
  } else if (!assigned.adminMatch && role === "admin" && source === "idp") {
    role = "user";
    source = null;
    changed = true;
  }
  const now = new Date().toISOString();
  if (changed) {
    db.run(
      `UPDATE users SET instanceRole = ?, instanceRoleSource = ?, updatedAt = ? WHERE id = ?`,
      [role, source, now, row.id],
    );
  }
  const delta = syncIdpMembershipsSync(db, row.id, assigned.memberships);
  if (delta.changed) changed = true;
  if (changed) {
    db.run(`UPDATE users SET sessionVersion = sessionVersion + 1, updatedAt = ? WHERE id = ?`, [
      now,
      row.id,
    ]);
  }
  return {
    userId: row.id,
    role,
    created,
    fromRole,
    added: delta.added.length,
    updated: delta.updated.length,
    removed: delta.removed.length,
  };
}

/**
 * Admit a verified SSO identity. Order: validate identity, groups, allow-list
 * (before any bootstrap/proof/write); linked user; owner proof; JIT.
 * Non-owners run in one synchronous transaction (user, workspace, identity,
 * role, IdP memberships, one sessionVersion bump if role/memberships changed).
 * @param {{ provider: string, issuer: string, subject: string, email?: string, emailVerified?: boolean, displayName?: string }} identity
 * @param {string[]|null} groups - normalized groups, null when unavailable
 * @param {{ setupToken?: string }} [opts]
 * @returns {Promise<{ kind: "active"|"pending", userId: string }>}
 * @throws {SsoAdmissionError}
 */
export async function ssoAdmit(identity, groups, { setupToken } = {}) {
  const { provider, issuer, subject } = identity ?? {};
  if (!nonEmptyString(provider) || !nonEmptyString(issuer) || !nonEmptyString(subject)) {
    throw new SsoAdmissionError("denied");
  }
  if (!Array.isArray(groups)) throw new SsoAdmissionError("groups_unavailable");

  const { isUserSecurityEnforced } = await import("./securityState.js");
  if (!(await isUserSecurityEnforced())) throw new SsoAdmissionError("denied");

  const { getSettings, findIdentityUnscoped } = await import("@/lib/db/index.js");
  const settings = await getSettings();
  const assigned = resolveAssignments(groups, settings);
  if (!assigned.admit) throw new SsoAdmissionError("denied");

  const key = { provider, issuer, subject };
  const { getAdapter } = await import("@/lib/db/driver.js");
  const db = await getAdapter();
  let userId = null;
  const ids = new Set();
  try {
    try {
      userId = (await findIdentityUnscoped(key))?.userId ?? null;
      if (!userId) {
        // Unlinked: JIT and owner linking are rollout features. With the switch
        // off (even security-latched) only already-linked users get in; read
        // the switch directly, since the bootstrap result is memoised per process.
        const { isMultiUserEnabled } = await import("./featureSwitch.js");
        if (!(await isMultiUserEnabled())) throw new SsoAdmissionError("denied");
        const { ensureOwnerBootstrap, resolveSsoUser } = await import("./bootstrap.js");
        if (!(await ensureOwnerBootstrap({ throwOnError: true }))?.enabled) {
          throw new SsoAdmissionError("denied");
        }
        userId = await resolveSsoUser(identity, { setupToken });
      }
      if (userId) {
        const row = db.get(USER_ROW, [userId]);
        if (!row) throw new SsoAdmissionError("sync_failed");
        if (row.status !== "active") throw new SsoAdmissionError("disabled");
        if (row.instanceRole === "owner") return { kind: "active", userId };
      }

      const [users, identities, memberships, errors, settingsRepo, { audit }, { parseJson }] =
        await Promise.all([
          import("@/lib/db/repos/usersRepo.js"),
          import("@/lib/db/repos/identitiesRepo.js"),
          import("@/lib/db/repos/membershipsRepo.js"),
          import("./errors.js"),
          import("@/lib/db/repos/settingsRepo.js"),
          import("./audit.js"),
          import("@/lib/db/helpers/jsonCol.js"),
        ]);
      const email = typeof identity.email === "string" ? identity.email.trim().toLowerCase() : "";
      const deps = {
        createUserWithPersonalWorkspaceSync: users.createUserWithPersonalWorkspaceSync,
        insertIdentitySync: identities.insertIdentitySync,
        syncIdpMembershipsSync: memberships.syncIdpMembershipsSync,
        emailAtLink: email || null,
        defaults: settingsRepo.DEFAULT_SETTINGS,
        parseJson,
      };
      const displayName = nonEmptyString(identity.displayName) ? identity.displayName : null;
      let useEmail = Boolean(email);
      let retriedIdentity = false;
      for (;;) {
        if (userId) ids.add(userId);
        try {
          const out = errors.mapConstraintErrors(() =>
            db.transaction(() =>
              admitInTransaction(db, deps, {
                userId,
                key,
                email: useEmail ? email : null,
                displayName,
                groups,
              }),
            ),
          );
          ids.add(out.userId);
          // Ids, roles and counts only: never group names, claims or email.
          if (out.created || out.fromRole !== out.role || out.added || out.updated || out.removed) {
            audit(
              {},
              "auth.ssoSync",
              { type: "user", id: out.userId },
              {
                before: { role: out.created ? undefined : out.fromRole },
                after: {
                  provider,
                  role: out.role,
                  reason: out.created ? "provisioned" : "synced",
                  count: out.added + out.updated + out.removed,
                },
              },
            );
          }
          return { kind: out.role === "pending" ? "pending" : "active", userId: out.userId };
        } catch (err) {
          if (err?.code === "EMAIL_TAKEN" && useEmail && !userId) {
            useEmail = false;
          } else if (err?.code === "IDENTITY_TAKEN" && !retriedIdentity) {
            retriedIdentity = true;
            userId = (await findIdentityUnscoped(key))?.userId ?? null;
            if (!userId) throw err;
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      if (err instanceof SsoAdmissionError) throw err;
      // Fixed safe text only: never the raw error (may carry claim data).
      console.warn("[SSO] admission sync failed:", err?.code || "error");
      throw new SsoAdmissionError("sync_failed");
    }
  } finally {
    const { invalidateUserSessionCacheSync } = await import("@/lib/db/repos/usersRepo.js");
    invalidateUserSessionCacheSync(...ids);
  }
}
