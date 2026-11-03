// YAN-751: the only place that mints dashboard session cookies for users.
// Binds each cookie to a `sessions` row via the `sid` claim. Imports
// securityState (not ./session.js) to avoid an import cycle.
import { randomUUID } from "node:crypto";
import {
  SESSION_MAX_AGE_SEC,
  clearDashboardAuthCookie,
  readSignedAuthToken,
  setDashboardAuthCookie,
} from "@/lib/auth/dashboardSession";
import { getClientIp } from "@/lib/auth/loginLimiter";
import {
  createSessionUnscoped,
  rebindSessionUnscoped,
  revokeSessionUnscoped,
} from "@/lib/db/index.js";
import { coarseIp, describeDevice } from "./deviceLabel.js";
import { isUserSecurityEnforced } from "./securityState.js";

/**
 * Set the `auth_token` cookie, backed by a session row when security is enforced.
 * `from` (the decoded cookie being replaced) keeps its `sid` and `exp` on a re-mint.
 * Returns false only when a re-mint found its row revoked or expired (cookie cleared).
 * Insert errors propagate: never fall back to a sid-less token. A cookie write
 * that throws after a new row's insert revokes that row, then propagates.
 */
export async function mintSessionCookie(cookieStore, request, claims, { from } = {}) {
  const fromExp = Number.isInteger(from?.exp) ? from.exp : undefined;

  // A re-mint of a user-bound session must never downgrade to a sub-less token.
  if (!claims?.sub && from?.sub) {
    clearDashboardAuthCookie(cookieStore);
    return false;
  }

  if (!claims?.sub || !(await isUserSecurityEnforced())) {
    await setDashboardAuthCookie(
      cookieStore,
      request,
      claims,
      fromExp === undefined ? undefined : { exp: fromExp },
    );
    return true;
  }

  // sid/exp/iat are never carried over from the caller's claims.
  const { sid: _sid, exp: _exp, iat: _iat, ...base } = claims;
  const nowSec = Math.floor(Date.now() / 1000);

  // A re-mint of an already-expired session is the revoked path.
  if (fromExp !== undefined && fromExp <= nowSec) {
    clearDashboardAuthCookie(cookieStore);
    return false;
  }

  if (typeof from?.sid === "string" && from.sid) {
    // A sid-bound token without a valid exp must never get a fresh lifetime.
    if (fromExp === undefined) {
      clearDashboardAuthCookie(cookieStore);
      return false;
    }
    // Compare-and-set from the replaced cookie's sv (YAN-1220).
    if (!(await rebindSessionUnscoped(from.sid, claims.sub, from.sv, claims.sv))) {
      clearDashboardAuthCookie(cookieStore);
      return false;
    }
    await setDashboardAuthCookie(
      cookieStore,
      request,
      { ...base, sid: from.sid },
      { exp: fromExp },
    );
    return true;
  }

  const sid = randomUUID();

  if (fromExp !== undefined) {
    // Legacy sid-less token: adopt it with its original expiry (D1).
    await createSessionUnscoped({
      id: sid,
      userId: claims.sub,
      sv: claims.sv,
      amr: claims.amr?.[0] ?? null,
      userAgent: describeDevice(request?.headers?.get?.("user-agent")),
      ip: coarseIp(getClientIp(request)),
      createdAt: Number.isInteger(from.iat)
        ? new Date(from.iat * 1000).toISOString()
        : new Date().toISOString(),
      expiresAt: new Date(fromExp * 1000).toISOString(),
    });
    await setNewRowCookie(cookieStore, request, { ...base, sid }, fromExp);
    return true;
  }

  // Fresh login. A same-user session already in this browser is replaced.
  const exp = nowSec + SESSION_MAX_AGE_SEC;
  const incoming = await readSignedAuthToken(cookieStore?.get?.("auth_token")?.value);
  const replacesId =
    incoming?.sub === claims.sub && typeof incoming.sid === "string" ? incoming.sid : null;

  // Row first: if the insert throws, the login fails and no cookie is set; if
  // the cookie write throws, the new row is dropped (YAN-1813).
  await createSessionUnscoped({
    id: sid,
    userId: claims.sub,
    sv: claims.sv,
    amr: claims.amr?.[0] ?? null,
    userAgent: describeDevice(request?.headers?.get?.("user-agent")),
    ip: coarseIp(getClientIp(request)),
    createdAt: new Date(nowSec * 1000).toISOString(),
    expiresAt: new Date(exp * 1000).toISOString(),
    replacesId,
  });
  await setNewRowCookie(cookieStore, request, { ...base, sid }, exp);
  return true;
}

/** Cookie for a just-inserted row: a failed write drops the row (YAN-1813). */
async function setNewRowCookie(cookieStore, request, claims, exp) {
  try {
    await setDashboardAuthCookie(cookieStore, request, claims, { exp });
  } catch (err) {
    await dropReboundSession(cookieStore, claims);
    throw err;
  }
}

/**
 * Best-effort teardown of a row the caller's transaction already moved to a new
 * sv when no cookie will carry it (refused claims, or a throw before the cookie
 * write, YAN-1813): clears the auth cookie and revokes `from.sid` for `from.sub`
 * so it is not listed as a live device. Never throws.
 */
export async function dropReboundSession(cookieStore, from) {
  try {
    clearDashboardAuthCookie(cookieStore);
  } catch {
    // Cleanup only.
  }
  if (typeof from?.sid !== "string" || !from.sid) return;
  try {
    await revokeSessionUnscoped(from.sid, from.sub);
  } catch {
    // Cleanup only: the cookie is already gone.
  }
}

/**
 * Re-mint onto a row the caller's own transaction already moved to `sv`
 * (bumpSessionVersionAndRebindUnscoped / setUserPasswordUnscoped `rebind`, YAN-1708):
 * keeps `from.sid` and `from.exp` and never rebinds a second time. A sid-less
 * `from` (legacy token) takes mintSessionCookie's adopt path at `sv`.
 * Returns false when `claims` are refused (no `sub`, or a different user than
 * `from.sub`) or `from` is expired or has no valid exp; the moved row is then
 * dropped (dropReboundSession). Callers that throw before reaching this call
 * drop the row themselves (YAN-1813).
 */
export async function mintReboundSessionCookie(cookieStore, request, claims, { from, sv }) {
  const next = claims?.sub ? { ...claims, sv } : claims;
  const sid = typeof from?.sid === "string" && from.sid ? from.sid : null;
  if (!sid || !(await isUserSecurityEnforced())) {
    return mintSessionCookie(cookieStore, request, next, { from });
  }
  const fromExp = Number.isInteger(from.exp) ? from.exp : undefined;
  const otherUser = Boolean(from.sub) && next?.sub !== from.sub;
  if (
    !next?.sub ||
    otherUser ||
    fromExp === undefined ||
    fromExp <= Math.floor(Date.now() / 1000)
  ) {
    await dropReboundSession(cookieStore, from);
    return false;
  }
  const { sid: _sid, exp: _exp, iat: _iat, ...base } = next;
  await setDashboardAuthCookie(cookieStore, request, { ...base, sid }, { exp: fromExp });
  return true;
}
