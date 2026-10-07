// Request principal and revocable dashboard sessions (YAN-355, ADR-0003/0004).
// Pristine off: tokens are checked by signature only and no principal resolves,
// exactly today's single-admin behaviour. Rollout on, or durable hashed marker
// written (YAN-363, switch may later read off again): `sub` tokens are checked
// against users.sessionVersion/status, and every request maps to a Principal.
// YAN-356: lazy owner bootstrap on the multi-user paths, sessionClaims(method,
// identity) for SSO owner linking, singleUserMode + owner password hash sync.
import { cookies, headers } from "next/headers";
import {
  getDashboardAuthSession,
  setDashboardAuthCookie,
  verifyDashboardAuthToken,
} from "@/lib/auth/dashboardSession";
import { cliTokenAcceptedWith } from "@/lib/auth/cliTokenPolicy.js";
import {
  bumpSessionVersion,
  countActiveUsersUnscoped,
  findIdentityUnscoped,
  getMeta,
  getOwnerUnscoped,
  getSessionUserUnscoped,
  getSettings,
  getUserUnscoped,
  listWorkspaces,
  updateUserUnscoped,
} from "@/lib/db/index.js";
import { NextResponse } from "next/server";
import { isUserSecurityEnforced } from "./securityState.js";
import { ensureOwnerBootstrap } from "./bootstrap.js";
import { can } from "./principal.js";
import { audit } from "./audit.js";

const AUTH_COOKIE = "auth_token";

/** @typedef {import("./principal.js").Principal} Principal */

// Never cache or fail open: a restore/marker write must affect the next request.
async function securityOn() {
  const on = await isUserSecurityEnforced();
  // YAN-356: lazy owner bootstrap also covers marker-latched installs whose
  // switch reads off. Memoised no-op once done; never throws.
  if (on) await ensureOwnerBootstrap();
  return on;
}

/**
 * YAN-356 single-user mode: login not required, and security not enforced, or
 * at most one active user exists. A restored DB with two users and
 * `requireLogin=false` no longer opens the instance — including a
 * marker-latched install whose rollout switch reads off.
 * @param {object|null|undefined} settings settings object, or null when unreadable
 * @returns {Promise<boolean>}
 */
export async function singleUserMode(settings) {
  if (settings?.requireLogin !== false) return false;
  try {
    if (!(await securityOn())) return true;
    // YAN-358: never resolve the implicit local principal while the owner owes
    // a mandatory rotation — that would bypass it. CLI recovery stays allowed.
    const owner = await getOwnerUnscoped();
    if (owner?.mustChangePassword) return false;
    return (await countActiveUsersUnscoped()) <= 1;
  } catch {
    return false;
  }
}

/** Whether login may be turned off: security not enforced, or at most one active user. */
export async function singleUserModeAllowed() {
  if (!(await securityOn())) return true;
  return (await countActiveUsersUnscoped()) <= 1;
}

/**
 * `{ user, payload }` for a live session, `{ legacy: true }` for an accepted
 * pre-users token, or null. Switch off: signature only (`{ legacy: true }`).
 */
async function validateSessionToken(token) {
  if (!token) return null;
  if (!(await securityOn())) {
    return (await verifyDashboardAuthToken(token)) ? { legacy: true } : null;
  }
  const payload = await getDashboardAuthSession(token);
  if (!payload) return null;
  if (typeof payload.sub !== "string" || !payload.sub) {
    // legacy: pre-users session. Only the single admin could have minted it, so it
    // stands for the owner until a second user exists, then it must log in again.
    // Zero users (switch on before the YAN-356 bootstrap) is still that sole admin.
    // YAN-358: never while the owner is pending/disabled or owes a rotation.
    if ((await countActiveUsersUnscoped()) > 1) return null;
    const owner = await getOwnerUnscoped();
    if (!owner) return { legacy: true, payload };
    if (owner.status !== "active" || owner.mustChangePassword) return null;
    return { legacy: true, payload };
  }
  const user = await getSessionUserUnscoped(payload.sub);
  if (user?.status !== "active" || user.sessionVersion !== payload.sv) return null;
  // YAN-358: no full session for an unapproved user or a pending rotation.
  if (user.instanceRole === "pending" || user.mustChangePassword) return null;
  return { user, payload };
}

/**
 * Whether the dashboard cookie authenticates the request (any live session).
 * What the session may do is the route table's job (principalCan, YAN-357).
 */
export async function hasValidSession(request) {
  try {
    return Boolean(await validateSessionToken(request.cookies.get(AUTH_COOKIE)?.value));
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
 * Single authority: @/lib/auth/cliTokenPolicy (this is its only behavior delta).
 */
export async function cliTokenAccepted(request) {
  return cliTokenAcceptedWith(request, {
    multiUserOn: securityOn,
    activeUserCount: () => countActiveUsersUnscoped(),
  });
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
    workspaceRoles: Object.fromEntries(workspaces.map((w) => [w.id, w.role])),
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
  try {
    return await resolvePrincipalOrThrow(request);
  } catch (err) {
    // Never flatten invalid durable security into a logged-out principal.
    // Management callers map this error to 503.
    if (err?.code === "API_KEY_STATE_INVALID") throw err;
    return null; // same fail-closed posture as the guard
  }
}

async function resolvePrincipalOrThrow(request) {
  if (!(await securityOn())) return null;
  const token = request.cookies.get(AUTH_COOKIE)?.value;
  if (token) {
    const session = await validateSessionToken(token);
    if (session?.user) return principalFor(session.user, "session", session.payload.wid);
    if (session?.legacy) return principalFor(await getOwnerUnscoped(), "session");
    // A stale/invalid token falls through: CLI needs its own token, and
    // singleUserMode refuses while the owner owes a rotation (YAN-358).
  }
  if (await cliTokenAccepted(request)) return principalFor(await getOwnerUnscoped(), "cli");
  // Gateway API keys resolve here once YAN-363 lands (via: "apiKey").
  // YAN-356: single-user mode no longer trusts requireLogin=false alone — a
  // restored DB with two users and login off stays closed.
  const settings = await getSettings();
  if (await singleUserMode(settings)) return principalFor(await getOwnerUnscoped(), "local");
  return null;
}

// Non-`scoped` route rows check the Default workspace (YAN-356). Usage
// (YAN-370), connections and nodes are `scoped`.
// Connections and nodes (YAN-361) are `scoped`: their handlers check the row.
// Read per request (switch on only): a DB import can replace it.
async function routeWorkspaceId() {
  return (await getMeta("defaultWorkspaceId")) || null;
}

/**
 * Whether the request's principal holds the route's `capability` (YAN-357).
 * Switch off: true (every authenticated caller is the single admin). Switch
 * on with no principal: only before any user exists (the sole admin, before
 * the owner bootstrap). Fails closed.
 * @param {{ headers: Headers, cookies: { get(name: string): { value: string }|undefined } }} request
 * `anyWorkspace` (routePolicy `scoped`, YAN-361): the capability in any of the
 * principal's workspaces; the handler then checks the row's own workspace.
 * @param {string|null} capability
 * @param {{ anyWorkspace?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
export async function principalCan(request, capability, { anyWorkspace = false } = {}) {
  try {
    if (!capability || !(await securityOn())) return true;
    const principal = await resolvePrincipalOrThrow(request);
    if (!principal) return (await countActiveUsersUnscoped()) === 0;
    if (
      anyWorkspace &&
      principal.workspaceIds.some((w) => can(principal, capability, { workspaceId: w }))
    )
      return true;
    const workspaceId = await routeWorkspaceId();
    if (can(principal, capability, { workspaceId })) return true;
    // No Default workspace yet: the unscoped data is the owner's alone.
    return (
      !workspaceId && capability.startsWith("workspace.") && principal.instanceRole === "owner"
    );
  } catch {
    // Invalid durable-security state or a broken users table denies (never
    // allows, never 500s a guard call).
    return false;
  }
}

/**
 * Per-resource check for route handlers (ADR-0002). Null when allowed, else a
 * 401/403 response. Switch off: always null (today's single admin).
 * Usage: `const denied = await authorize("workspace.keys.manage", { workspaceId }); if (denied) return denied;`
 * @param {string} capability
 * @param {{ workspaceId?: string|null }} [resource]
 * @returns {Promise<Response|null>}
 */
export async function authorize(capability, resource = {}) {
  if (!(await securityOn())) return null;
  const principal = await getPrincipal();
  if (!principal) {
    audit(
      {},
      "auth.denied",
      { type: "capability", id: capability },
      { after: { capability }, result: "denied" },
    );
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (can(principal, capability, resource)) return null;
  audit(
    { principal, workspaceId: resource?.workspaceId ?? null },
    "auth.denied",
    { type: "capability", id: capability },
    { after: { capability }, result: "denied" },
  );
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

/** The current route handler's principal. */
export async function getPrincipal() {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);
  return resolvePrincipal({ cookies: cookieStore, headers: headerList });
}

/**
 * Claims a fresh login mints (ADR-0004). Switch off, or before an owner exists
 * (YAN-356 bootstraps it), logins keep today's claim set. Password logins mint
 * the owner's claims as before. An SSO login (YAN-359) is admitted only by the
 * provisioning service: it must carry a verified identity (non-empty provider/
 * issuer/subject) plus `opts.admittedUserId`, and that identity triple must be
 * linked to exactly that user, who must be active, approved and rotation-free.
 * No owner fallback, no linking here — `resolveSsoUser` is the owner-proof
 * resolver used inside admission only.
 * @param {"pwd"|"oidc"|"saml"} method
 * @param {{ provider: "oidc"|"saml", issuer?: string, subject: string, email?: string, emailVerified?: boolean }} [identity] SSO identity (YAN-356)
 * @param {{ admittedUserId?: string }} [opts] server-only admitted user id (YAN-359)
 * @returns {Promise<object|null>}
 */
export async function sessionClaims(method, identity = null, opts = {}) {
  if (!(await securityOn())) return {};
  await ensureOwnerBootstrap();
  let user = null;
  if (method !== "pwd") {
    const nonEmpty = (v) => typeof v === "string" && v !== "";
    const { provider, issuer, subject } = identity ?? {};
    const admitted = opts.admittedUserId;
    if (!(nonEmpty(provider) && nonEmpty(issuer) && nonEmpty(subject) && nonEmpty(admitted)))
      return null;
    const linked = await findIdentityUnscoped({ provider, issuer, subject });
    if (!linked || linked.userId !== admitted) return null;
    user = await getUserUnscoped(admitted);
    // Fresh committed row: admission just dropped the session cache.
    if (user?.status !== "active") return null;
    if (user.instanceRole === "pending" || user.mustChangePassword) return null;
    return {
      sub: user.id,
      sv: user.sessionVersion,
      wid: (await principalFor(user, "session")).activeWorkspaceId,
      amr: [method],
    };
  }
  const owner = await getOwnerUnscoped();
  if (owner?.status !== "active") return {};
  // YAN-358: a flagged owner never gets full claims (rotation first).
  if (owner.mustChangePassword) return null;
  user = owner;
  const principal = await principalFor(user, "session");
  return {
    sub: user.id,
    sv: user.sessionVersion,
    wid: principal.activeWorkspaceId,
    amr: [method],
  };
}

/**
 * Claims for a password login of a specific user (multi-user password login).
 * Switch off: today's claim set. Null for an unknown, inactive, pending or
 * rotation-owing user. `wid` is kept only if it is one of the user's workspaces.
 * @param {string} userId
 * @param {string} [wid]
 * @returns {Promise<object|null>}
 */
export async function passwordSessionClaims(userId, wid) {
  if (!(await securityOn())) return {};
  const user = await getUserUnscoped(userId);
  if (!user) return null;
  if (user.status !== "active" || user.instanceRole === "pending" || user.mustChangePassword)
    return null;
  const principal = await principalFor(user, "session", wid);
  return {
    sub: user.id,
    sv: user.sessionVersion,
    wid: principal.activeWorkspaceId,
    amr: ["pwd"],
  };
}

/**
 * Revoke every session of the owner (password change or reset). A given
 * `passwordHash` (or null, the reset case) is copied to the owner first via
 * updateUserUnscoped, which bumps sv itself (ADR-0004) — no double bump.
 * When `request` carries the owner's own session, re-mint its cookie so only
 * other devices are signed out. No-op while the switch is off or before an
 * owner exists.
 * @param {Request|null} request
 * @param {{ passwordHash?: string|null }} [opts] new owner hash (YAN-356)
 */
export async function revokeOwnerSessions(request, { passwordHash } = {}) {
  if (!(await securityOn())) return;
  await ensureOwnerBootstrap();
  const owner = await getOwnerUnscoped();
  if (!owner) return;
  if (passwordHash !== undefined) await updateUserUnscoped(owner.id, { passwordHash });
  else await bumpSessionVersion(owner.id);
  if (!request) return;
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE)?.value;
  const session = await getDashboardAuthSession(token);
  // Re-mint the owner's own cookie: a sub session, or a legacy one still accepted
  // (it carries no sv, so this upgrades it). Keep how they signed in (amr).
  const ownSession = session?.sub ? session.sub === owner.id : await isLiveSession(token);
  if (!ownSession) return;
  const claims = await sessionClaims("pwd");
  if (!claims) return; // refused (e.g. owner owes a rotation): never re-mint
  claims.amr = Array.isArray(session.amr) ? session.amr : ["pwd"];
  // Keep the caller's active workspace if it is still one of the owner's.
  const ownWorkspaces = (await listWorkspaces({ userId: owner.id })).map((w) => w.id);
  if (ownWorkspaces.includes(session.wid)) claims.wid = session.wid;
  await setDashboardAuthCookie(cookieStore, request, claims);
}

/** Public view of a principal for /api/auth/status: no secrets, no hashes. */
export async function describePrincipal(principal) {
  if (!principal) return null;
  const user = await getUserUnscoped(principal.userId);
  if (!user) return null;
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
