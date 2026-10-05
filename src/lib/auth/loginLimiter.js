// In-memory progressive lockout for dashboard login. Resets on process restart.
import { hasTrustedPeerHeaders } from "./trustedPeer.js";

const MAX_FAILS_BEFORE_LOCK = 5;
const LOCK_STEPS_MS = [30_000, 120_000, 600_000, 1_800_000]; // 30s, 2m, 10m, 30m
const FAIL_WINDOW_MS = 60 * 60 * 1000; // 1h since last fail → auto reset

// ip entries stay un-prefixed (SAML calls checkLock(ip) etc.); account entries
// are namespaced ("acct:<userId>", "login:<normalized identifier>").
// Bounded so random identifiers can't grow the map without limit.
const MAX_ENTRIES = 10_000;
const attempts = new Map(); // key → { fails, lockUntil, lockLevel, lastFailAt }

function now() {
  return Date.now();
}

function isExpired(e, t) {
  return e.lastFailAt && t - e.lastFailAt > FAIL_WINDOW_MS && (!e.lockUntil || t >= e.lockUntil);
}

function getEntry(key) {
  const e = attempts.get(key);
  if (!e) return null;
  // Auto reset if window expired and not currently locked
  if (isExpired(e, now())) {
    attempts.delete(key);
    return null;
  }
  return e;
}

// Prune expired first, then evict oldest-inserted (Map keeps insertion order).
function makeRoom() {
  if (attempts.size < MAX_ENTRIES) return;
  const t = now();
  for (const [k, e] of attempts) if (isExpired(e, t)) attempts.delete(k);
  for (const k of attempts.keys()) {
    if (attempts.size < MAX_ENTRIES) break;
    attempts.delete(k);
  }
}

function lockOf(key) {
  const e = getEntry(key);
  if (!e || !e.lockUntil) return { locked: false };
  const remaining = e.lockUntil - now();
  if (remaining <= 0) return { locked: false };
  return { locked: true, retryAfter: Math.ceil(remaining / 1000) };
}

function failOf(key) {
  const e = getEntry(key) || { fails: 0, lockUntil: 0, lockLevel: 0, lastFailAt: 0 };
  e.fails += 1;
  e.lastFailAt = now();
  if (e.fails >= MAX_FAILS_BEFORE_LOCK) {
    const step = LOCK_STEPS_MS[Math.min(e.lockLevel, LOCK_STEPS_MS.length - 1)];
    e.lockUntil = now() + step;
    e.lockLevel += 1;
    e.fails = 0;
  }
  // delete+set refreshes insertion order so active entries are evicted last.
  attempts.delete(key);
  makeRoom();
  attempts.set(key, e);
  return { remainingBeforeLock: Math.max(0, MAX_FAILS_BEFORE_LOCK - e.fails) };
}

export function checkLock(ip) {
  return lockOf(ip);
}

export function recordFail(ip) {
  return failOf(ip);
}

export function recordSuccess(ip) {
  attempts.delete(ip);
}

/**
 * Account key: resolved user id when known, else the normalized identifier
 * (trim + lowercase) so unknown logins accrue like real ones.
 * @param {{ userId?: string|null, login?: string|null }} acct
 */
export function accountKey({ userId, login } = {}) {
  if (userId) return `acct:${userId}`;
  return `login:${String(login ?? "")
    .trim()
    .toLowerCase()}`;
}

const keyOf = (account) => (typeof account === "string" ? account : accountKey(account));

/** Both buckets checked; returns the longer active lock. @param {{ ip: string, account: string|object }} p */
export function checkLoginLocks({ ip, account }) {
  const a = lockOf(ip);
  const b = account ? lockOf(keyOf(account)) : { locked: false };
  if (!a.locked && !b.locked) return { locked: false };
  return { locked: true, retryAfter: Math.max(a.retryAfter ?? 0, b.retryAfter ?? 0) };
}

/** Records a failure on both buckets. */
export function recordLoginFail({ ip, account }) {
  failOf(ip);
  if (account) failOf(keyOf(account));
}

/** Success clears only the account bucket; the IP budget is never reset by a success. */
export function clearAccount(account) {
  attempts.delete(keyOf(account));
}

export function getClientIp(request) {
  // Trusted only when custom-server.js proves it stamped the header from the TCP socket;
  // otherwise a client could rotate the value to escape its own lockout bucket.
  if (hasTrustedPeerHeaders(request)) {
    const realIp = request.headers.get("x-9r-real-ip");
    if (realIp) return realIp;
  }
  // Behind a trusted reverse proxy: its own hop is the rightmost XFF entry. Anything to
  // the left came from the client when the proxy appends instead of overwriting.
  if (process.env.TRUST_PROXY === "true") {
    const xff = request.headers.get("x-forwarded-for");
    const hop = xff
      ?.split(",")
      .map((h) => h.trim())
      .filter(Boolean)
      .pop();
    if (hop) return hop;
  }
  // Direct exposure without custom-server: single bucket so spoofed XFF
  // rotation cannot escape the limiter.
  return "unknown";
}
