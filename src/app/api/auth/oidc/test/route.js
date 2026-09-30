import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import {
  fetchOidcDiscovery,
  getPublicOrigin,
  probeOidcClientSecret,
  summarizeOidcSigning,
} from "@/lib/auth/oidc";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";

async function canAccessTestRoute() {
  const settings = await getSettings();
  if (settings.requireLogin === false) return true;

  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  return await verifyDashboardAuthToken(token);
}

async function countJwksKeys(jwksUri) {
  if (!jwksUri) return null;
  try {
    const response = await fetch(jwksUri, { cache: "no-store" });
    if (!response.ok) return null;
    const jwks = await response.json();
    return Array.isArray(jwks?.keys) ? jwks.keys.length : null;
  } catch {
    return null;
  }
}

export async function POST(request) {
  try {
    if (!(await canAccessTestRoute())) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const settings = await getSettings();

    const issuerUrl = String(body.issuerUrl || settings.oidcIssuerUrl || "").trim();
    const clientId = String(body.clientId || settings.oidcClientId || "").trim();
    const scopes =
      String(body.scopes || settings.oidcScopes || "openid profile email").trim() ||
      "openid profile email";
    const clientSecret = String(
      Object.hasOwn(body, "clientSecret") ? body.clientSecret : settings.oidcClientSecret || "",
    ).trim();

    if (!issuerUrl) {
      return NextResponse.json({ error: "Issuer URL is required" }, { status: 400 });
    }
    if (!clientId) {
      return NextResponse.json({ error: "Client ID is required" }, { status: 400 });
    }

    const discovery = await fetchOidcDiscovery(issuerUrl);
    const redirectUri = `${getPublicOrigin(request)}/api/auth/oidc/callback`;
    const secretProbe = await probeOidcClientSecret({
      tokenEndpoint: discovery.token_endpoint,
      clientId,
      clientSecret,
      redirectUri,
    });

    const jwksKeyCount = await countJwksKeys(discovery.jwks_uri);
    const signing = summarizeOidcSigning(discovery, jwksKeyCount);

    if (secretProbe.tested && secretProbe.valid === false) {
      return NextResponse.json({
        ok: false,
        discoveryOk: true,
        clientSecretTested: true,
        clientSecretValid: false,
        issuerUrl,
        clientId,
        scopes,
        redirectUri,
        authorizationEndpoint: discovery.authorization_endpoint || "",
        tokenEndpoint: discovery.token_endpoint || "",
        jwksUri: discovery.jwks_uri || "",
        signingAlgs: signing.signingAlgs,
        jwksKeyCount,
        warnings: signing.warnings,
        error: `Discovery loaded, but the client secret is not valid: ${secretProbe.message}`,
      });
    }

    return NextResponse.json({
      ok: true,
      discoveryOk: true,
      clientSecretTested: secretProbe.tested,
      clientSecretValid: secretProbe.valid,
      issuerUrl,
      clientId,
      scopes,
      redirectUri,
      authorizationEndpoint: discovery.authorization_endpoint || "",
      tokenEndpoint: discovery.token_endpoint || "",
      jwksUri: discovery.jwks_uri || "",
      signingAlgs: signing.signingAlgs,
      jwksKeyCount,
      warnings: signing.warnings,
      message: secretProbe.message,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message || "OIDC test failed" }, { status: 500 });
  }
}
