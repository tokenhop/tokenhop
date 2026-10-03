import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  buildOidcAuthorizationUrl,
  createOidcNonce,
  createOidcState,
  createPkcePair,
  fetchOidcDiscovery,
  getOidcRuntimeConfig,
  getPublicOrigin,
} from "@/lib/auth/oidc";
import { shouldUseSecureCookie } from "@/lib/auth/dashboardSession";
import { stashSetupToken } from "@/lib/users/bootstrap";

export async function GET(request) {
  try {
    const config = await getOidcRuntimeConfig();
    if (!config) {
      return NextResponse.redirect(
        new URL("/login?error=oidc_not_configured", getPublicOrigin(request)),
      );
    }

    const discovery = await fetchOidcDiscovery(config.issuerUrl);
    const state = createOidcState();
    const nonce = createOidcNonce();
    const { verifier, challenge } = createPkcePair();
    const redirectUri = `${getPublicOrigin(request)}/api/auth/oidc/callback`;
    const authUrl = buildOidcAuthorizationUrl({
      authorizationEndpoint: discovery.authorization_endpoint,
      clientId: config.clientId,
      redirectUri,
      scopes: config.scopes,
      state,
      nonce,
      codeChallenge: challenge,
    });

    const cookieStore = await cookies();
    const baseOptions = {
      httpOnly: true,
      secure: shouldUseSecureCookie(request),
      sameSite: "lax",
      path: "/",
      maxAge: 10 * 60,
    };
    cookieStore.set("oidc_state", state, baseOptions);
    cookieStore.set("oidc_nonce", nonce, baseOptions);
    cookieStore.set("oidc_code_verifier", verifier, baseOptions);
    await stashSetupToken(request, cookieStore, baseOptions);

    return NextResponse.redirect(authUrl);
  } catch (error) {
    // Details stay in the server log; /login only gets a fixed code.
    console.warn("[OIDC] start failed:", error?.message || error);
    return NextResponse.redirect(
      new URL("/login?error=oidc_start_failed", getPublicOrigin(request)),
    );
  }
}
