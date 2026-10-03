import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import {
  getSamlBaseUrl,
  isSamlConfigured,
  pickSamlDisplayName,
  pickSamlEmail,
  validateSamlResponse,
} from "@/lib/auth/saml.js";
import { setDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import { sessionClaims } from "@/lib/users/session";
import { takeSetupToken } from "@/lib/users/bootstrap";
import { resolveAuthModes } from "@/lib/auth/authModes";
import { checkLock, recordFail, recordSuccess, getClientIp } from "@/lib/auth/loginLimiter";

export async function POST(request) {
  const settings = await getSettings();
  const origin = getSamlBaseUrl(request, settings);
  const ip = getClientIp(request);

  const lock = checkLock(ip);
  if (lock.locked) {
    return NextResponse.redirect(new URL("/login?error=too_many_attempts", origin));
  }

  const cookieStore = await cookies();
  const storedRequestId = cookieStore.get("saml_state")?.value || "";

  // Always clear saml_state cookie after attempt
  cookieStore.delete("saml_state");

  try {
    const formData = await request.formData();
    const SAMLResponse = formData.get("SAMLResponse");

    if (!SAMLResponse) {
      recordFail(ip);
      return NextResponse.redirect(new URL("/login?error=saml_missing_response", origin));
    }

    if (!resolveAuthModes(settings).saml || !isSamlConfigured(settings)) {
      console.warn("[SAML] ACS failed: saml_not_configured");
      recordFail(ip);
      return NextResponse.redirect(new URL("/login?error=saml_not_configured", origin));
    }

    const profile = await validateSamlResponse(
      request,
      { SAMLResponse },
      storedRequestId,
      settings,
    );

    const samlEmail = pickSamlEmail(profile, settings) || null;
    const samlName = pickSamlDisplayName(profile, settings) || "SAML user";

    // The assertion is signed by the configured IdP (validateSamlResponse), so
    // its email counts as verified for TOKENHOP_OWNER_EMAIL (ADR-0003).
    const identity = {
      provider: "saml",
      issuer: profile.issuer || "",
      subject: profile.nameID,
      email: samlEmail,
      emailVerified: true,
    };
    const setupToken = takeSetupToken(cookieStore);
    const claims = await sessionClaims("saml", identity, { setupToken });
    if (!claims) return NextResponse.redirect(new URL("/login?error=sso_not_linked", origin));
    recordSuccess(ip);

    await setDashboardAuthCookie(cookieStore, request, {
      ...claims,
      saml: true,
      samlEmail,
      samlName,
    });

    return NextResponse.redirect(new URL("/dashboard", origin));
  } catch (error) {
    console.warn("[SAML] ACS failed:", error?.message || error);
    recordFail(ip);
    return NextResponse.redirect(new URL("/login?error=saml_acs_failed", origin));
  }
}
