// Request principal and revocable dashboard sessions (YAN-355, ADR-0003/0004).
// Switch off: tokens are checked by signature only and no principal resolves,
// exactly today's single-admin behaviour. Switch on: `sub` tokens are checked
// against users.sessionVersion/status, and every request maps to a Principal.
// YAN-356: lazy owner bootstrap on the multi-user paths, sessionClaims(method,
// identity) for SSO owner linking, singleUserMode + owner password hash sync.
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
  getMeta,
  getOwnerUnscoped,
  getSessionUserUnscoped,
  getSettings,
  getUserUnscoped,
  listWorkspaces,
  updateUserUnscoped,
} from "@/lib/db/index.js";
import { NextResponse } from "next/server";
import { isMultiUserEnabled } from "./featureSwitch.js";
import { ensureOwnerBootstrap, resolveSsoUser } from "./bootstrap.js";
import { can } from "./principal.js";

const AUTH_COOKIE = "auth_token";

/** @typedef {import("./principal.js").Principal} Principal */

// The switch read hits the DB unless its env override is set, and the guard asks
// on every request carrying a cookie or CLI token. Cache it briefly; if the read
// fails, stay on today's signature-only path rather than 500 every request.
// ponytail: 5 s staleness after a DB import flips the stored switch; restart-free
// flips would need featureSwitch to own an invalidated cache.
const SWITCH_TTL_MS = 5000;
let switchCache = { on: false, at: 0 };
async function multiUserOn() {
  if (Date.now() - switchCache.at < SWITCH_TTL_MS) return switchCache.on;
  try {
    switchCache = { on: await isMultiUserEnabled(), at: Date.now() };
    // YAN-356: bootstrap lazily too, so a runtime flip of the stored switch is
    // covered. A memoised no-op once done; never throws.
    if (switchCache.on) await ensureOwnerBootstrap();
  } catch {
    return false;
  }
  return switchCache.on;
}

/**
 * YAN-356 single-user mode: login not required, and either the switch is off
 * or at most one active user exists. A restored DB with two users and
 * `requireLogin=false` no longer opens the instance.
 * @param {object|null|undefined} settings settings object, or null when unreadable
 * @returns {Promise<boolean>}
 */
export async function singleUserMode(settings) {
  if (settings?.requireLogin !== false) return false;
  if (!(await multiUserOn())) return true;
  try {
    return (await countActiveUsersUnscoped()) <= 1;
  } catch {
    return false;
  }
}

/** Whether login may be turned off: switch off, or at most one active user. */
export async function singleUserModeAllowed() {
  if (!(await isMultiUserEnabled())) return true;
  return (await countActiveUsersUnscoped()) <= 1;
}

/**
 * `{ user, payload }` for a live session, `{ legacy: true }` for an accepted
 * pre-users token, or null. Switch off: signature only (`{ legacy: true }`).
 */
async function validateSessionToken(token) {
  if (!token) return null;
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
  } catch {
    return null; // same fail-closed posture as the guard
  }
}

async function resolvePrincipalOrThrow(request) {
  if (!(await multiUserOn())) return null;
  const token = request.cookies.get(AUTH_COOKIE)?.value;
  if (token) {
    const session = await validateSessionToken(token);
    if (session?.user) return principalFor(session.user, "session", session.payload.wid);
    if (session?.legacy) return principalFor(await getOwnerUnscoped(), "session");
  }
  if (await cliTokenAccepted(request)) return principalFor(await getOwnerUnscoped(), "cli");
  // Gateway API keys resolve here once YAN-363 lands (via: "apiKey").
  // YAN-356: single-user mode no longer trusts requireLogin=false alone — a
  // restored DB with two users and login off stays closed.
  const settings = await getSettings();
  if (await singleUserMode(settings)) return principalFor(await getOwnerUnscoped(), "local");
  return null;
}

// Combos, keys and usage are still unscoped: they belong to the Default
// workspace (YAN-356), so non-`scoped` route rows check it until YAN-363/364/370.
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
  if (!capability || !(await multiUserOn())) return true;
  try {
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
  if (!(await multiUserOn())) return null;
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (can(principal, capability, resource)) return null;
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

/** The current route handler's principal. */
export async function getPrincipal() {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);
  return resolvePrincipal({ cookies: cookieStore, headers: headerList });
}

/**
 * Claims a fresh login mints (ADR-0004). Switch off, or before an owner exists
 * (YAN-356 bootstraps it), logins keep today's claim set. An SSO login with an
 * identity linked to the owner stands for the owner even with more users; a
 * non-owner link is refused (YAN-359). An unlinked, unmatched SSO login keeps
 * the YAN-355 rule: owner claims while at most one active user, else null.
 * @param {"pwd"|"oidc"|"saml"} method
 * @param {{ provider: "oidc"|"saml", issuer?: string, subject: string, email?: string, emailVerified?: boolean }} [identity] SSO identity (YAN-356)
 * @param {{ setupToken?: string }} [opts] presented owner setup token (YAN-356)
 * @returns {Promise<object|null>}
 */
export async function sessionClaims(method, identity = null, opts = {}) {
  if (!(await isMultiUserEnabled())) return {};
  await ensureOwnerBootstrap();
  let user = null;
  if (method !== "pwd") {
    const linked = await resolveSsoUser(identity, opts);
    if (linked) {
      user = await getUserUnscoped(linked);
      if (user?.status !== "active" || user.instanceRole !== "owner") return null;
    }
  }
  if (!user) {
    if (method !== "pwd" && (await countActiveUsersUnscoped()) > 1) return null;
    const owner = await getOwnerUnscoped();
    if (owner?.status !== "active") return {};
    user = owner;
  }
  const principal = await principalFor(user, "session");
  return {
    sub: user.id,
    sv: user.sessionVersion,
    wid: principal.activeWorkspaceId,
    amr: [method],
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
  if (!(await isMultiUserEnabled())) return;
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
