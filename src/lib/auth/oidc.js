import crypto from "node:crypto";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { getSettings } from "@/lib/localDb";
import { resolveAuthModes } from "@/lib/auth/authModes";

export const OIDC_COOKIE_NAMES = {
  state: "oidc_state",
  nonce: "oidc_nonce",
  verifier: "oidc_code_verifier",
};

const DEFAULT_SCOPES = "openid profile email";
const DEFAULT_LOGIN_LABEL = "Sign in with OIDC";

function trimTrailingSlashes(value) {
  return (value || "").trim().replace(/\/+$/, "");
}

function normalizeScopes(value) {
  return (value || DEFAULT_SCOPES).trim() || DEFAULT_SCOPES;
}

export function getPublicOrigin(request) {
  const configuredBaseUrl = process.env.BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || "";

  if (configuredBaseUrl) {
    return trimTrailingSlashes(configuredBaseUrl);
  }

  const forwardedProto = request?.headers?.get?.("x-forwarded-proto") || "";
  const forwardedHost = request?.headers?.get?.("x-forwarded-host") || "";
  const host = forwardedHost || request?.headers?.get?.("host") || "";
  if (host) {
    const protocol = (forwardedProto || new URL(request.url).protocol || "http:").replace(/:$/, "");
    return `${protocol}://${host}`.replace(/\/+$/, "");
  }

  return trimTrailingSlashes(new URL(request.url).origin);
}

export function isOidcConfigured(settings) {
  return !!(
    trimTrailingSlashes(settings?.oidcIssuerUrl) &&
    (settings?.oidcClientId || "").trim() &&
    (settings?.oidcClientSecret || "").trim()
  );
}

export async function getOidcRuntimeConfig() {
  const settings = await getSettings();
  if (!resolveAuthModes(settings).oidc || !isOidcConfigured(settings)) return null;

  const issuerUrl = trimTrailingSlashes(settings.oidcIssuerUrl);
  return {
    issuerUrl,
    clientId: settings.oidcClientId.trim(),
    clientSecret: settings.oidcClientSecret.trim(),
    scopes: normalizeScopes(settings.oidcScopes),
    loginLabel: (settings.oidcLoginLabel || DEFAULT_LOGIN_LABEL).trim() || DEFAULT_LOGIN_LABEL,
  };
}

export async function fetchOidcDiscovery(issuerUrl) {
  const discoveryUrl = `${trimTrailingSlashes(issuerUrl)}/.well-known/openid-configuration`;
  const res = await fetch(discoveryUrl, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to load OIDC discovery document from ${discoveryUrl}`);
  }
  return await res.json();
}

export function createPkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function createOidcState() {
  return crypto.randomBytes(16).toString("base64url");
}

export function createOidcNonce() {
  return crypto.randomBytes(16).toString("base64url");
}

export function buildOidcAuthorizationUrl({
  authorizationEndpoint,
  clientId,
  redirectUri,
  scopes = DEFAULT_SCOPES,
  state,
  nonce,
  codeChallenge,
}) {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", normalizeScopes(scopes));
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeOidcCode({
  tokenEndpoint,
  clientId,
  clientSecret,
  code,
  redirectUri,
  codeVerifier,
}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      data?.error_description || data?.error || `OIDC token exchange failed (${res.status})`;
    throw new Error(message);
  }

  return data;
}

export async function probeOidcClientSecret({
  tokenEndpoint,
  clientId,
  clientSecret,
  redirectUri,
}) {
  if (!clientSecret) {
    return {
      tested: false,
      valid: null,
      message: "No client secret was provided, so secret validation was skipped.",
    };
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code: "__oidc_test_invalid_code__",
    redirect_uri: redirectUri,
    code_verifier: "__oidc_test_invalid_verifier__",
  });

  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await res.json().catch(() => ({}));
  const error = (data?.error || "").toLowerCase();
  const errorDescription = data?.error_description || data?.error || "";

  if (res.ok) {
    return {
      tested: true,
      valid: true,
      message: "Client secret was accepted by the token endpoint.",
      raw: data,
    };
  }

  if (
    error === "invalid_client" ||
    error === "unauthorized_client" ||
    /client.*(invalid|failed|mismatch)/i.test(errorDescription)
  ) {
    return {
      tested: true,
      valid: false,
      message: errorDescription || "Client secret is not valid.",
      raw: data,
    };
  }

  if (
    error === "invalid_grant" ||
    error === "invalid_code" ||
    /grant|code/i.test(errorDescription)
  ) {
    return {
      tested: true,
      valid: true,
      message:
        "Client secret was accepted; the token exchange failed only because the test authorization code is invalid.",
      raw: data,
    };
  }

  return {
    tested: true,
    valid: null,
    message: errorDescription || `Token endpoint responded with ${res.status}`,
    raw: data,
  };
}

const DEFAULT_ID_TOKEN_ALGS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
];
const HMAC_ALGS = ["HS256", "HS384", "HS512"];

// Advertised algs minus "none"; asymmetric default when discovery says nothing usable.
function resolveAllowedAlgs(advertised) {
  const algs = Array.isArray(advertised)
    ? advertised.filter((a) => typeof a === "string" && a.toLowerCase() !== "none")
    : [];
  return algs.length > 0 ? algs : DEFAULT_ID_TOKEN_ALGS;
}

export async function verifyOidcIdToken({
  idToken,
  issuer,
  audience,
  jwksUri,
  nonce,
  clientSecret,
  allowedAlgs,
}) {
  const allowed = resolveAllowedAlgs(allowedAlgs);
  const { alg } = decodeProtectedHeader(idToken);
  if (!alg || alg.toLowerCase() === "none" || !allowed.includes(alg)) {
    throw new Error(`id_token alg "${alg}" is not allowed (advertised: ${allowed.join(", ")})`);
  }

  let key;
  if (HMAC_ALGS.includes(alg)) {
    if (!clientSecret) throw new Error(`id_token alg "${alg}" requires a client secret`);
    key = new TextEncoder().encode(clientSecret);
  } else {
    if (!jwksUri) throw new Error("OIDC discovery document has no jwks_uri");
    key = createRemoteJWKSet(new URL(jwksUri));
  }

  // jose has no nonce option: enforce it ourselves.
  const { payload } = await jwtVerify(idToken, key, { issuer, audience, algorithms: [alg] });
  if (nonce && payload.nonce !== nonce) throw new Error("id_token nonce mismatch");
  return payload;
}

// Pure summary of a discovery doc (+ JWKS key count) for the settings "Test" route.
export function summarizeOidcSigning(discovery, jwksKeyCount) {
  const signingAlgs = Array.isArray(discovery?.id_token_signing_alg_values_supported)
    ? discovery.id_token_signing_alg_values_supported.filter((a) => typeof a === "string")
    : [];
  const hmacOnly = signingAlgs.length > 0 && signingAlgs.every((a) => HMAC_ALGS.includes(a));
  const hasAsymmetric = signingAlgs.some(
    (a) => a.toLowerCase() !== "none" && !HMAC_ALGS.includes(a),
  );
  const warnings = [];
  if (hmacOnly) {
    warnings.push(
      "The provider signs id_tokens only with HS* (client secret). Sign-in works, but selecting a signing key in the IdP (RS256) is recommended.",
    );
  } else if (jwksKeyCount === 0 && hasAsymmetric) {
    warnings.push("The provider's JWKS has no keys, so RS/ES-signed id_tokens cannot be verified.");
  }
  if (signingAlgs.some((a) => a.toLowerCase() === "none")) {
    warnings.push('The provider advertises alg "none"; unsigned id_tokens are always rejected.');
  }
  return { signingAlgs, warnings };
}

export function pickOidcDisplayName(payload = {}) {
  return (
    payload.preferred_username ||
    payload.email ||
    payload.name ||
    payload.given_name ||
    payload.sub ||
    "OIDC user"
  );
}

export function pickOidcEmail(payload = {}) {
  return payload.email || "";
}
