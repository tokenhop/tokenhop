import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir";
import { getLegacyPasswordHash, getSettings } from "@/lib/db/index.js";

const DEFAULT_PASSWORD = "123456";
const SESSION_MAX_AGE_SEC = 24 * 60 * 60;

function loadJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(DATA_DIR, "jwt-secret");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

const SECRET = new TextEncoder().encode(loadJwtSecret());

/**
 * 32-byte key derived from the session secret for one named purpose, so
 * other sealed values (e.g. the SSO invite cookie) never share the session
 * signing key. The secret itself never leaves this module.
 * @param {string} purpose
 */
export function deriveSecretKey(purpose) {
  return crypto.createHmac("sha256", SECRET).update(`tokenhop:${purpose}`).digest();
}

export function shouldUseSecureCookie(request) {
  const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
  const forwardedProto = request?.headers?.get?.("x-forwarded-proto");
  const isHttpsRequest = forwardedProto === "https";
  return forceSecureCookie || isHttpsRequest;
}

export async function createDashboardAuthToken(claims = {}, expiration = "24h") {
  return new SignJWT({ authenticated: true, ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiration)
    .sign(SECRET);
}

// Signature + expiry only; no purpose filtering. Callers must enforce claims.
export async function readSignedAuthToken(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SECRET, { algorithms: ["HS256"] });
    return payload;
  } catch {
    return null;
  }
}

// Full dashboard sessions only: purpose-scoped or unauthenticated tokens never qualify.
async function readFullSession(token) {
  const payload = await readSignedAuthToken(token);
  if (!payload || payload.purpose || payload.authenticated === false) return null;
  return payload;
}

export async function verifyDashboardAuthToken(token) {
  return (await readFullSession(token)) !== null;
}

export async function getDashboardAuthSession(token) {
  return readFullSession(token);
}

/**
 * `exp` (epoch seconds) keeps an existing session's expiry (workspace switch,
 * identity unlink re-mint): the new token never outlives the old one.
 */
export async function setDashboardAuthCookie(cookieStore, request, claims = {}, { exp } = {}) {
  const keepExp = Number.isInteger(exp);
  const token = await createDashboardAuthToken(claims, keepExp ? exp : "24h");
  cookieStore.set("auth_token", token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(request),
    sameSite: "lax",
    path: "/",
    maxAge: keepExp ? Math.max(0, exp - Math.floor(Date.now() / 1000)) : SESSION_MAX_AGE_SEC,
  });
}

export function clearDashboardAuthCookie(cookieStore) {
  cookieStore.delete("auth_token");
}

// Verify the current dashboard password (re-auth for sensitive actions).
export async function verifyDashboardPassword(password) {
  if (typeof password !== "string" || !password) return false;
  const settings = await getSettings();
  // YAN-362: the hash lives in users.passwordHash once bootstrapped; the blob
  // key is the legacy store getLegacyPasswordHash falls back to.
  const storedHash = await getLegacyPasswordHash(settings);
  if (storedHash) return bcrypt.compare(password, storedHash);
  const initialPassword = process.env.INITIAL_PASSWORD || DEFAULT_PASSWORD;
  return password === initialPassword;
}
