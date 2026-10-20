// YAN-363 gateway API-key principal.
// Gateway-only resolver, imported by gatewayAuth.js (never routes/session,
// so cycle-free): only the hash-mode storage helpers, durable marker reader,
// and master/root loader. Never imports users/session; session's key hook is
// still an open hook, not wired through here.
import { getAdapter } from "../db/driver.js";
import { readApiKeyStorageState } from "../db/apiKeyState.js";
import { getHashedApiKeyByHashUnscoped, getEligibleApiKeySync } from "../db/repos/apiKeysRepo.js";
import { getApiKeyHashKey, resolveApiKeyHashKeyForAuth } from "../security/apiKeyHashKey.js";
import { hashApiKey } from "../security/masterKey.js";
import { attachGatewayKeyDigest } from "../security/gatewayKeyDigest.js";

// Spec bounds (feature-spec "API Design"): bearer tokens cap at 4096 bytes,
// scope arrays at 128 x 256 chars. The resolver rejects larger input without
// hashing or DB work. Cache stores digest -> keyId (immutable), max 1024, 5 s.
const MAX_TOKEN_BYTES = 4096;
const CACHE_MAX = 1024;
const CACHE_TTL_MS = 5000;
const cache = new Map(); // digest hex -> { id, at }

function cacheGet(digest) {
  const hit = cache.get(digest);
  if (!hit) return null;
  if (Date.now() - hit.at >= CACHE_TTL_MS) {
    cache.delete(digest);
    return null;
  }
  return hit.id;
}

function cacheSet(digest, id) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(digest, { id, at: Date.now() });
}

/** Clear the digest cache. Tests and key-lifecycle invalidation call this. */
export function clearApiKeyPrincipalCache() {
  cache.clear();
}

/**
 * Resolve a presented gateway bearer to a frozen gateway-only principal.
 * Hashed storage only: legacy returns null (existing auth untouched).
 * Missing/malformed/inactive/expired/revoked keys return null. Storage and
 * root errors propagate; never fall back to owner/session/CLI/local.
 * @param {string} presented raw bearer bytes, untrimmed
 * @param {{apiKeyState?: object, verifyOnly?: boolean}} [opts] storage state the
 *   caller already read. `verifyOnly` runs the identical hash + live eligibility
 *   proof but mints no request scope and copies no root: the result is an internal
 *   frozen `{ verified: true, apiKeyId }` (no workspace, no scopes), which
 *   resolveGatewayAuth converts to an admission verdict. Never a principal.
 * @returns {Promise<{workspaceId:string,userId:string|null,apiKeyId:string,scopes:{allowedModels:string[],allowedCombos:string[]},via:"apiKey"}|null>}
 */
export async function resolveApiKey(presented, { apiKeyState, verifyOnly = false } = {}) {
  if (typeof presented !== "string" || presented.length === 0) return null;
  if (presented.length > MAX_TOKEN_BYTES || Buffer.byteLength(presented, "utf8") > MAX_TOKEN_BYTES)
    return null;
  // Bearer bytes are exact: any whitespace/control byte is malformed, never trimmed.
  for (const ch of presented) {
    const code = ch.codePointAt(0);
    if (code <= 0x20 || code === 0x7f || /\s/u.test(ch)) return null;
  }
  const db = await getAdapter();
  const state = apiKeyState ?? readApiKeyStorageState(db);
  if (state.storage === "legacy") return null;
  // Stable hash-key getter (YAN-365 D6): pre-encryption HKDF of the frozen
  // kid's master; after credential encryption an authenticated unwrap under
  // the current KEK. Root/unwrap errors propagate; no fallback.
  let auth;
  if (verifyOnly) {
    const key = await getApiKeyHashKey(db, { apiKeyState: state });
    // No seed to release here, but the derived-key copy is ours: wipe it when done.
    auth = { ...key, release: () => key.hashKey.fill(0) };
  } else {
    auth = await resolveApiKeyHashKeyForAuth(db, { apiKeyState: state });
  }
  const { hashKey, release } = auth;
  try {
    const digest = hashApiKey(presented, hashKey);
    const now = new Date().toISOString();
    let row = null;
    const cachedId = cacheGet(digest);
    if (cachedId) {
      row = getEligibleApiKeySync(db, cachedId, { keyHash: digest, now });
      // Stale cache entry (revoked/disabled/left/expired): live check fails,
      // entry is useless. Fall through to the indexed lookup so a hash that
      // moved to a new row can still resolve without waiting for TTL.
      if (!row) cache.delete(digest);
    }
    if (!row) {
      row = getHashedApiKeyByHashUnscoped(db, digest);
      if (!row) return null;
      row = getEligibleApiKeySync(db, row.id, { keyHash: digest, now });
      if (!row) return null;
    }
    cacheSet(digest, row.id);
    if (verifyOnly) return Object.freeze({ verified: true, apiKeyId: row.id });
    // Fresh frozen principal per call; the scope is request-local and dies with it.
    const principal = auth.mint({
      workspaceId: row.workspaceId,
      userId: row.userId,
      apiKeyId: row.id,
      scopes: { allowedModels: row.allowedModels, allowedCombos: row.allowedCombos },
      via: "apiKey",
    });
    return attachGatewayKeyDigest(principal, digest);
  } finally {
    release(); // idempotent: the seed never outlives this authentication
  }
}
