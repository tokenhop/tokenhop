// Usage hub authentication (YAN-2019). T3 Code reads a CLIProxyAPI-style hub
// under /v0/management/* with `Authorization: Bearer <management key>` only
// (contract: YAN-2018). Tokenhop answers those reads with a dedicated
// read-only hub key (`thm_…`, hubKeysRepo):
// - only the hub read routes below are in scope; everything else, including
//   the write routes T3 knows (reset-quota), is 403 for a valid key;
// - a missing, malformed, unknown or revoked key is 401 with a fixed body;
// - gateway API keys, sessions and the CLI token never authorize a hub route,
//   and a hub key never authorizes /v1 or the dashboard (no other resolver
//   knows its hash);
// - per-IP failure and per-key request rate limits answer 429;
// - every use is audit-logged with the key id, prefix, method and path (never
//   the key). Successful reads are coalesced to one row per key, method and
//   path per minute so polling can't flood the audit log; denials always log
//   until the IP is rate limited.
// Hidden behind TOKENHOP_USAGE_HUB (default off) until the hub routes land.
// The hub route handlers (YAN-2020) must call authorizeHubRequest again, like
// the gateway handlers re-run resolveGatewayAuth: the edge is not the only gate.
import { audit } from "@/lib/users/audit.js";
import { getClientIp } from "@/lib/auth/loginLimiter.js";
import { findActiveHubKeyUnscoped } from "@/lib/db/repos/hubKeysRepo.js";
import { isUsageHubEnabled } from "./hubConfig.js";

export { isUsageHubEnabled, USAGE_HUB_ENV } from "./hubConfig.js";

/** Exact (method, path) pairs a hub key may read. */
export const HUB_READ_ROUTES = Object.freeze([
  Object.freeze({ method: "GET", path: "/v0/management/auth-files" }),
  Object.freeze({ method: "GET", path: "/v0/management/auth-files/models" }),
  Object.freeze({ method: "POST", path: "/v0/management/api-call" }),
]);

const WINDOW_MS = 60_000;
const MAX_FAILS_PER_IP = 30; // per minute
const MAX_REQUESTS_PER_KEY = 600; // per minute; T3 sends ~1-3 calls per account
const MAX_BUCKETS = 10_000;

if (!globalThis.__tokenhopHubAuth) {
  globalThis.__tokenhopHubAuth = { fails: new Map(), uses: new Map(), audited: new Map() };
}
const state = globalThis.__tokenhopHubAuth;

/** `/api/v0/management/x` and `/v0/management/x` both normalize to the root form. */
export function normalizeHubPath(pathname) {
  // Lower-cased: Next routes case-insensitively, so case must not change the
  // allow-list verdict (an upper-case read route is still that route).
  let path = String(pathname || "").toLowerCase();
  if (path.startsWith("/api/v0/")) path = path.slice(4);
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Whether `method` on `pathname` is a hub read route (exact match). */
export function isHubReadRoute(pathname, method) {
  const path = normalizeHubPath(pathname);
  const m = String(method || "").toUpperCase();
  return HUB_READ_ROUTES.some((r) => r.method === m && r.path === path);
}

/** The bearer value exactly as sent, or null. No other carrier is accepted. */
export function extractHubBearer(request) {
  const header = request.headers.get("authorization");
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const value = header.slice(7);
  return value.length > 0 ? value : null;
}

function bump(map, key, now) {
  let bucket = map.get(key);
  if (!bucket || now - bucket.start >= WINDOW_MS) {
    if (!bucket && map.size >= MAX_BUCKETS) {
      for (const [k, b] of map) if (now - b.start >= WINDOW_MS) map.delete(k);
      if (map.size >= MAX_BUCKETS) map.delete(map.keys().next().value);
    }
    bucket = { start: now, count: 0 };
    map.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count;
}

function ipLimited(ip, now) {
  const bucket = state.fails.get(ip);
  return Boolean(bucket && now - bucket.start < WINDOW_MS && bucket.count >= MAX_FAILS_PER_IP);
}

const deny = (status, error) => ({ ok: false, status, body: { error } });

function auditUse(request, key, method, path, result) {
  void audit(
    { request, principal: { userId: null, apiKeyId: null, via: "hubKey" } },
    "hubKey.use",
    { type: "hubKey", id: key?.id ?? null },
    { after: { keyPrefix: key?.prefix ?? null, method, path }, result },
  );
}

function auditSuccessOncePerMinute(request, key, method, path, now) {
  const slot = `${key.id} ${method} ${path}`;
  const last = state.audited.get(slot);
  if (last !== undefined && now - last < WINDOW_MS) return;
  if (state.audited.size >= MAX_BUCKETS) state.audited.delete(state.audited.keys().next().value);
  state.audited.set(slot, now);
  auditUse(request, key, method, path, "success");
}

/**
 * Authorize a hub request. Never throws; never logs the presented key.
 * @param {Request} request
 * @param {{ pathname?: string, method?: string, now?: number }} [opts]
 * @returns {Promise<{ ok: true, key: { id: string, prefix: string } } | { ok: false, status: number, body: { error: string } }>}
 */
export async function authorizeHubRequest(request, opts = {}) {
  const now = opts.now ?? Date.now();
  const method = String(opts.method ?? request.method ?? "GET").toUpperCase();
  let path;
  try {
    path = normalizeHubPath(opts.pathname ?? new URL(request.url).pathname);
  } catch {
    return deny(400, "Bad request");
  }
  if (!isUsageHubEnabled()) return deny(404, "Not found");

  let ip = "unknown";
  try {
    ip = getClientIp(request) || "unknown";
  } catch {
    ip = "unknown";
  }
  if (ipLimited(ip, now)) return deny(429, "Too many requests");

  const presented = extractHubBearer(request);
  let key = null;
  try {
    key = presented ? await findActiveHubKeyUnscoped(presented) : null;
  } catch {
    return deny(503, "Service unavailable");
  }
  if (!key) {
    bump(state.fails, ip, now);
    auditUse(request, null, method, path, "denied");
    return deny(401, "Unauthorized");
  }
  if (!isHubReadRoute(path, method)) {
    bump(state.fails, ip, now);
    auditUse(request, key, method, path, "denied");
    return deny(403, "Forbidden");
  }
  if (bump(state.uses, key.id, now) > MAX_REQUESTS_PER_KEY) {
    return deny(429, "Too many requests");
  }
  auditSuccessOncePerMinute(request, key, method, path, now);
  return { ok: true, key };
}

/** Test-only: forget every rate-limit and audit-coalescing bucket. */
export function resetHubAuthState() {
  if (!process.env.VITEST) return;
  state.fails.clear();
  state.uses.clear();
  state.audited.clear();
}
