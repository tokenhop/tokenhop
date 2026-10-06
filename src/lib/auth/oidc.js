import crypto from "node:crypto";
import { EncryptJWT, createRemoteJWKSet, decodeProtectedHeader, jwtDecrypt, jwtVerify } from "jose";
import { getSettings } from "@/lib/localDb";
import { resolveAuthModes } from "@/lib/auth/authModes";

export const OIDC_COOKIE_NAMES = {
  state: "oidc_state",
  nonce: "oidc_nonce",
  verifier: "oidc_code_verifier",
  invite: "oidc_invite",
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
  if (!nonce) throw new Error("id_token verification requires the login nonce");
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
  if (payload.nonce !== nonce) throw new Error("id_token nonce mismatch");
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
  } else if (jwksKeyCount === 0 && (hasAsymmetric || signingAlgs.length === 0)) {
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

/**
 * Fetches the OIDC UserInfo response for an already-verified identity.
 * The id_token stays authoritative: callers fetch only when a configured claim
 * is absent. Exact nonempty `sub` must equal `expectedSub`; when the response
 * carries `iss`, it must exactly equal `expectedIssuer`. Never logs tokens.
 */
export async function fetchOidcUserInfo({
  userinfoEndpoint,
  accessToken,
  expectedSub,
  expectedIssuer,
}) {
  if (!userinfoEndpoint || !accessToken) {
    throw new Error("OIDC UserInfo fetch requires a userinfo endpoint and access token");
  }
  if (typeof expectedSub !== "string" || expectedSub === "") {
    throw new Error("OIDC UserInfo fetch requires the verified subject");
  }
  const res = await fetch(userinfoEndpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`OIDC UserInfo fetch failed (${res.status})`);
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("OIDC UserInfo response is not valid JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("OIDC UserInfo response has an unexpected shape");
  }
  if (typeof data.sub !== "string" || data.sub === "" || data.sub !== expectedSub) {
    throw new Error("OIDC UserInfo subject mismatch");
  }
  if (
    Object.hasOwn(data, "iss") &&
    (typeof data.iss !== "string" || data.iss === "" || data.iss !== expectedIssuer)
  ) {
    throw new Error("OIDC UserInfo issuer mismatch");
  }
  return data;
}

// --- YAN-360: invite proof carried through an SSO round trip ---------------
// The invitation token never rides a URL, the IdP redirect or a Referer: the
// start step POSTs it in a bounded JSON body and the server parks it in a
// short-lived encrypted HttpOnly cookie, bound to this flow's state (OIDC state /
// SAML request ID). The callback opens it only after the IdP identity verified.
// Authenticated encryption (JWE dir/A256GCM) under a key derived for this
// purpose only: the cookie value never reveals the token and is never a JWS
// the session reader could accept.
export const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INVITE_STATE_PURPOSE = "sso_invite";
const INVITE_STATE_TTL = "10m";
const INVITE_BODY_MAX = 256;

async function inviteKey() {
  const { deriveSecretKey } = await import("@/lib/auth/dashboardSession");
  return deriveSecretKey(INVITE_STATE_PURPOSE);
}

/** Encrypt the invite proof for cookie storage, bound to `flowId`. */
export async function sealInviteState(invitationToken, flowId) {
  if (!INVITE_TOKEN_PATTERN.test(invitationToken || "") || !flowId) {
    throw new Error("Invalid invite state");
  }
  return new EncryptJWT({ purpose: INVITE_STATE_PURPOSE, flow: flowId, inv: invitationToken })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(INVITE_STATE_TTL)
    .encrypt(await inviteKey());
}

/** Invite token from a sealed cookie for exactly this flow, else null. */
export async function openInviteState(sealed, flowId) {
  if (!sealed || !flowId) return null;
  let payload = null;
  try {
    ({ payload } = await jwtDecrypt(sealed, await inviteKey(), {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
    }));
  } catch {
    return null;
  }
  if (
    !payload ||
    payload.purpose !== INVITE_STATE_PURPOSE ||
    payload.flow !== flowId ||
    !INVITE_TOKEN_PATTERN.test(payload.inv || "")
  ) {
    return null;
  }
  return payload.inv;
}

/**
 * Guard + parse for the invitation SSO start POST. Switch off -> same 404 as
 * every YAN-360 route; same-origin JSON only; IP-limited; strict body shape
 * `{ invitationToken }` (43-char base64url). Returns `{ response }` to send, or
 * `{ invitationToken }`. The token is never logged.
 */
export async function readInviteStartBody(request) {
  const [{ requireMultiUser }, { isCrossSite, isJson }, users, limiter] = await Promise.all([
    import("@/lib/users/featureSwitch.js"),
    import("@/lib/auth/sameOrigin.js"),
    import("@/lib/users/userManagement.js"),
    import("@/lib/auth/loginLimiter"),
  ]);
  const { json, readJsonBody, PayloadTooLarge } = users;
  const hidden = await requireMultiUser();
  if (hidden) return { response: hidden };
  if (isCrossSite(request)) {
    return { response: json({ error: "Forbidden", code: "forbidden_origin" }, 403) };
  }
  if (!isJson(request)) {
    return { response: json({ error: "Unsupported media type", code: "invalid_request" }, 415) };
  }
  const bucket = { ip: limiter.getClientIp(request) };
  const lock = limiter.checkLoginLocks(bucket);
  if (lock.locked) {
    const response = json(
      { error: "Too many attempts", code: "rate_limited", retryAfter: lock.retryAfter },
      429,
    );
    response.headers.set("Retry-After", String(lock.retryAfter));
    return { response };
  }
  let body;
  try {
    body = await readJsonBody(request, { max: INVITE_BODY_MAX });
  } catch (err) {
    if (err instanceof PayloadTooLarge) {
      return { response: json({ error: "Payload too large", code: "payload_too_large" }, 413) };
    }
    throw err;
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => k !== "invitationToken") ||
    typeof body.invitationToken !== "string" ||
    !INVITE_TOKEN_PATTERN.test(body.invitationToken)
  ) {
    limiter.recordLoginFail(bucket);
    return { response: json({ error: "Invalid invitation", code: "invite_invalid" }, 400) };
  }
  return { invitationToken: body.invitationToken };
}
