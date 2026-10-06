import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import { buildSamlAuthorizeUrl, getSamlBaseUrl, isSamlConfigured } from "@/lib/auth/saml.js";
import { resolveAuthModes } from "@/lib/auth/authModes";
import { shouldUseSecureCookie } from "@/lib/auth/dashboardSession";
import { stashSetupToken } from "@/lib/users/bootstrap";
import { isUserSecurityEnforced } from "@/lib/users/securityState.js";

async function withStartHeaders(response) {
  if (await isUserSecurityEnforced()) response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export async function GET(request) {
  const settings = await getSettings();
  const origin = getSamlBaseUrl(request, settings);
  try {
    if (!resolveAuthModes(settings).saml || !isSamlConfigured(settings)) {
      console.warn("[SAML] start failed: saml_not_configured");
      return withStartHeaders(
        NextResponse.redirect(new URL("/login?error=saml_not_configured", origin)),
      );
    }

    const { authorizeUrl, requestId } = await buildSamlAuthorizeUrl(request, settings);

    const cookieStore = await cookies();
    const cookieOptions = {
      httpOnly: true,
      secure: shouldUseSecureCookie(request),
      sameSite: "lax",
      path: "/",
      maxAge: 10 * 60,
    };
    cookieStore.set("saml_state", requestId, cookieOptions);
    await stashSetupToken(request, cookieStore, cookieOptions);

    return withStartHeaders(NextResponse.redirect(authorizeUrl));
  } catch (error) {
    console.warn("[SAML] start failed:", error?.message || error);
    return withStartHeaders(
      NextResponse.redirect(new URL("/login?error=saml_start_failed", origin)),
    );
  }
}
