import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import {
  fetchOidcDiscovery,
  getPublicOrigin,
  probeOidcClientSecret,
  summarizeOidcSigning,
} from "@/lib/auth/oidc";

async function countJwksKeys(jwksUri) {
  if (!jwksUri) return null;
  try {
    const response = await fetch(jwksUri, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const jwks = await response.json();
    return Array.isArray(jwks?.keys) ? jwks.keys.length : null;
  } catch {
    return null;
  }
}

// The client secret is the one credential this route handles: it must never
// appear in a response body or error message, even if the IdP echoes it back.
const redactSecret = (text, secret) =>
  secret
    ? String(text ?? "")
        .split(secret)
        .join("[REDACTED]")
    : String(text ?? "");

export async function POST(request) {
  const body = (await request.json().catch(() => null)) ?? {};
  try {
    // Trusted runtime read: decrypts oidcClientSecret on established storage.
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
        error: `Discovery loaded, but the client secret is not valid: ${redactSecret(secretProbe.message, clientSecret)}`,
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
      message: redactSecret(secretProbe.message, clientSecret),
    });
  } catch (error) {
    let secret = "";
    try {
      secret =
        String(body?.clientSecret || "") || String((await getSettings()).oidcClientSecret || "");
    } catch {
      // settings/decrypt failure: no stored secret to redact; error text stays generic below.
    }
    return NextResponse.json(
      { error: redactSecret(error?.message, secret) || "OIDC test failed" },
      { status: 500 },
    );
  }
}
