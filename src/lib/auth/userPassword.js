// YAN-358 password helpers: new-password policy, async bcrypt, login lookup.
// All bcrypt work is async; never use *Sync on the request path.
import bcrypt from "bcryptjs";
import { findUsersByLoginUnscoped } from "../db/index.js";

// ponytail: min 8 code points; raise to 15 when NIST/OWASP single-factor guidance is adopted.
export const MIN_PASSWORD_LENGTH = 8;
export const DEFAULT_PASSWORD = "123456";
// Valid cost-10 hash (matches bcrypt.genSalt(10) in settings route); compared
// against for unknown/passwordless accounts so timing matches a real check.
export const DUMMY_HASH = "$2b$10$maUNk5tLUAmdidX5dRsQKueBpGd3eSvGPVmLbLoQVUk2tx5GEHqNK";

const BCRYPT_HASH_RE = /^\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{53}$/;

const reject = (code, error) => ({ code, error });

/**
 * New/temporary password policy. Returns null when acceptable, else {code,error}.
 * No trimming, no composition rules; never silently truncates (bcrypt 72 bytes).
 * @param {unknown} pw
 * @param {{ current?: string|null, temporary?: string|null }} [opts]
 */
export function validateNewPassword(pw, { current, temporary } = {}) {
  if (typeof pw !== "string") return reject("password_too_short", "Password is required.");
  if ([...pw].length < MIN_PASSWORD_LENGTH) {
    return reject(
      "password_too_short",
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  if (bcrypt.truncates(pw)) {
    return reject("password_too_long", "Password must be at most 72 bytes.");
  }
  if (pw === current || pw === temporary) {
    return reject("password_reused", "Choose a different password.");
  }
  if (pw === process.env.INITIAL_PASSWORD || pw === DEFAULT_PASSWORD) {
    return reject("password_default", "Choose a password other than the default.");
  }
  return null;
}

/**
 * Async compare. Missing/invalid hash still runs a real compare (dummy) and
 * returns false, so unknown accounts cost the same as wrong passwords.
 */
export async function verifyPassword(pw, hash) {
  const valid = typeof hash === "string" && BCRYPT_HASH_RE.test(hash);
  const input = typeof pw === "string" ? pw : "";
  const ok = await bcrypt.compare(input, valid ? hash : DUMMY_HASH);
  return valid && typeof pw === "string" && ok;
}

export const hashPassword = (pw) => bcrypt.hash(pw, 10);

/** Exactly one matching user, else null (unknown or ambiguous identifier). */
export async function resolveLoginUser(login) {
  const rows = await findUsersByLoginUnscoped(login);
  return rows.length === 1 ? rows[0] : null;
}
