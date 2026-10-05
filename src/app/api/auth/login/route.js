import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { setDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import { resolveStartPage } from "@/lib/settingsFlags";
import { isOidcConfigured } from "@/lib/auth/oidc";
import { isSamlConfigured } from "@/lib/auth/saml.js";
import { resolveAuthModes } from "@/lib/auth/authModes";
import {
  checkLock,
  recordFail,
  recordSuccess,
  getClientIp,
  checkLoginLocks,
  recordLoginFail,
  clearAccount,
  accountKey,
} from "@/lib/auth/loginLimiter";
import {
  verifyPassword,
  resolveLoginUser,
  MIN_PASSWORD_LENGTH,
  DEFAULT_PASSWORD,
  DUMMY_HASH,
} from "@/lib/auth/userPassword";
import {
  setPasswordChangeCookie,
  clearPasswordChangeCookie,
} from "@/lib/auth/passwordChangeSession";
import { isLocalRequest } from "@/dashboardGuard";
import { audit } from "@/lib/users/audit";
import { sessionClaims, passwordSessionClaims } from "@/lib/users/session";
import { getEffectivePreferences } from "@/lib/db/index.js";
import { isUserSecurityEnforced } from "@/lib/users/securityState";
import { ensureOwnerBootstrap, multiUserActive } from "@/lib/users/bootstrap";
import {
  getLegacyPasswordHash,
  getOwnerUnscoped,
  getUserPasswordHashUnscoped,
} from "@/lib/db/index.js";
import { ACTIVE } from "@/shared/brand";

const RESET_HINT = `Forgot password? Reset to default via ${ACTIVE.name} CLI → Settings → Reset password to default.`;
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

const MAX_LOGIN_LENGTH = 320;
const MAX_PASSWORD_LENGTH = 1024;
const INVALID_CREDENTIALS_BODY = {
  error: "Invalid email/username or password.",
  code: "invalid_credentials",
};

function isTunnelRequest(request, settings) {
  const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
  const tunnelHost = settings.tunnelUrl ? new URL(settings.tunnelUrl).hostname.toLowerCase() : "";
  const tailscaleHost = settings.tailscaleUrl
    ? new URL(settings.tailscaleUrl).hostname.toLowerCase()
    : "";
  return (tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost);
}

function lockedResponse(lock) {
  return NextResponse.json(
    {
      error: `Too many failed attempts. Try again in ${lock.retryAfter}s. ${RESET_HINT}`,
      retryAfter: lock.retryAfter,
      resetHint: RESET_HINT,
    },
    {
      status: 429,
      headers: { "Retry-After": String(lock.retryAfter), ...NO_STORE_HEADERS },
    },
  );
}

function invalidCredentials() {
  return NextResponse.json(INVALID_CREDENTIALS_BODY, {
    status: 401,
    headers: NO_STORE_HEADERS,
  });
}

// Established security (YAN-358): explicit login or owner-only fallback,
// independent IP + account lockouts, uniform credential failures.
async function handleEstablishedLogin(request, settings, ip, login, password) {
  // Cheapest check first: no DB reads or bcrypt for a locked-out source.
  const ipLock = checkLock(ip);
  if (ipLock.locked) {
    audit(
      { ip },
      "auth.loginFailed",
      { type: "user" },
      { after: { reason: "locked" }, result: "failure" },
    );
    return lockedResponse(ipLock);
  }

  // Preserve tunnel and configured-SSO-only refusal before any credential work.
  if (isTunnelRequest(request, settings) && settings.tunnelDashboardAccess !== true) {
    return NextResponse.json(
      { error: "Dashboard access via tunnel is disabled" },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }
  const modes = resolveAuthModes(settings);
  if (modes.ssoOnly) {
    if (modes.saml && isSamlConfigured(settings)) {
      return NextResponse.json(
        { error: "Password login is disabled. Use SAML SSO sign in." },
        { status: 403, headers: NO_STORE_HEADERS },
      );
    }
    if (modes.oidc && isOidcConfigured(settings)) {
      return NextResponse.json(
        { error: "Password login is disabled. Use OIDC sign in." },
        { status: 403, headers: NO_STORE_HEADERS },
      );
    }
  }

  await ensureOwnerBootstrap();

  const multiUser = await multiUserActive();
  let user = null;
  if (typeof login === "string" && login.trim()) {
    // Supplied identifier resolves explicitly only; never owner fallback.
    user = await resolveLoginUser(login.trim());
  } else if (!multiUser) {
    user = await getOwnerUnscoped();
  } // Missing login while multiUserActive → generic 401 below.

  // Unknown/passwordless accounts still perform one cost-10 comparison.
  // Only the owner may use INITIAL_PASSWORD during null-hash recovery.
  const account = accountKey({
    userId: user?.id ?? null,
    login: user ? null : login,
  });
  const accountLock = checkLoginLocks({ ip, account });
  if (accountLock.locked) {
    audit(
      { ip },
      "auth.loginFailed",
      { type: "user" },
      { after: { reason: "locked" }, result: "failure" },
    );
    return lockedResponse(accountLock);
  }

  let hash = null;
  if (user) hash = await getUserPasswordHashUnscoped(user.id);
  const compared = await verifyPassword(password, hash);
  const ownerFallback =
    user?.instanceRole === "owner" &&
    hash == null &&
    password === (process.env.INITIAL_PASSWORD || DEFAULT_PASSWORD);
  const valid = user != null && (ownerFallback || compared);

  if (!valid) {
    if (account) recordLoginFail({ ip, account });
    else recordFail(ip);
    const postLock = checkLoginLocks({ ip, account });
    audit(
      user ? { principal: { userId: user.id, via: "session" }, ip } : { ip },
      "auth.loginFailed",
      { type: "user", id: user?.id },
      { after: { reason: "invalid" }, result: "failure" },
    );
    if (postLock.locked) return lockedResponse(postLock);
    return invalidCredentials();
  }

  // Correct password. Remotely, public-default credentials never unlock
  // anything, even when an env or stored hash equals the default value.
  const remoteDefault = !isLocalRequest(request) && password === DEFAULT_PASSWORD;
  if (remoteDefault) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Default password must be changed before remote access. Change it from the local machine (or set INITIAL_PASSWORD).",
        code: "default_password_remote",
        mustChangePassword: true,
      },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  if (user.status === "disabled") {
    audit(
      { principal: { userId: user.id, via: "session" }, ip },
      "auth.loginFailed",
      { type: "user", id: user.id },
      { after: { reason: "disabled" }, result: "failure" },
    );
    return NextResponse.json(
      { error: "This account has been disabled by an admin.", code: "account_disabled" },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }
  if (user.instanceRole === "pending") {
    audit(
      { principal: { userId: user.id, via: "session" }, ip },
      "auth.loginFailed",
      { type: "user", id: user.id },
      { after: { reason: "pending" }, result: "failure" },
    );
    return NextResponse.json(
      {
        error: "This account is waiting for an admin to approve it.",
        code: "account_pending",
      },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  if (user.mustChangePassword === 1 || ownerFallback) {
    audit(
      { principal: { userId: user.id, via: "session" }, ip },
      "auth.loginFailed",
      { type: "user", id: user.id },
      { after: { reason: "mustChangePassword" }, result: "failure" },
    );
    const cookieStore = await cookies();
    await setPasswordChangeCookie(cookieStore, request, user);
    return NextResponse.json(
      {
        error: "Your password must be changed before you can sign in.",
        code: "password_change_required",
        mustChangePassword: true,
        reason: ownerFallback ? "initial" : "temporary",
        passwordMinLength: MIN_PASSWORD_LENGTH,
      },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  if (account) clearAccount(account);

  // Fresh live-user claims (YAN-358 Step 3); pristine sessionClaims stays untouched.
  const claims = await passwordSessionClaims(user.id);
  if (!claims?.sub) {
    return NextResponse.json(
      { error: "Internal server error", code: "internal_error" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
  const cookieStore = await cookies();
  await setDashboardAuthCookie(cookieStore, request, claims);
  clearPasswordChangeCookie(cookieStore);
  audit(
    { principal: { userId: user.id, via: "session" }, ip },
    "auth.login",
    { type: "user", id: user.id },
    { after: { provider: "password" } },
  );
  // YAN-362: the fresh login's user row wins over the instance startPage.
  // getEffectivePreferences(null)/switch-off returns the instance blob, so
  // single-admin behavior is unchanged (the ctx only carries the logged-in user).
  const effective = await getEffectivePreferences({
    userId: user.id,
    activeWorkspaceId: claims?.wid ?? null,
  });
  return NextResponse.json(
    {
      success: true,
      mustChangePassword: false,
      startPage: resolveStartPage(effective?.startPage ?? settings.startPage),
    },
    { headers: NO_STORE_HEADERS },
  );
}

export async function POST(request) {
  try {
    const settings = await getSettings();
    const established = await isUserSecurityEnforced();

    if (established) {
      let body;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json(
          { error: "Invalid request", code: "invalid_request" },
          { status: 400, headers: NO_STORE_HEADERS },
        );
      }
      const login = body?.login;
      const password = body?.password;
      if (
        (login !== undefined && (typeof login !== "string" || login.length > MAX_LOGIN_LENGTH)) ||
        typeof password !== "string" ||
        password.length > MAX_PASSWORD_LENGTH
      ) {
        return NextResponse.json(
          { error: "Invalid request", code: "invalid_request" },
          { status: 400, headers: NO_STORE_HEADERS },
        );
      }
      return await handleEstablishedLogin(request, settings, getClientIp(request), login, password);
    }

    const ip = getClientIp(request);
    const lock = checkLock(ip);
    if (lock.locked) {
      return NextResponse.json(
        {
          error: `Too many failed attempts. Try again in ${lock.retryAfter}s. ${RESET_HINT}`,
          retryAfter: lock.retryAfter,
          resetHint: RESET_HINT,
        },
        { status: 429, headers: { "Retry-After": String(lock.retryAfter) } },
      );
    }

    const { password } = await request.json();

    // Block login via tunnel/tailscale if dashboard access is disabled
    if (isTunnelRequest(request, settings) && settings.tunnelDashboardAccess !== true) {
      return NextResponse.json(
        { error: "Dashboard access via tunnel is disabled" },
        { status: 403 },
      );
    }

    // Default password is '123456' if not set
    const storedHash = await getLegacyPasswordHash(settings);

    const modes = resolveAuthModes(settings);
    if (modes.ssoOnly) {
      if (modes.saml && isSamlConfigured(settings)) {
        return NextResponse.json(
          { error: "Password login is disabled. Use SAML SSO sign in." },
          { status: 403 },
        );
      }
      if (modes.oidc && isOidcConfigured(settings)) {
        return NextResponse.json(
          { error: "Password login is disabled. Use OIDC sign in." },
          { status: 403 },
        );
      }
    }

    let isValid = false;
    if (storedHash) {
      isValid = await bcrypt.compare(password, storedHash);
    } else {
      // Use env var or default
      const initialPassword = process.env.INITIAL_PASSWORD || "123456";
      isValid = password === initialPassword;
    }

    if (isValid) {
      recordSuccess(ip);

      // Default password still in use on a remote client → force a password
      // change before the dashboard is exposed remotely (keeps local UX intact).
      const mustChangePassword =
        !storedHash && !process.env.INITIAL_PASSWORD && !isLocalRequest(request);

      if (mustChangePassword) {
        // Do NOT issue a session token: a fresh install's default password is
        // public knowledge ("123456"), so handing out a valid JWT would let any
        // remote attacker authenticate and (e.g.) PATCH /api/settings to disable
        // authentication entirely (CVE-2026-56679 class). Require the password
        // to be changed first.
        //
        // NOTE: this intentionally leaves no remote self-service password-change
        // path — the change-password flow (PATCH /api/settings) requires a JWT,
        // which we deliberately withhold. A remote fresh-install user must either
        // change the password from the local machine or set INITIAL_PASSWORD
        // before first launch. This is a deliberate security trade-off, not an
        // oversight: issuing any credential before the default password is
        // rotated re-opens the exact attack chain this branch closes.
        return NextResponse.json(
          {
            success: false,
            error:
              "Default password must be changed before remote access. Change it from the local machine (or set INITIAL_PASSWORD).",
            mustChangePassword,
          },
          { status: 403, headers: NO_STORE_HEADERS },
        );
      }

      const cookieStore = await cookies();
      await setDashboardAuthCookie(cookieStore, request, await sessionClaims("pwd"));
      audit({ ip }, "auth.login", { type: "user" }, { after: { provider: "password" } });

      return NextResponse.json(
        {
          success: true,
          mustChangePassword: false,
          startPage: resolveStartPage(settings.startPage),
        },
        { headers: NO_STORE_HEADERS },
      );
    }

    const { remainingBeforeLock } = recordFail(ip);
    audit(
      { ip },
      "auth.loginFailed",
      { type: "user" },
      { after: { reason: "invalid" }, result: "failure" },
    );
    const postLock = checkLock(ip);
    if (postLock.locked) {
      return NextResponse.json(
        {
          error: `Too many failed attempts. Try again in ${postLock.retryAfter}s. ${RESET_HINT}`,
          retryAfter: postLock.retryAfter,
          resetHint: RESET_HINT,
        },
        { status: 429, headers: { "Retry-After": String(postLock.retryAfter) } },
      );
    }
    return NextResponse.json(
      {
        error: `Invalid password. ${remainingBeforeLock} attempt(s) left before lockout.`,
        remainingBeforeLock,
      },
      { status: 401 },
    );
  } catch (error) {
    console.error("[auth/login] unexpected error:", error);
    return NextResponse.json(
      { error: "Internal server error", code: "internal_error" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
