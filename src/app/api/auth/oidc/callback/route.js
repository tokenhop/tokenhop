import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  exchangeOidcCode,
  fetchOidcDiscovery,
  getOidcRuntimeConfig,
  getPublicOrigin,
  pickOidcDisplayName,
  pickOidcEmail,
  verifyOidcIdToken,
} from "@/lib/auth/oidc";
import { setDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import { sessionClaims } from "@/lib/users/session";
import { takeSetupToken } from "@/lib/users/bootstrap";

function clearOidcCookies(cookieStore) {
  cookieStore.delete("oidc_state");
  cookieStore.delete("oidc_nonce");
  cookieStore.delete("oidc_code_verifier");
}

export async function GET(request) {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) {
    console.warn("[OIDC] provider returned error:", error);
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(error)}`, getPublicOrigin(request)),
    );
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return NextResponse.redirect(
      new URL("/login?error=oidc_missing_code", getPublicOrigin(request)),
    );
  }

  const cookieStore = await cookies();
  const storedState = cookieStore.get("oidc_state")?.value;
  const storedNonce = cookieStore.get("oidc_nonce")?.value;
  const codeVerifier = cookieStore.get("oidc_code_verifier")?.value;

  if (!storedState || !storedNonce || !codeVerifier || storedState !== state) {
    clearOidcCookies(cookieStore);
    return NextResponse.redirect(
      new URL("/login?error=oidc_invalid_state", getPublicOrigin(request)),
    );
  }

  try {
    const config = await getOidcRuntimeConfig();
    if (!config) {
      clearOidcCookies(cookieStore);
      return NextResponse.redirect(
        new URL("/login?error=oidc_not_configured", getPublicOrigin(request)),
      );
    }

    const discovery = await fetchOidcDiscovery(config.issuerUrl);
    const discoveredIssuer = discovery.issuer || config.issuerUrl;
    const redirectUri = `${getPublicOrigin(request)}/api/auth/oidc/callback`;
    const tokenData = await exchangeOidcCode({
      tokenEndpoint: discovery.token_endpoint,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      redirectUri,
      codeVerifier,
    });

    if (!tokenData.id_token) {
      throw new Error("OIDC provider did not return an id_token");
    }

    const payload = await verifyOidcIdToken({
      idToken: tokenData.id_token,
      issuer: discoveredIssuer,
      audience: config.clientId,
      jwksUri: discovery.jwks_uri,
      nonce: storedNonce,
      clientSecret: config.clientSecret,
      allowedAlgs: discovery.id_token_signing_alg_values_supported,
    });

    clearOidcCookies(cookieStore);
    const identity = {
      provider: "oidc",
      issuer: payload.iss || discoveredIssuer,
      subject: payload.sub,
      email: pickOidcEmail(payload),
      emailVerified: payload.email_verified === true,
    };
    const setupToken = takeSetupToken(cookieStore);
    const claims = await sessionClaims("oidc", identity, { setupToken });
    if (!claims) {
      return NextResponse.redirect(
        new URL("/login?error=sso_not_linked", getPublicOrigin(request)),
      );
    }
    await setDashboardAuthCookie(cookieStore, request, {
      ...claims,
      oidc: true,
      oidcSub: payload.sub || null,
      oidcEmail: pickOidcEmail(payload) || null,
      oidcName: pickOidcDisplayName(payload),
    });

    return NextResponse.redirect(new URL("/dashboard", getPublicOrigin(request)));
  } catch (error) {
    console.warn("[OIDC] callback failed:", error?.message || error);
    clearOidcCookies(cookieStore);
    return NextResponse.redirect(
      new URL("/login?error=oidc_callback_failed", getPublicOrigin(request)),
    );
  }
}
