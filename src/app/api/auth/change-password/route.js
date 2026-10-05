// YAN-358: change your own password. The subject comes only from a cookie:
// the restricted password_change_token (forced change after a temporary
// password) or a live full auth_token (self-service). Never from the body.
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { isUserSecurityEnforced } from "@/lib/users/securityState.js";
import { isLiveSession, passwordSessionClaims } from "@/lib/users/session";
import {
  clearDashboardAuthCookie,
  getDashboardAuthSession,
  setDashboardAuthCookie,
} from "@/lib/auth/dashboardSession";
import {
  PASSWORD_CHANGE_COOKIE,
  clearPasswordChangeCookie,
  getPasswordChangeUser,
} from "@/lib/auth/passwordChangeSession";
import {
  DEFAULT_PASSWORD,
  hashPassword,
  validateNewPassword,
  verifyPassword,
} from "@/lib/auth/userPassword.js";
import {
  accountKey,
  checkLoginLocks,
  clearAccount,
  getClientIp,
  recordLoginFail,
} from "@/lib/auth/loginLimiter";
import { isCrossSite, isJson } from "@/lib/auth/sameOrigin.js";
import {
  getEffectivePreferences,
  getSettings,
  getUserPasswordHashUnscoped,
  getUserUnscoped,
  setUserPasswordUnscoped,
} from "@/lib/db/index.js";
import { resolveStartPage } from "@/lib/settingsFlags";

const NO_STORE = { "Cache-Control": "no-store" };
const RESET_HINT =
  "Ask an admin to set a temporary password, or reset the owner password from the CLI.";
const json = (body, status = 200, headers = {}) =>
  NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });
const EXPIRED = {
  error: "Your password change session expired. Sign in again.",
  code: "password_change_expired",
};

function validBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  if (keys.length !== 2) return false;
  return ["currentPassword", "newPassword"].every(
    (k) => typeof body[k] === "string" && body[k].length <= 1024,
  );
}

/** `{ userId, restricted, wid }` from the cookies, or null. */
async function resolveSubject(cookieStore) {
  const challenge = await getPasswordChangeUser(cookieStore.get(PASSWORD_CHANGE_COOKIE)?.value);
  const token = cookieStore.get("auth_token")?.value;
  const full = token && (await isLiveSession(token)) ? await getDashboardAuthSession(token) : null;
  const fullSub = typeof full?.sub === "string" && full.sub ? full.sub : null;
  if (challenge && fullSub && fullSub !== challenge.id) return null; // two different users
  if (challenge) return { userId: challenge.id, restricted: true, wid: null };
  if (fullSub) return { userId: fullSub, restricted: false, wid: full.wid ?? null };
  return null;
}

function expired(cookieStore) {
  clearDashboardAuthCookie(cookieStore);
  clearPasswordChangeCookie(cookieStore);
  return json(EXPIRED, 401);
}

export async function POST(request) {
  try {
    if (!(await isUserSecurityEnforced())) return json({ error: "Not found" }, 404);
    if (isCrossSite(request)) return json({ error: "Forbidden", code: "forbidden_origin" }, 403);
    if (!isJson(request))
      return json({ error: "Unsupported media type", code: "invalid_request" }, 415);

    const body = await request.json().catch(() => null);
    if (!validBody(body)) return json({ error: "Invalid request", code: "invalid_request" }, 400);

    const cookieStore = await cookies();
    const subject = await resolveSubject(cookieStore);
    if (!subject) return expired(cookieStore);
    const user = await getUserUnscoped(subject.userId);
    if (!user) return expired(cookieStore);

    const ip = getClientIp(request);
    const account = accountKey({ userId: user.id });
    const lock = checkLoginLocks({ ip, account });
    if (lock.locked) {
      return json(
        {
          error: `Too many failed attempts. Try again in ${lock.retryAfter}s.`,
          resetHint: RESET_HINT,
          retryAfter: lock.retryAfter,
        },
        429,
        { "Retry-After": String(lock.retryAfter) },
      );
    }

    const hash = await getUserPasswordHashUnscoped(user.id);
    const compared = await verifyPassword(body.currentPassword, hash);
    // Owner null-hash recovery (bootstrap / CLI reset): the current password is
    // INITIAL_PASSWORD or the default, exactly as the login route accepted it.
    const ownerRecovery =
      subject.restricted &&
      hash == null &&
      user.instanceRole === "owner" &&
      body.currentPassword === (process.env.INITIAL_PASSWORD || DEFAULT_PASSWORD);
    if (!compared && !ownerRecovery) {
      recordLoginFail({ ip, account });
      return json({ error: "Invalid current password", code: "invalid_current_password" }, 401);
    }
    clearAccount(account);

    const invalid = validateNewPassword(body.newPassword, {
      current: body.currentPassword,
      temporary: subject.restricted ? body.currentPassword : undefined,
    });
    if (invalid) return json(invalid, 400);

    try {
      await setUserPasswordUnscoped(user.id, {
        passwordHash: await hashPassword(body.newPassword),
        mustChangePassword: false,
        expectedSessionVersion: user.sessionVersion,
      });
    } catch (err) {
      if (err?.code === "STALE") return expired(cookieStore);
      throw err;
    }

    // Fresh claims from the post-commit row: never reuse the old token's sv.
    const claims = await passwordSessionClaims(user.id, subject.wid);
    if (!claims?.sub) return expired(cookieStore);
    await setDashboardAuthCookie(cookieStore, request, claims);
    clearPasswordChangeCookie(cookieStore);
    // YAN-362: the user's effective startPage (instance ⊕ user preference);
    // switch off returns the instance blob, unchanged.
    const effective = await getEffectivePreferences({
      userId: user.id,
      activeWorkspaceId: subject.wid ?? claims?.wid ?? null,
    });
    return json({
      success: true,
      startPage: resolveStartPage(effective?.startPage ?? (await getSettings())?.startPage),
    });
  } catch (err) {
    if (err?.code === "API_KEY_STATE_INVALID") return json({ error: "Service unavailable" }, 503);
    console.error("[auth/change-password] unexpected error:", err);
    return json({ error: "Internal error" }, 500);
  }
}
