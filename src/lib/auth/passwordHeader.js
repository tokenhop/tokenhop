// Password transport headers, server side (release/1.1 minimal port of the
// #978 / YAN-1248 helper that lives in src/lib/users/snapshotUpload.js on
// master; that module belongs to the snapshot-streaming feature and is not on
// this branch). The client-side mirror is
// src/app/(dashboard)/dashboard/settings/sections/backupShared.js (a client
// module that must not be imported from server code).
// Legacy ASCII-only header (CLI/e2e callers). HTTP header values are Latin-1
// bytes, so a non-ASCII password sent here arrives mangled (U+00FF, trimmed
// whitespace). Browsers send PASSWORD_B64_HEADER instead.
export const PASSWORD_HEADER = "x-9r-password";
// base64url(UTF-8(password)): lossless for any password.
export const PASSWORD_B64_HEADER = "x-tokenhop-password-b64";

const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/**
 * The password a request carries in its headers. `x-tokenhop-password-b64`
 * (base64url of the UTF-8 password) wins over the legacy `x-9r-password`.
 * A malformed b64 value is `{ invalid: true }` (never silently the wrong password).
 * @param {Headers} headers
 * @returns {{ value: string|null } | { invalid: true }}
 */
export function readPasswordHeader(headers) {
  const b64 = headers.get(PASSWORD_B64_HEADER);
  if (b64 === null) return { value: headers.get(PASSWORD_HEADER) };
  if (!B64URL_RE.test(b64) || b64.length % 4 === 1) return { invalid: true };
  try {
    return {
      // ignoreBOM: a leading U+FEFF is part of the password, not a BOM.
      value: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        Buffer.from(b64, "base64url"),
      ),
    };
  } catch {
    return { invalid: true };
  }
}
