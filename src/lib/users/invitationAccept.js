// Invitation accept, password path only (YAN-360). Creates an approved user,
// personal workspace, password identity and the invited membership, and burns
// the invite, all in one transaction. Existing-user/SSO acceptance is a future
// seam. Every invite/account conflict is a generic INVALID (no enumeration).
import { getAdapter } from "@/lib/db/driver.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { parseJson } from "@/lib/db/helpers/jsonCol.js";
import { TenancyError, mapConstraintErrors } from "@/lib/users/errors.js";
import { hashPassword, validateNewPassword } from "@/lib/auth/userPassword.js";
import {
  createUserWithPersonalWorkspaceSync,
  invalidateUserSessionCacheSync,
} from "@/lib/db/repos/usersRepo.js";
import { insertIdentitySync } from "@/lib/db/repos/identitiesRepo.js";
import { addMembershipUnscoped } from "@/lib/db/repos/membershipsRepo.js";
import {
  consumeInvitationSync,
  getInvitationForConsumeSync,
} from "@/lib/db/repos/invitationsRepo.js";

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const TAKEN = new Set([
  "EMAIL_TAKEN",
  "USERNAME_TAKEN",
  "IDENTITY_TAKEN",
  "MEMBERSHIP_EXISTS",
  "PERSONAL_WORKSPACE",
]);
const bad = () => new TenancyError("INVALID", "Invalid invitation");

function text(v, max, { required = false } = {}) {
  if (v === undefined || v === null || v === "") {
    if (required) throw bad();
    return null;
  }
  if (typeof v !== "string") throw bad();
  const s = v.trim();
  if ((required && !s) || s.length > max) throw bad();
  return s || null;
}

// Invite must be live, email-compatible and aimed at a shared workspace.
function assertAcceptable(db, token, email) {
  const inv = getInvitationForConsumeSync(db, token);
  const now = new Date().toISOString();
  if (inv.consumedAt || inv.revokedAt || !(inv.expiresAt > now)) throw bad();
  if (inv.email !== null && inv.email !== email) throw bad();
  if (db.get(`SELECT kind FROM workspaces WHERE id = ?`, [inv.workspaceId])?.kind !== "shared")
    throw bad();
  return inv;
}

// Persisted setting (same row/blob as settingsRepo); missing key = login required.
const loginOff = (db) =>
  parseJson(db.get(`SELECT data FROM settings WHERE id = 1`)?.data, {})?.requireLogin === false;

function assertSingleUser(db) {
  if (loginOff(db) && db.get(`SELECT COUNT(*) AS n FROM users WHERE status = 'active'`)?.n >= 1) {
    throw new TenancyError("SINGLE_USER_MODE", "Turn on Require login before adding a second user");
  }
}

/**
 * Signed-in accept: the route passes the session's userId; the account row is
 * re-read here, and a bound invite matches the persisted account email only
 * (never a request field). An existing membership in the workspace is a
 * conflict, never overwritten. One transaction; generic INVALID on failure.
 * @param {{ token: string, userId: string }} input
 */
export async function acceptExistingInvitation({ token, userId } = {}) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) throw bad();
  if (typeof userId !== "string" || !userId) throw bad();
  const db = await getAdapter();
  try {
    return db.transaction(() => {
      const user = db.get(`SELECT id, email, instanceRole, status FROM users WHERE id = ?`, [
        userId,
      ]);
      if (!user || user.status !== "active" || user.instanceRole === "pending") throw bad();
      const email = user.email ? user.email.toLowerCase() : null;
      const inv = assertAcceptable(db, token, email);
      // A stored SSO email may be IdP-unverified. A bound invite here needs a
      // password account; SSO users accept bound invites through the SSO flow,
      // which requires a verified email (ssoProvisioning liveInvite).
      if (
        inv.email !== null &&
        !db.get(`SELECT 1 AS x FROM identities WHERE userId = ? AND provider = 'password'`, [
          userId,
        ])
      ) {
        throw bad();
      }
      if (
        db.get(`SELECT 1 AS x FROM memberships WHERE workspaceId = ? AND userId = ?`, [
          inv.workspaceId,
          userId,
        ])
      ) {
        throw bad();
      }
      addMembershipUnscoped(db, {
        workspaceId: inv.workspaceId,
        userId,
        role: inv.role,
        source: "invite",
      });
      const invitation = consumeInvitationSync(db, token, { email, consumedByUserId: userId });
      return { invitation, workspaceId: inv.workspaceId, role: inv.role };
    });
  } catch (err) {
    if (err instanceof TenancyError && TAKEN.has(err.code)) throw bad();
    throw err;
  } finally {
    invalidateUserSessionCacheSync(userId);
  }
}

/**
 * @param {{ token: string, email: string, username?: string, displayName?: string, password: string }} input
 * @returns {Promise<{ user: object, invitation: object, workspaceId: string, role: string }>}
 */
export async function acceptPasswordInvitation({
  token,
  email,
  username,
  displayName,
  password,
} = {}) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) throw bad();
  const mail = text(email, 320, { required: true })?.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(mail)) throw bad();
  const name = text(username, 128);
  const display = text(displayName, 128);
  const pwError = validateNewPassword(password);
  if (pwError) throw new TenancyError("INVALID", pwError.error);

  const db = await getAdapter();
  // Cheap pre-checks so junk tokens never cost a bcrypt hash; re-run inside the tx.
  assertAcceptable(db, token, mail);
  if ((await getSettings())?.requireLogin === false) assertSingleUser(db);
  const passwordHash = await hashPassword(password);

  let userId = null;
  try {
    return mapConstraintErrors(() =>
      db.transaction(() => {
        const inv = assertAcceptable(db, token, mail);
        assertSingleUser(db);
        if (db.get(`SELECT 1 AS x FROM users WHERE email = ? COLLATE NOCASE`, [mail])) throw bad();
        if (name && db.get(`SELECT 1 AS x FROM users WHERE username = ? COLLATE NOCASE`, [name]))
          throw bad();
        const user = createUserWithPersonalWorkspaceSync(db, {
          email: mail,
          username: name,
          displayName: display,
          instanceRole: "user",
          status: "active",
          passwordHash,
        });
        userId = user.id;
        insertIdentitySync(db, user.id, {
          provider: "password",
          issuer: "",
          subject: user.id,
          emailAtLink: mail,
        });
        addMembershipUnscoped(db, {
          workspaceId: inv.workspaceId,
          userId: user.id,
          role: inv.role,
          source: "invite",
        });
        const invitation = consumeInvitationSync(db, token, {
          email: mail,
          consumedByUserId: user.id,
        });
        const { sessionVersion: _sv, ...safe } = user;
        return { user: safe, invitation, workspaceId: inv.workspaceId, role: inv.role };
      }),
    );
  } catch (err) {
    if (err instanceof TenancyError && TAKEN.has(err.code)) throw bad();
    throw err;
  } finally {
    invalidateUserSessionCacheSync(...(userId ? [userId] : []));
  }
}
