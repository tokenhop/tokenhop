import { getSessionUserUnscoped } from "@/lib/db/index.js";
import {
  createDashboardAuthToken,
  readSignedAuthToken,
  shouldUseSecureCookie,
} from "./dashboardSession";

export const PASSWORD_CHANGE_COOKIE = "password_change_token";
const PURPOSE = "password-change";
const MAX_AGE_SEC = 600;
const COOKIE_PATH = "/api/auth";

// Short-lived, non-authenticated token: only valid for the password-change endpoint.
export async function setPasswordChangeCookie(cookieStore, request, user) {
  const token = await createDashboardAuthToken(
    {
      sub: user.id,
      sv: user.sessionVersion,
      amr: ["pwd"],
      purpose: PURPOSE,
      authenticated: false,
    },
    "10m",
  );
  cookieStore.delete("auth_token");
  cookieStore.set(PASSWORD_CHANGE_COOKIE, token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(request),
    sameSite: "strict",
    path: COOKIE_PATH,
    maxAge: MAX_AGE_SEC,
  });
}

export function clearPasswordChangeCookie(cookieStore) {
  cookieStore.set(PASSWORD_CHANGE_COOKIE, "", {
    httpOnly: true,
    sameSite: "strict",
    path: COOKIE_PATH,
    maxAge: 0,
    expires: new Date(0),
  });
}

// Returns the live user the token stands for, else null (fails closed).
export async function getPasswordChangeUser(token) {
  try {
    const payload = await readSignedAuthToken(token);
    if (!payload || payload.purpose !== PURPOSE || payload.authenticated !== false) return null;
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    const user = await getSessionUserUnscoped(payload.sub);
    if (
      user?.status !== "active" ||
      user.instanceRole === "pending" ||
      user.mustChangePassword !== 1 ||
      user.sessionVersion !== payload.sv
    ) {
      return null;
    }
    return user;
  } catch {
    return null;
  }
}
