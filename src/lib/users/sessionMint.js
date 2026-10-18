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
import { createSessionUnscoped, rebindSessionUnscoped } from "@/lib/db/index.js";
import { coarseIp, describeDevice } from "./deviceLabel.js";
import { isUserSecurityEnforced } from "./securityState.js";

/**
 * Set the `auth_token` cookie, backed by a session row when security is enforced.
 * `from` (the decoded cookie being replaced) keeps its `sid` and `exp` on a re-mint.
 * Returns false only when a re-mint found its row revoked or expired (cookie cleared).
 * Insert errors propagate: never fall back to a sid-less token.
 */
export async function mintSessionCookie(cookieStore, request, claims, { from } = {}) {
  const fromExp = Number.isInteger(from?.exp) ? from.exp : undefined;

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
    if (!(await rebindSessionUnscoped(from.sid, claims.sub, claims.sv))) {
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
    await setDashboardAuthCookie(cookieStore, request, { ...base, sid }, { exp: fromExp });
    return true;
  }

  // Fresh login. A same-user session already in this browser is replaced.
  const exp = nowSec + SESSION_MAX_AGE_SEC;
  const incoming = await readSignedAuthToken(cookieStore?.get?.("auth_token")?.value);
  const replacesId =
    incoming?.sub === claims.sub && typeof incoming.sid === "string" ? incoming.sid : null;

  // Row first: if the insert throws, the login fails and no cookie is set.
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
  await setDashboardAuthCookie(cookieStore, request, { ...base, sid }, { exp });
  return true;
}
