import { SAML, ValidateInResponseTo } from "@node-saml/node-saml";
import { InMemoryCacheProvider } from "@node-saml/node-saml/lib/in-memory-cache-provider.js";
import { getSettings } from "../db/repos/settingsRepo.js";
import { ACTIVE } from "@/shared/brand";
import { normalizeGroups } from "../users/ssoProvisioning.js";
import { openInviteState, sealInviteState } from "./oidc.js";

const SAML_REQUEST_TTL_MS = 10 * 60 * 1000; // matches saml_state cookie maxAge (10 min)

// ponytail: in-memory, single-process only; entries from unauthenticated /saml/start are bounded by
// request rate x TTL. Upgrade path: DB-backed CacheProvider if the app ever runs multi-process.
if (!globalThis.__tokenhopSamlRequestCache) {
  globalThis.__tokenhopSamlRequestCache = new InMemoryCacheProvider({
    keyExpirationPeriodMs: SAML_REQUEST_TTL_MS,
  });
}
const requestIdCache = globalThis.__tokenhopSamlRequestCache;
// node-saml checks the request ID, then awaits signature work before removing it, so two concurrent
// posts of one response could both pass. Claim the ID for the duration of validation.
const inFlightRequestIds = new Set();

/**
 * Formats a raw Base64 string or unformatted X.509 certificate into standard PEM format.
 * @param {string} certStr
 * @returns {string}
 */
export function formatX509Certificate(certStr) {
  if (!certStr || typeof certStr !== "string") return "";
  const clean = certStr
    .replace(/-----BEGIN CERTIFICATE-----/gi, "")
    .replace(/-----END CERTIFICATE-----/gi, "")
    .replace(/[^A-Za-z0-9+/=]/g, "");

  if (!clean) return "";

  const lines = clean.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}

/**
 * Checks whether SAML configuration has essential parameters (entryPoint & cert).
 * @param {object} settings
 * @returns {boolean}
 */
export function isSamlConfigured(settings) {
  return Boolean(settings?.samlEntryPoint && settings?.samlCert);
}

/**
 * Fetches settings and returns runtime status + settings.
 * @returns {Promise<{ configured: boolean, settings: object }>}
 */
export async function getSamlRuntimeConfig() {
  const settings = await getSettings();
  return {
    configured: isSamlConfigured(settings),
    settings,
  };
}

/**
 * Creates a configured `@node-saml/node-saml` SAML instance with security defaults.
 * @param {object} settings
 * @param {string} origin
 * @returns {SAML}
 */
const DUMMY_FALLBACK_CERT =
  "-----BEGIN CERTIFICATE-----\nMIIC...DUMMY...\n-----END CERTIFICATE-----";

function trimTrailingSlashes(str) {
  return (str || "").replace(/\/+$/, "");
}

/**
 * Resolves the public Base URL / Origin for SAML requests.
 * Respects settings.baseUrl, process.env.BASE_URL, x-forwarded-proto, and x-forwarded-host.
 * @param {Request} request
 * @param {object} settings
 * @returns {string}
 */
export function getSamlBaseUrl(request, settings) {
  const configuredBaseUrl =
    (settings?.baseUrl || "").trim() ||
    process.env.BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    "";

  if (configuredBaseUrl) {
    return trimTrailingSlashes(configuredBaseUrl);
  }

  if (request) {
    const forwardedProto = request?.headers?.get?.("x-forwarded-proto") || "";
    const forwardedHost = request?.headers?.get?.("x-forwarded-host") || "";
    const host = forwardedHost || request?.headers?.get?.("host") || "";
    if (host) {
      const protocol = (forwardedProto || new URL(request.url).protocol || "http:").replace(
        /:$/,
        "",
      );
      return `${protocol}://${host}`.replace(/\/+$/, "");
    }
    if (request.url) {
      return trimTrailingSlashes(new URL(request.url).origin);
    }
  }

  return "http://localhost:20128";
}

export function createSamlInstance(settings, origin) {
  const cert = formatX509Certificate(settings?.samlCert || "") || DUMMY_FALLBACK_CERT;
  const callbackUrl = `${origin}/api/auth/saml/acs`;
  return new SAML({
    entryPoint: settings?.samlEntryPoint || "https://example.com/sso",
    issuer: settings?.samlIssuer || ACTIVE.samlIssuerDefault,
    idpCert: cert,
    cert: cert,
    callbackUrl: callbackUrl,
    acceptedClockSkewMs: 60000,
    // Signed response AND signed assertion are both required; never silently
    // downgrade on a library default change.
    wantAuthnResponseSigned: true,
    wantAssertionsSigned: true,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: SAML_REQUEST_TTL_MS,
    cacheProvider: requestIdCache,
  });
}

/**
 * Builds SAML AuthnRequest redirect URL and returns { authorizeUrl, requestId }.
 * @param {Request} request
 * @param {object} settings
 * @returns {Promise<{ authorizeUrl: string, requestId: string }>}
 */
export async function buildSamlAuthorizeUrl(request, settings) {
  const origin = getSamlBaseUrl(request, settings);
  const samlInstance = createSamlInstance(settings, origin);

  const xml = await samlInstance.generateAuthorizeRequestAsync(false, false);
  const match = xml.match(/ID="([^"]+)"/);
  const requestId = match ? match[1] : "";

  const authorizeUrl = await samlInstance._requestToUrlAsync(xml, null, "authorize", {});

  return { authorizeUrl, requestId };
}

/**
 * Validates SAML POST response from IdP ACS callback and returns user profile.
 * Fail-closed: a missing saml_state cookie (request ID) throws before parsing.
 * IdP-initiated SSO (no InResponseTo) is intentionally unsupported.
 * @param {Request} request
 * @param {object} body - Parsed form body or object containing SAMLResponse
 * @param {string} expectedRequestId - Request ID stored in saml_state cookie
 * @param {object} settings
 * @returns {Promise<object>}
 */
export async function validateSamlResponse(request, body, expectedRequestId, settings) {
  if (!expectedRequestId) {
    throw new Error("Missing SAML request state (saml_state cookie); start sign-in again");
  }

  if (!settings?.samlCert) {
    throw new Error("IdP X.509 certificate (samlCert) is missing or not configured");
  }

  const origin = getSamlBaseUrl(request, settings);
  const samlInstance = createSamlInstance(settings, origin);

  const container = typeof body === "object" && body !== null ? body : { SAMLResponse: body };
  const rawSamlResponse = container.SAMLResponse;

  if (!rawSamlResponse) {
    throw new Error("Missing SAMLResponse parameter in assertion POST body");
  }

  // Bind response to this browser's outstanding request (replay protection)
  const xml = Buffer.from(rawSamlResponse, "base64").toString("utf8");
  const match = xml.match(/InResponseTo=["']([^"']+)["']/i);
  const inResponseTo = match ? match[1] : null;

  if (!inResponseTo || inResponseTo !== expectedRequestId) {
    throw new Error(
      `InResponseTo mismatch: expected ${expectedRequestId}, received ${inResponseTo || "none"}`,
    );
  }

  if (inFlightRequestIds.has(expectedRequestId)) {
    throw new Error("SAML response for this request is already being processed");
  }
  inFlightRequestIds.add(expectedRequestId);
  try {
    const result = await samlInstance.validatePostResponseAsync({ SAMLResponse: rawSamlResponse });
    const profile = result?.profile || result;
    // Re-check against the value node-saml parsed from the validated document, not the raw regex.
    if (profile?.inResponseTo !== expectedRequestId) {
      throw new Error("InResponseTo mismatch after validation");
    }
    return profile;
  } finally {
    inFlightRequestIds.delete(expectedRequestId);
  }
}

/**
 * Generates standard SP XML Metadata.
 * @param {string} origin
 * @param {object} settings
 * @returns {string}
 */
export function generateSamlMetadata(origin, settings) {
  const samlInstance = createSamlInstance(settings, origin);
  return samlInstance.generateServiceProviderMetadata();
}

/**
 * Extracts email claim from SAML profile assertion.
 * @param {object} profile
 * @param {object} settings
 * @returns {string}
 */
export function pickSamlEmail(profile = {}, settings = {}) {
  if (!profile) return "";

  // 1. Configured custom attribute
  const customAttr = settings.samlAttributeEmail;
  if (customAttr && profile[customAttr]) {
    const val = profile[customAttr];
    return Array.isArray(val) ? val[0] : String(val);
  }

  // 2. Common email claims
  const emailKeys = [
    "email",
    "emailAddress",
    "mail",
    "nameID",
    "nameId",
    "upn",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
  ];

  for (const key of emailKeys) {
    if (profile[key]) {
      const val = profile[key];
      return Array.isArray(val) ? val[0] : String(val);
    }
  }

  // 3. Fallback: check attributes object if present
  if (profile.attributes) {
    for (const key of emailKeys) {
      if (profile.attributes[key]) {
        const val = profile.attributes[key];
        return Array.isArray(val) ? val[0] : String(val);
      }
    }
  }

  return "";
}

const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAMEID_EMAIL_FORMAT = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
const VERIFIED_EMAIL_KEYS = [
  "email",
  "emailAddress",
  "mail",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
];

function firstShapedEmail(source, key) {
  if (!source || typeof source !== "object" || !Object.hasOwn(source, key)) return null;
  const val = Array.isArray(source[key]) ? source[key][0] : source[key];
  return typeof val === "string" && EMAIL_SHAPE_RE.test(val.trim()) ? val.trim() : null;
}

// Email trusted for owner/invitation matching: only the configured email
// attribute or an explicit email/mail claim, and only if email-shaped. Never
// the nameID/upn/nameidentifier fallbacks pickSamlEmail uses for display.
// A configured attribute that is present but not email-shaped fails closed.
/**
 * @param {object} profile
 * @param {object} settings
 * @returns {string|null}
 */
export function pickVerifiedSamlEmail(profile = {}, settings = {}) {
  if (!profile) return null;
  const custom = settings.samlAttributeEmail;
  for (const src of [profile, profile.attributes]) {
    if (custom && src && Object.hasOwn(src, custom)) return firstShapedEmail(src, custom);
  }
  for (const src of [profile, profile.attributes]) {
    for (const key of VERIFIED_EMAIL_KEYS) {
      const email = firstShapedEmail(src, key);
      if (email) return email;
    }
  }
  // A NameID the signed assertion declares as emailAddress format is an email
  // claim too (common IdP default). Other NameID formats and UPN never are.
  if (profile.nameIDFormat === NAMEID_EMAIL_FORMAT) return firstShapedEmail(profile, "nameID");
  return null;
}

/**
 * Extracts display name claim from SAML profile assertion.
 * @param {object} profile
 * @param {object} settings
 * @returns {string}
 */
export function pickSamlDisplayName(profile = {}, settings = {}) {
  if (!profile) return "";

  // 1. Configured custom attribute
  const customAttr = settings.samlAttributeName;
  if (customAttr && profile[customAttr]) {
    const val = profile[customAttr];
    return Array.isArray(val) ? val[0] : String(val);
  }

  // 2. Common name claims
  const nameKeys = [
    "displayName",
    "name",
    "cn",
    "commonName",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
  ];

  for (const key of nameKeys) {
    if (profile[key]) {
      const val = profile[key];
      return Array.isArray(val) ? val[0] : String(val);
    }
  }

  // 3. Combined givenName + surname
  if (profile.givenName || profile.sn || profile.surname) {
    const given = profile.givenName || "";
    const surname = profile.sn || profile.surname || "";
    const combined = `${given} ${surname}`.trim();
    if (combined) return combined;
  }

  // 4. Fallback to email
  return pickSamlEmail(profile, settings);
}

/**
 * Reads the group attribute from a validated SAML profile.
 * Exact own configured key (settings.samlAttributeGroups, default "groups") on the profile
 * first, then the same own key in profile.attributes. URI keys stay literal; values go through
 * the shared normalizer (no CSV splitting).
 * @param {object} profile
 * @param {object} settings
 * @returns {{ present: boolean, groups: string[]|null, invalid: boolean }}
 */
export function pickSamlGroups(profile, settings) {
  const key = settings?.samlAttributeGroups || "groups";
  const sources = [profile, profile?.attributes];
  for (const source of sources) {
    if (source && typeof source === "object" && Object.hasOwn(source, key)) {
      const { groups, invalid } = normalizeGroups(source[key]);
      return { present: true, groups, invalid };
    }
  }
  return { present: false, groups: null, invalid: false };
}

// --- YAN-360: SAML invite proof (see oidc.js for the full contract) --------
export const SAML_INVITE_COOKIE = "saml_invite";

/** Seal the invite proof for cookie storage, bound to this request's ID. */
export function sealSamlInvite(invitationToken, requestId) {
  return sealInviteState(invitationToken, requestId);
}

/** Invite token from a sealed cookie for exactly this request ID, else null. */
export function openSamlInvite(sealed, requestId) {
  return openInviteState(sealed, requestId);
}
