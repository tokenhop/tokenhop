import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import {
  buildSamlAuthorizeUrl,
  getSamlBaseUrl,
  isSamlConfigured,
  SAML_INVITE_COOKIE,
  sealSamlInvite,
} from "@/lib/auth/saml.js";
import { readInviteStartBody } from "@/lib/auth/oidc";
import { resolveAuthModes } from "@/lib/auth/authModes";
import { OWNER_TRANSFER_COOKIE } from "@/lib/auth/ownershipTransferState.js";
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

// Shared GET/POST core. `inviteProof` (already validated) is sealed bound to
// this request's ID, mirroring the OIDC state binding.
async function beginLogin(request, settings, inviteProof) {
  if (!resolveAuthModes(settings).saml || !isSamlConfigured(settings)) {
    console.warn("[SAML] start failed: saml_not_configured");
    return {
      response: NextResponse.redirect(
        new URL("/login?error=saml_not_configured", getSamlBaseUrl(request, settings)),
      ),
    };
  }

  const { authorizeUrl, requestId } = await buildSamlAuthorizeUrl(request, settings);

  // Seal before ANY cookie is set: a seal failure must leave no partial state.
  // The invite token itself never leaves the server: only this encrypted,
  // request-bound cookie does (10-minute single-flow TTL).
  const sealedInvite = inviteProof ? await sealSamlInvite(inviteProof, requestId) : null;

  const cookieStore = await cookies();
  const cookieOptions = startCookieOptions(request);
  cookieStore.set("saml_state", requestId, cookieOptions);
  // YAN-360: a normal login supersedes any abandoned ownership-transfer flow.
  cookieStore.delete(OWNER_TRANSFER_COOKIE);
  await stashSetupToken(request, cookieStore, cookieOptions);
  if (sealedInvite) cookieStore.set(SAML_INVITE_COOKIE, sealedInvite, cookieOptions);

  return { response: NextResponse.redirect(authorizeUrl), authorizeUrl };
}

export async function GET(request) {
  const settings = await getSettings();
  const origin = getSamlBaseUrl(request, settings);
  try {
    const { response } = await beginLogin(request, settings, null);
    return withStartHeaders(response);
  } catch (error) {
    console.warn("[SAML] start failed:", error?.message || error);
    return withStartHeaders(
      NextResponse.redirect(new URL("/login?error=saml_start_failed", origin)),
    );
  }
}

// YAN-360: invitation acceptance start. Same-origin JSON POST keeps the
// invitation token off every URL, the IdP redirect and the Referer; it is parked
// in the sealed, request-bound saml_invite cookie for the ACS callback. fetch
// cannot follow a cross-site 307 (it would also replay the token body to the
// IdP), so success answers 200 JSON and the client navigates to `redirectUrl`.
function noStoreJson(body, status = 200) {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export async function POST(request) {
  const settings = await getSettings();
  try {
    const guard = await readInviteStartBody(request);
    if (guard.response) return guard.response;
    const { authorizeUrl } = await beginLogin(request, settings, guard.invitationToken);
    if (!authorizeUrl) {
      // Not configured: fixed safe failure, never a cross-site POST redirect.
      return noStoreJson({ error: "SSO is not configured", code: "saml_not_configured" }, 400);
    }
    return noStoreJson({ redirectUrl: String(authorizeUrl) });
  } catch (error) {
    console.warn("[SAML] invitation start failed:", error?.message || error);
    return noStoreJson({ error: "SSO start failed", code: "saml_start_failed" }, 500);
  }
}
