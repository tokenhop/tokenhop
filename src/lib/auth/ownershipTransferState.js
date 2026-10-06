// YAN-360: sealed 10-minute state for the SSO re-auth that gates ownership
// transfer. Same pattern as the invite cookie (oidc.js): JWE dir/A256GCM under
// a key derived for this purpose only, so the value is never readable by the
// browser nor acceptable as a session JWS. Shared by the OIDC and SAML lanes.
import { EncryptJWT, jwtDecrypt } from "jose";

export const OWNER_TRANSFER_COOKIE = "owner_transfer_state";
export const OWNER_TRANSFER_PURPOSE = "owner_transfer";
const TTL = "10m";
const PROVIDERS = ["oidc", "saml"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function key() {
  const { deriveSecretKey } = await import("@/lib/auth/dashboardSession");
  return deriveSecretKey(OWNER_TRANSFER_PURPOSE);
}

const str = (v) => typeof v === "string" && v !== "";

/** Cookie options for the state cookie (HttpOnly, short-lived, lax for the IdP redirect back). */
export function ownerTransferCookieOptions(secure) {
  return { httpOnly: true, secure: !!secure, sameSite: "lax", path: "/", maxAge: 600 };
}

/**
 * Seal the flow state. Required: ownerId, sessionVersion (int), toUserId,
 * provider ("oidc"|"saml"), issuer, subject. Provider extras ride along:
 * OIDC `state`, `nonce`, `verifier`; SAML `requestId`. `startedAt` defaults to now (ms).
 */
export async function sealOwnerTransferState(input) {
  const s = { startedAt: Date.now(), ...input };
  if (
    !str(s.ownerId) ||
    !Number.isInteger(s.sessionVersion) ||
    !UUID_RE.test(s.toUserId || "") ||
    !PROVIDERS.includes(s.provider) ||
    !str(s.issuer) ||
    !str(s.subject) ||
    !Number.isFinite(s.startedAt)
  ) {
    throw new Error("Invalid owner transfer state");
  }
  const claims = {
    purpose: OWNER_TRANSFER_PURPOSE,
    ownerId: s.ownerId,
    sessionVersion: s.sessionVersion,
    toUserId: s.toUserId,
    provider: s.provider,
    issuer: s.issuer,
    subject: s.subject,
    startedAt: s.startedAt,
  };
  for (const k of ["state", "nonce", "verifier", "requestId"]) {
    if (s[k] !== undefined) claims[k] = String(s[k]);
  }
  return new EncryptJWT(claims)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(TTL)
    .encrypt(await key());
}

/** Opened state object, or null for anything missing, tampered, expired or malformed. */
export async function openOwnerTransferState(sealed) {
  if (!sealed || typeof sealed !== "string") return null;
  let payload;
  try {
    ({ payload } = await jwtDecrypt(sealed, await key(), {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
    }));
  } catch {
    return null;
  }
  if (
    !payload ||
    payload.purpose !== OWNER_TRANSFER_PURPOSE ||
    !str(payload.ownerId) ||
    !Number.isInteger(payload.sessionVersion) ||
    !UUID_RE.test(payload.toUserId || "") ||
    !PROVIDERS.includes(payload.provider) ||
    !str(payload.issuer) ||
    !str(payload.subject) ||
    !Number.isFinite(payload.startedAt)
  ) {
    return null;
  }
  const { purpose: _p, iat: _i, exp: _e, ...state } = payload;
  return state;
}
