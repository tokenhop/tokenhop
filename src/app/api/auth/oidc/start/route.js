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
  OIDC_COOKIE_NAMES,
  readInviteStartBody,
  sealInviteState,
} from "@/lib/auth/oidc";
import { shouldUseSecureCookie } from "@/lib/auth/dashboardSession";
import { stashSetupToken } from "@/lib/users/bootstrap";
import { isUserSecurityEnforced } from "@/lib/users/securityState.js";

async function withStartHeaders(response) {
  if (await isUserSecurityEnforced()) response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

function startCookieOptions(request) {
  return {
    httpOnly: true,
    secure: shouldUseSecureCookie(request),
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60,
  };
}

// Shared GET/POST core: mint state/nonce/PKCE, stash the cookies, redirect to
// the IdP. `inviteProof` (already validated) is sealed bound to this state.
async function beginLogin(request, inviteProof) {
  const config = await getOidcRuntimeConfig();
  if (!config) {
    return {
      response: NextResponse.redirect(
        new URL("/login?error=oidc_not_configured", getPublicOrigin(request)),
      ),
    };
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

  // Seal before ANY cookie is set: a seal failure must leave no partial state.
  // The invite token itself never leaves the server: only this encrypted,
  // state-bound cookie does (10-minute single-flow TTL).
  const sealedInvite = inviteProof ? await sealInviteState(inviteProof, state) : null;

  const cookieStore = await cookies();
  const baseOptions = startCookieOptions(request);
  cookieStore.set(OIDC_COOKIE_NAMES.state, state, baseOptions);
  cookieStore.set(OIDC_COOKIE_NAMES.nonce, nonce, baseOptions);
  cookieStore.set(OIDC_COOKIE_NAMES.verifier, verifier, baseOptions);
  await stashSetupToken(request, cookieStore, baseOptions);
  if (sealedInvite) cookieStore.set(OIDC_COOKIE_NAMES.invite, sealedInvite, baseOptions);

  return { response: NextResponse.redirect(authUrl) };
}

export async function GET(request) {
  try {
    const { response } = await beginLogin(request, null);
    return withStartHeaders(response);
  } catch (error) {
    // Details stay in the server log; /login only gets a fixed code.
    console.warn("[OIDC] start failed:", error?.message || error);
    return withStartHeaders(
      NextResponse.redirect(new URL("/login?error=oidc_start_failed", getPublicOrigin(request))),
    );
  }
}

// YAN-360: invitation acceptance start. Same-origin POST keeps the invitation
// token off every URL, the IdP redirect and the Referer; it is parked in the
// sealed, state-bound oidc_invite cookie for the callback.
export async function POST(request) {
  try {
    const guard = await readInviteStartBody(request);
    if (guard.response) return guard.response;
    const { response } = await beginLogin(request, guard.invitationToken);
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch (error) {
    console.warn("[OIDC] invitation start failed:", error?.message || error);
    return withStartHeaders(
      NextResponse.redirect(new URL("/login?error=oidc_start_failed", getPublicOrigin(request))),
    );
  }
}
