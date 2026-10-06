// YAN-363 shared gateway auth. One resolver for every /v1 handler: hashed-
// storage bearer keys take precedence over every other credential, an invalid
// presented key rejects with no owner/cookie/CLI/local fallback, and the
// legacy branch preserves requireClientApiKey behavior; that helper now
// delegates here. Gateway auth stays separate from dashboard sessions.
// No session import, so gateway and management resolution stay cycle-free.
import { errorResponse } from "open-sse/utils/error.js";
import { extractClientApiKey } from "./clientApiKey.js";
import { cliTokenAcceptedWith } from "./cliTokenPolicy.js";
import { hasTrustedPeerHeaders, isLoopbackPeer } from "./trustedPeer.js";
import { matchesLocalVerifier, MITM_VERIFIER_SETTING } from "./mitmCredential.js";
import { validateApiKey } from "../db/repos/apiKeysRepo.js";
import { resolveApiKey } from "./apiKeyPrincipal.js";
import { getAdapter } from "../db/driver.js";
import { readApiKeyStorageState } from "../db/apiKeyState.js";
import { getSettings } from "../db/repos/settingsRepo.js";
import { isMultiUserEnabled } from "../users/featureSwitch.js";

/** Admin-only keyless opt-in (YAN-363); default false. Not API-writable here. */
export const ALLOW_KEYLESS_SETTING = "allowKeylessGatewayRequests";

function activeUserCount(db) {
  return db.get("SELECT COUNT(*) AS n FROM users WHERE status = 'active'").n;
}

function ownerPrincipal(db, via) {
  const owner = db.get("SELECT id FROM users WHERE instanceRole = 'owner' AND status = 'active'");
  const workspaceId = db.get("SELECT value FROM _meta WHERE key = 'defaultWorkspaceId'")?.value;
  if (!owner?.id || !workspaceId) return null;
  if (
    !db.get(
      `SELECT w.id FROM workspaces w JOIN memberships m ON m.workspaceId = w.id
      WHERE w.id = ? AND m.userId = ?`,
      [workspaceId, owner.id],
    )
  )
    return null;
  return Object.freeze({
    userId: owner.id,
    workspaceId,
    apiKeyId: null,
    scopes: Object.freeze({ allowedModels: Object.freeze([]), allowedCombos: Object.freeze([]) }),
    via,
  });
}

/**
 * Current MITM internal credential check. The presented bearer is accepted only
 * when it matches the verifier hash the manager persisted for the live child —
 * rotation installs the new hash and the old credential stops matching.
 * Matches the keyless path's loopback proof, never Host: trusted direct peer
 * headers plus a loopback peer address, and never through a proxy hop.
 */
function resolveMitmPrincipal(db, presented) {
  if (typeof presented !== "string" || !presented) return null;
  let verifier = null;
  try {
    verifier = db.get(`SELECT data FROM settings WHERE id = 1`)?.data;
    verifier = verifier ? JSON.parse(verifier)?.[MITM_VERIFIER_SETTING] : null;
  } catch {
    return null;
  }
  if (!matchesLocalVerifier(presented, verifier)) return null;
  return ownerPrincipal(db, "mitm");
}

function mitmLoopbackProof(request) {
  return (
    hasTrustedPeerHeaders(request) &&
    isLoopbackPeer(request) &&
    !request.headers.get("x-9r-via-proxy")
  );
}

function multiUserActive(db) {
  return (
    activeUserCount(db) > 1 ||
    db.get("SELECT COUNT(*) AS n FROM workspaces WHERE kind = 'shared'").n > 1
  );
}

// Hashed mode preserves carrier precedence but never treats empty values as absent.
function extractHashedCredential(request) {
  const auth = request.headers.get("authorization");
  if (auth === "Bearer") return ""; // Headers trims trailing space from "Bearer ".
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  for (const header of ["x-api-key", "x-goog-api-key"]) {
    if (request.headers.has(header)) return request.headers.get(header);
  }
  if (request.url) {
    try {
      return new URL(request.url).searchParams.get("key");
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Resolve gateway request auth.
 * @returns {Promise<{principal: object|null, legacy: boolean}|Response>}
 *   `{ principal, legacy: false }` — hashed bearer/CLI/keyless principal.
 *   `{ principal: null, legacy: true }` — legacy storage, caller keeps today's
 *   raw-key behavior (the presented key already passed the legacy check).
 *   `Response` — deny: 401 credential, 503 storage/master. Never a fallback.
 */
export async function resolveGatewayAuth(request) {
  const presented = extractClientApiKey(request); // null only when no credential at all
  let state;
  try {
    state = readApiKeyStorageState(await getAdapter());
  } catch (err) {
    if (err?.code === "API_KEY_STATE_INVALID") throw err;
    return errorResponse(503, "Gateway storage unavailable");
  }

  if (state.storage === "legacy") {
    // Byte-for-byte requireClientApiKey semantics (helper itself untouched).
    const settings = await getSettings({ secretMode: "metadata" });
    if (!settings.requireApiKey) return { principal: null, legacy: true };
    const { hasValidCliToken } = await import("./cliToken.js");
    if (await hasValidCliToken(request)) return { principal: null, legacy: true };
    if (!presented) return errorResponse(401, "Missing API key");
    if (!(await validateApiKey(presented))) return errorResponse(401, "Invalid API key");
    return { principal: null, legacy: true };
  }

  // Hashed storage: a presented key is the only bearer authority. A presented
  // but invalid/expired/revoked key rejects even when requireApiKey is false
  // and even alongside a valid CLI token or owner cookie. No fallback.
  const hashedCredential = extractHashedCredential(request);
  if (hashedCredential !== null) {
    const adapter = await getAdapter();
    // MITM internal verifier first: current local-child credential only, with
    // the same trusted direct-loopback proof as keyless (never Host). A stale,
    // forged, or nonlocal verifier falls through to ordinary key resolution,
    // which rejects it as an invalid bearer — 401, no fallback, no owner/CLI.
    if (mitmLoopbackProof(request)) {
      try {
        const mitm = resolveMitmPrincipal(adapter, hashedCredential);
        if (mitm) return { principal: mitm, legacy: false };
      } catch (err) {
        if (err?.code === "API_KEY_STATE_INVALID") throw err;
        return errorResponse(503, "Gateway storage unavailable");
      }
    }
    let principal;
    try {
      principal = await resolveApiKey(hashedCredential);
    } catch (err) {
      if (err?.code === "API_KEY_STATE_INVALID") throw err;
      return errorResponse(503, "Gateway storage unavailable");
    }
    if (principal) return { principal, legacy: false };
    return errorResponse(401, "Invalid API key");
  }

  if (
    await cliTokenAcceptedWith(request, {
      multiUserOn: isMultiUserEnabled,
      activeUserCount: async () => activeUserCount(await getAdapter()),
    })
  ) {
    const principal = ownerPrincipal(await getAdapter(), "cli");
    if (principal) return { principal, legacy: false };
  }

  // Keyless requires proven direct-local peer, keys disabled, and single-user
  // cardinality unless explicitly opted in by instance admin. Default false.
  const settings = await getSettings({ secretMode: "metadata" });
  const allowedByKeylessSetting = settings[ALLOW_KEYLESS_SETTING] === true;
  const directLocal =
    hasTrustedPeerHeaders(request) &&
    isLoopbackPeer(request) &&
    !request.headers.get("x-9r-via-proxy");
  if (!settings.requireApiKey && directLocal) {
    const db = await getAdapter();
    if (!multiUserActive(db) || allowedByKeylessSetting) {
      const principal = ownerPrincipal(db, "local");
      if (principal) return { principal, legacy: false };
    }
  }

  return errorResponse(401, "Missing API key");
}

/**
 * Exact allow-list target check for key principals. Empty list = unrestricted.
 * The caller canonicalizes model/combo IDs first (aliases/combo expansion are
 * resolved upstream); this never rewrites or widens them. Owner principals
 * (via cli/local) carry no scopes and are not target-restricted here.
 * @returns {Response|null} 403 when denied, null when allowed.
 */
export function authorizeGatewayTarget(principal, { modelId = null, comboId = null } = {}) {
  const scopes = principal?.scopes;
  if (!scopes) return null;
  if (
    modelId != null &&
    scopes.allowedModels.length > 0 &&
    !scopes.allowedModels.includes(modelId)
  ) {
    return errorResponse(403, "Forbidden");
  }
  if (
    comboId != null &&
    scopes.allowedCombos.length > 0 &&
    !scopes.allowedCombos.includes(comboId)
  ) {
    return errorResponse(403, "Forbidden");
  }
  return null;
}

/**
 * ID-only gateway context for usage/telemetry attribution: no key material.
 * Keyless authenticated principals (cli/local owner) keep their workspace/user
 * attribution with apiKeyId:null — dropping them would silently orphan their
 * usage rows. Null principal (legacy storage) still yields null.
 */
export function gatewayKeyContext(principal) {
  if (!principal) return null;
  return Object.freeze({
    apiKeyId: principal.apiKeyId ?? null,
    workspaceId: principal.workspaceId ?? null,
    userId: principal.userId ?? null,
  });
}

const SECRET_HEADERS = [
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "x-9r-cli-token",
  "x-9r-peer-token",
  // The dashboard session cookie is never a gateway credential, but /v1 calls
  // from a logged-in browser tab carry it — it must not survive any capture.
  "cookie",
];

/**
 * Strip gateway credentials from anything captured for observability.
 * Returns sanitized copies; the input is never mutated.
 * @param {{ headers?: Headers, url?: string|null }} capture
 */
export function sanitizeGatewayCapture({ headers, url = null } = {}) {
  const out = {};
  if (headers) {
    const clean = new Headers();
    for (const [name, value] of headers) {
      if (SECRET_HEADERS.includes(name.toLowerCase())) clean.set(name, "[REDACTED]");
      else clean.set(name, value);
    }
    out.headers = clean;
  }
  if (url) {
    try {
      const relative = !/^[a-z][a-z\d+.-]*:/i.test(url);
      const parsed = new URL(url, "http://gateway.invalid");
      for (const param of ["key", "setupToken"]) {
        if (parsed.searchParams.has(param)) parsed.searchParams.set(param, "[REDACTED]");
      }
      out.url = relative ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.toString();
    } catch {
      out.url = url;
    }
  }
  return out;
}
