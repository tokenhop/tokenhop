// Request principal and revocable dashboard sessions (YAN-355, ADR-0003/0004).
// Switch off: tokens are checked by signature only and no principal resolves,
// exactly today's single-admin behaviour. Switch on: `sub` tokens are checked
// against users.sessionVersion/status, and every request maps to a Principal.
import { cookies, headers } from "next/headers";
import {
  getDashboardAuthSession,
  setDashboardAuthCookie,
  verifyDashboardAuthToken,
} from "@/lib/auth/dashboardSession";
import { hasValidCliToken } from "@/lib/auth/cliToken";
import { isLoopbackPeer } from "@/lib/auth/trustedPeer";
import {
  bumpSessionVersion,
  countActiveUsersUnscoped,
  getOwnerUnscoped,
  getSessionUserUnscoped,
  getSettings,
  listWorkspaces,
} from "@/lib/db/index.js";
import { isMultiUserEnabled } from "./featureSwitch.js";

const AUTH_COOKIE = "auth_token";

/** @typedef {import("./principal.js").Principal} Principal */

/**
 * The validated session's user row, `{ legacy: true }` for an accepted
 * pre-users token, or null. Switch off: signature only (`{ legacy: true }`).
 */
// The switch read hits the DB unless its env override is set. If it fails,
// stay on today's signature-only path rather than 500 every request.
async function multiUserOn() {
  try {
    return await isMultiUserEnabled();
  } catch {
    return false;
  }
}

async function validateSessionToken(token) {
  if (!(await multiUserOn())) {
    return (await verifyDashboardAuthToken(token)) ? { legacy: true } : null;
  }
  const payload = await getDashboardAuthSession(token);
  if (!payload) return null;
  if (typeof payload.sub !== "string" || !payload.sub) {
    // legacy: pre-users session. Only the single admin could have minted it, so it
    // stands for the owner until a second user exists, then it must log in again.
    // Zero users (switch on before the YAN-356 bootstrap) is still that sole admin.
    return (await countActiveUsersUnscoped()) <= 1 ? { legacy: true, payload } : null;
  }
  const user = await getSessionUserUnscoped(payload.sub);
  if (user?.status !== "active" || user.sessionVersion !== payload.sv) return null;
  return { user, payload };
}

/**
 * Whether the dashboard cookie authenticates the request. Until YAN-357 maps
 * routes to capabilities, only the owner's session passes the guard.
 * ponytail: owner-only; YAN-357 swaps this for the route → capability table.
 */
export async function hasValidSession(request) {
  try {
    const session = await validateSessionToken(request.cookies.get(AUTH_COOKIE)?.value);
    if (!session) return false;
    return session.legacy === true || session.user.instanceRole === "owner";
  } catch {
    return false; // fail closed: a broken users table never admits anyone
  }
}

/** Whether `token` is a live session of any user (signature, sv, status). */
export async function isLiveSession(token) {
  try {
    return Boolean(await validateSessionToken(token));
  } catch {
    return false;
  }
}

/**
 * The CLI token acts as the owner. Once a second active user exists it is only
 * accepted from a direct loopback peer (ADR-0003), never through a proxy hop.
 */
export async function cliTokenAccepted(request) {
  if (!(await hasValidCliToken(request))) return false;
  if (!(await multiUserOn())) return true;
  try {
    if ((await countActiveUsersUnscoped()) <= 1) return true;
  } catch {
    return false;
  }
  return !request.headers.get("x-9r-via-proxy") && isLoopbackPeer(request);
}

/** @returns {Promise<Principal|null>} */
async function principalFor(user, via, wid) {
  if (!user) return null;
  const workspaces = await listWorkspaces({ userId: user.id });
  const workspaceIds = workspaces.map((w) => w.id);
  const personal = workspaces.find((w) => w.kind === "personal")?.id ?? null;
  return {
    userId: user.id,
    instanceRole: user.instanceRole,
    workspaceIds,
    activeWorkspaceId: workspaceIds.includes(wid) ? wid : personal,
    via,
  };
}

/**
 * Resolve the request's principal: session cookie, then CLI token (owner),
 * then single-user mode `requireLogin=false` (owner). Null while the switch
 * is off or when nothing authenticates.
 * @param {{ headers: Headers, cookies: { get(name: string): { value: string }|undefined } }} request
 * @returns {Promise<Principal|null>}
 */
export async function resolvePrincipal(request) {
  if (!(await isMultiUserEnabled())) return null;
  const token = request.cookies.get(AUTH_COOKIE)?.value;
  if (token) {
    const session = await validateSessionToken(token);
    if (session?.user) return principalFor(session.user, "session", session.payload.wid);
    if (session?.legacy) return principalFor(await getOwnerUnscoped(), "session");
  }
  if (await cliTokenAccepted(request)) return principalFor(await getOwnerUnscoped(), "cli");
  // Gateway API keys resolve here once YAN-363 lands (via: "apiKey").
  const settings = await getSettings();
  if (settings?.requireLogin === false) return principalFor(await getOwnerUnscoped(), "local");
  return null;
}

/** The current route handler's principal. */
export async function getPrincipal() {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);
  return resolvePrincipal({ cookies: cookieStore, headers: headerList });
}

/**
 * Claims a fresh login mints (ADR-0004). Switch off, or before an owner exists
 * (YAN-356 bootstraps it), logins keep today's claim set. SSO logins stand for
 * the owner only while the owner is the sole user; YAN-359 links SSO identities.
 * @param {"pwd"|"oidc"|"saml"} method
 * @returns {Promise<object>}
 */
export async function sessionClaims(method) {
  if (!(await isMultiUserEnabled())) return {};
  const owner = await getOwnerUnscoped();
  if (owner?.status !== "active") return {};
  if (method !== "pwd" && (await countActiveUsersUnscoped()) > 1) return {};
  const principal = await principalFor(owner, "session");
  return {
    sub: owner.id,
    sv: owner.sessionVersion,
    wid: principal.activeWorkspaceId,
    amr: [method],
  };
}

/**
 * Revoke every session of the owner (password change or reset). When `request`
 * carries the owner's own session, re-mint its cookie so only other devices
 * are signed out. No-op while the switch is off or before an owner exists.
 */
export async function revokeOwnerSessions(request) {
  if (!(await isMultiUserEnabled())) return;
  const owner = await getOwnerUnscoped();
  if (!owner) return;
  await bumpSessionVersion(owner.id);
  if (!request) return;
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE)?.value;
  const session = await getDashboardAuthSession(token);
  // Re-mint the owner's own cookie: a sub session, or a legacy one still accepted
  // (it carries no sv, so this upgrades it). Keep how they signed in (amr).
  const ownSession = session?.sub ? session.sub === owner.id : await isLiveSession(token);
  if (!ownSession) return;
  const amr = Array.isArray(session.amr) ? session.amr : ["pwd"];
  await setDashboardAuthCookie(cookieStore, request, { ...(await sessionClaims("pwd")), amr });
}

/** Public view of a principal for /api/auth/status: no secrets, no hashes. */
export async function describePrincipal(principal) {
  if (!principal) return null;
  const user = await getSessionUserUnscoped(principal.userId);
  const workspaces = await listWorkspaces(principal);
  return {
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.displayName,
    },
    role: principal.instanceRole,
    via: principal.via,
    activeWorkspaceId: principal.activeWorkspaceId,
    workspaces: workspaces.map(({ id, name, kind, role }) => ({ id, name, kind, role })),
  };
}
