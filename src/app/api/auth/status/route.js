import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import { getLegacyPasswordHash } from "@/lib/db/index.js";
import { isOidcConfigured } from "@/lib/auth/oidc";
import { isSamlConfigured } from "@/lib/auth/saml.js";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { PASSWORD_CHANGE_COOKIE, getPasswordChangeUser } from "@/lib/auth/passwordChangeSession";
import { resolveAuthModes } from "@/lib/auth/authModes";
import { isUserSecurityEnforced } from "@/lib/users/securityState";
import {
  describePrincipal,
  getPrincipal,
  isLiveSession,
  singleUserMode,
} from "@/lib/users/session";
import { multiUserActive } from "@/lib/users/bootstrap";

export async function GET() {
  try {
    const settings = await getSettings();
    // YAN-362: after owner bootstrap the hash lives on users, not the blob.
    const hasPassword = !!(await getLegacyPasswordHash(settings));
    const cookieStore = await cookies();
    const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);
    // Login off only sticks in true single-user installs; a restored DB with
    // two users and requireLogin=false stays closed.
    const requireLogin = !(await singleUserMode(settings));
    const authMode = settings.authMode || "password";
    const ssoType = resolveAuthModes(settings).protocol;
    const oidcName = String(session?.oidcName || "").trim();
    const oidcEmail = String(session?.oidcEmail || "").trim();
    const samlName = String(session?.samlName || "").trim();
    const samlEmail = String(session?.samlEmail || "").trim();

    const displayName =
      samlName ||
      samlEmail ||
      oidcName ||
      oidcEmail ||
      (session?.saml ? "SAML user" : session?.oidc ? "OIDC user" : "Password user");

    const loginMethod = session?.saml ? "SAML" : session?.oidc ? "OIDC" : "Password";
    // Durable gate (YAN-363): a hashed-security install stays enforced even
    // with the rollout switch back off, so never trust a raw JWT there.
    const enforced = await isUserSecurityEnforced();
    if (enforced) {
      // Forced rotation: short-lived password-change token, never a session.
      const challengeUser = await getPasswordChangeUser(
        cookieStore.get(PASSWORD_CHANGE_COOKIE)?.value,
      );
      if (challengeUser) {
        return NextResponse.json({
          requireLogin,
          authMode,
          ssoType,
          oidcConfigured: isOidcConfigured(settings),
          oidcLoginLabel:
            (settings.oidcLoginLabel || "Sign in with OIDC").trim() || "Sign in with OIDC",
          samlConfigured: isSamlConfigured(settings),
          samlLoginLabel:
            (settings.samlLoginLabel || "Sign in with SAML SSO").trim() || "Sign in with SAML SSO",
          hasPassword,
          displayName,
          loginMethod,
          principal: null,
          multiUserActive: await multiUserActive(),
          userSecurityEnforced: true,
          mustChangePassword: true,
          authenticated: false,
          oidcName: oidcName || null,
          oidcEmail: oidcEmail || null,
          oidcLogin: !!session?.oidc,
          samlName: samlName || null,
          samlEmail: samlEmail || null,
          samlLogin: !!session?.saml,
        });
      }
    }
    // Users & teams (YAN-355): who the request acts as. Absent while
    // unenforced, so the pristine payload stays byte-identical there.
    // A revoked session (sessionVersion bumped) no longer counts as signed in.
    const securityField = enforced
      ? {
          principal: await describePrincipal(await getPrincipal()),
          multiUserActive: await multiUserActive(),
          userSecurityEnforced: true,
          mustChangePassword: false,
        }
      : {};
    const authenticated = enforced
      ? await isLiveSession(cookieStore.get("auth_token")?.value)
      : !!session;

    return NextResponse.json({
      requireLogin,
      authMode,
      ssoType,
      oidcConfigured: isOidcConfigured(settings),
      oidcLoginLabel:
        (settings.oidcLoginLabel || "Sign in with OIDC").trim() || "Sign in with OIDC",
      samlConfigured: isSamlConfigured(settings),
      samlLoginLabel:
        (settings.samlLoginLabel || "Sign in with SAML SSO").trim() || "Sign in with SAML SSO",
      hasPassword,
      displayName,
      loginMethod,
      ...securityField,
      authenticated,
      oidcName: oidcName || null,
      oidcEmail: oidcEmail || null,
      oidcLogin: !!session?.oidc,
      samlName: samlName || null,
      samlEmail: samlEmail || null,
      samlLogin: !!session?.saml,
    });
  } catch {
    return NextResponse.json({
      requireLogin: true,
      authMode: "password",
      ssoType: "oidc",
      oidcConfigured: false,
      oidcLoginLabel: "Sign in with OIDC",
      samlConfigured: false,
      samlLoginLabel: "Sign in with SAML SSO",
      hasPassword: false,
      displayName: "Password user",
      loginMethod: "Password",
      authenticated: false,
      oidcName: null,
      oidcEmail: null,
      oidcLogin: false,
      samlName: null,
      samlEmail: null,
      samlLogin: false,
    });
  }
}
