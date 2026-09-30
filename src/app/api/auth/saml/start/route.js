import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import { buildSamlAuthorizeUrl, getSamlBaseUrl, isSamlConfigured } from "@/lib/auth/saml.js";
import { resolveAuthModes } from "@/lib/auth/authModes";
import { shouldUseSecureCookie } from "@/lib/auth/dashboardSession";

export async function GET(request) {
  const settings = await getSettings();
  const origin = getSamlBaseUrl(request, settings);
  try {
    if (!resolveAuthModes(settings).saml || !isSamlConfigured(settings)) {
      console.warn("[SAML] start failed: saml_not_configured");
      return NextResponse.redirect(new URL("/login?error=saml_not_configured", origin));
    }

    const { authorizeUrl, requestId } = await buildSamlAuthorizeUrl(request, settings);

    const cookieStore = await cookies();
    cookieStore.set("saml_state", requestId, {
      httpOnly: true,
      secure: shouldUseSecureCookie(request),
      sameSite: "lax",
      path: "/",
      maxAge: 10 * 60,
    });

    return NextResponse.redirect(authorizeUrl);
  } catch (error) {
    console.warn("[SAML] start failed:", error?.message || error);
    return NextResponse.redirect(new URL("/login?error=saml_start_failed", origin));
  }
}
