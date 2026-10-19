import { Readable } from "node:stream";
import { readEnv } from "@/shared/brand";

// Header helpers for the raw (streamed) instance snapshot upload/download.
// The header names below mirror `src/app/api/settings/database/route.js`
// (where they are module-private) and `settings/sections/backupShared.js`
// (a client module that must not be imported from server code).
export const UPLOAD_MODE_HEADER = "x-tokenhop-snapshot-upload";
export const FORCE_HEADER = "x-tokenhop-import-force";
export const PASSWORD_HEADER = "x-9r-password";
export const SSO_PROOF_HEADER = "x-tokenhop-sso-proof";
export const PASSPHRASE_HEADER = "x-tokenhop-backup-passphrase";

// Same default as next.config.mjs `proxyClientMaxBodySize`.
const DEFAULT_PROXY_LIMIT = "128mb";

const UNITS = Object.freeze({
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
  pb: 1024 ** 5,
});
const SIZE_RE = /^(\d+(?:\.\d+)?) *(b|kb|mb|gb|tb|pb)?$/i;

/**
 * Parse a byte size like Next's `bytes` grammar (`"128mb"`, `"1.5gb"`,
 * `"1048576"`, case-insensitive, binary units). Strict: anything else, zero or
 * negative values and non-finite numbers return `null`.
 * @param {unknown} input
 * @returns {number|null}
 */
export function parseByteSize(input) {
  if (typeof input === "number") {
    return Number.isFinite(input) && input >= 1 ? Math.floor(input) : null;
  }
  if (typeof input !== "string") return null;
  const match = SIZE_RE.exec(input.trim());
  if (!match) return null;
  const bytes = Math.floor(Number(match[1]) * UNITS[(match[2] ?? "b").toLowerCase()]);
  return Number.isSafeInteger(bytes) && bytes >= 1 ? bytes : null;
}

/**
 * Body cap for the streamed instance import:
 * `min(TOKENHOP_INSTANCE_IMPORT_MAX_BODY_SIZE ?? proxyLimit, proxyLimit)` where
 * `proxyLimit` is `TOKENHOP_PROXY_CLIENT_MAX_BODY_SIZE` (default 128mb). Next's
 * proxy silently truncates bodies above its limit, so we never accept more.
 * An unparseable override falls back to the proxy limit.
 * @param {Record<string, string|undefined>} [env]
 * @returns {number}
 */
export function instanceStreamImportCap(env = process.env) {
  const proxyLimit =
    parseByteSize(readEnv("PROXY_CLIENT_MAX_BODY_SIZE", env) || DEFAULT_PROXY_LIMIT) ??
    parseByteSize(DEFAULT_PROXY_LIMIT);
  const override = parseByteSize(readEnv("INSTANCE_IMPORT_MAX_BODY_SIZE", env));
  return override === null ? proxyLimit : Math.min(override, proxyLimit);
}

/**
 * Auth + force carried in request headers (the raw body is the snapshot file
 * itself). Absent headers yield `null` (`force: false`); values are returned
 * as received: bounding/validation stays with the caller. `force` is `true`
 * only for the exact value `"true"`; any other present value returns
 * `{ invalid: true }`.
 * @param {Request} request
 * @returns {{ password: string|null, ssoProof: string|null, passphrase: string|null, force: boolean } | { invalid: true }}
 */
export function readHeaderImportAuth(request) {
  const h = request.headers;
  const forceRaw = h.get(FORCE_HEADER);
  if (forceRaw !== null && forceRaw !== "true") return { invalid: true };
  return {
    password: h.get(PASSWORD_HEADER),
    ssoProof: h.get(SSO_PROOF_HEADER),
    passphrase: h.get(PASSPHRASE_HEADER),
    force: forceRaw === "true",
  };
}

/**
 * Stream an exported snapshot file as the HTTP response.
 * @param {{ size: number, openStream: () => import("node:stream").Readable }} handle
 * @param {HeadersInit} [headers] extra headers (the download headers always win)
 * @returns {Response}
 */
export function snapshotDownloadResponse(handle, headers = {}) {
  const out = new Headers(headers);
  out.set("Content-Type", "application/json; charset=utf-8");
  out.set("Content-Length", String(handle.size));
  out.set("Cache-Control", "no-store");
  return new Response(Readable.toWeb(handle.openStream()), { status: 200, headers: out });
}
