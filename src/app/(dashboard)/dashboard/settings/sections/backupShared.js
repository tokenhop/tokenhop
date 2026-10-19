import { ACTIVE } from "@/shared/brand";
import { readSnapshotHead } from "@/shared/utils/snapshotJsonSplitter";

export const PASSPHRASE_HEADER = "x-tokenhop-backup-passphrase";
// Raw (streamed) instance upload: the body is the backup file itself and the
// auth travels in headers. Mirrors src/lib/users/snapshotUpload.js (server code,
// not importable here).
export const UPLOAD_MODE_HEADER = "x-tokenhop-snapshot-upload";
export const FORCE_HEADER = "x-tokenhop-import-force";
export const PASSWORD_HEADER = "x-9r-password";
export const WORKSPACE_EXPORT_TYPE = "tokenhop.workspaceExport";
export const WORKSPACE_EXPORT_VERSION = 1;
export const MISMATCH_CODE = "IMPORT_USER_MISMATCH";
export const FORCE_PHRASE = "REPLACE USERS";

/** Existing `tokenhop-backup-<stamp>.json` name; `infix` tags non-instance files. */
export function backupFileName(infix = "") {
  const stamp = new Date().toISOString().replace(/[.:]/g, "-");
  return `${ACTIVE.backupFilePrefix}${infix}${stamp}.json`;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export function downloadJson(payload, filename) {
  downloadBlob(
    new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
    filename,
  );
}

/** Top-level keys `readBackupEnvelope` reads; the preview needs nothing else. */
export const ENVELOPE_KEYS = [
  "formatVersion",
  "schemaVersion",
  "apiKeyStorage",
  "credentialEncryption",
  "workspaceKeys",
];

/**
 * Envelope-only view of a picked backup: streams the file and keeps just the
 * head keys above (memory is O(head), never the whole snapshot).
 */
export async function readSnapshotEnvelopeSource(file) {
  try {
    return await readSnapshotHead(file.stream(), { keys: ENVELOPE_KEYS });
  } catch {
    throw new Error("This file is not valid JSON.");
  }
}

/** Parse a picked file as JSON with a readable failure. */
export async function readJsonFile(file) {
  try {
    return JSON.parse(await file.text());
  } catch {
    throw new Error("This file is not valid JSON.");
  }
}

/** The passphrase travels in an HTTP header on instance export: printable ASCII only. */
export function isHeaderSafe(value) {
  return /^[\x20-\x7e]*$/.test(value);
}

/** Error carrying the server's `code` and `diff` so callers can branch on 409s. */
export function apiError(res, data, fallback) {
  const raw = data?.error;
  const err = new Error((typeof raw === "string" ? raw : raw?.message) || fallback);
  err.status = res.status;
  err.code = data?.code ?? raw?.code ?? null;
  err.diff = data?.diff ?? raw?.diff ?? data?.details?.diff ?? null;
  return err;
}

export function isMismatchError(err) {
  return err?.status === 409 && err?.code === MISMATCH_CODE;
}

/** Validate the passphrase pair of a "set a passphrase" form; returns an error string or "". */
export function passphraseProblem(passphrase, confirm, { headerSafe }) {
  if (!passphrase) return "";
  if (headerSafe && !isHeaderSafe(passphrase)) {
    return "Use printable ASCII characters only in the passphrase.";
  }
  if (passphrase !== confirm) return "The passphrases do not match.";
  return "";
}

/**
 * Instance restore request headers. The body is the raw backup file, so the
 * file can never carry request control: everything here comes from `auth` /
 * `forceArmed` only (exactly one of a one-time `ssoProof` OR the actor
 * password, the passphrase only when typed, `force` only when explicitly armed).
 */
export function instanceImportHeaders(auth, forceArmed) {
  const headers = { "Content-Type": "application/json", [UPLOAD_MODE_HEADER]: "raw" };
  if (typeof auth.ssoProof === "string" && auth.ssoProof) headers[SSO_PROOF_HEADER] = auth.ssoProof;
  else headers[PASSWORD_HEADER] = auth.password;
  if (auth.passphrase) headers[PASSPHRASE_HEADER] = auth.passphrase;
  if (forceArmed) headers[FORCE_HEADER] = "true";
  return headers;
}

// ── YAN-1012: fresh single sign-on check for backup export/import ─────────
// The proof is a one-time secret: it only ever lives in dialog state and in
// the request that spends it. Never stored, logged or put in a URL.

export const SSO_PROOF_HEADER = "x-tokenhop-sso-proof";
export const DATA_ACTIONS = [
  "instance.export",
  "instance.import",
  "workspace.export",
  "workspace.import",
];

/** A proof is present, or (outside an SSO-started attempt) a password is typed. */
export const hasProof = (auth) =>
  auth.ssoProof ? true : auth.ssoOnly ? false : Boolean(auth.password);

/** Exactly one of `ssoProof` / `password` for a JSON request body. */
export const proofFields = (auth) =>
  auth.ssoProof ? { ssoProof: auth.ssoProof } : { password: auth.password };

async function reauthRequest(url, init, fallback) {
  const res = await fetch(url, { cache: "no-store", ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw apiError(res, data, fallback);
  return data;
}

/** Start a fresh provider sign-in bound to one backup action → `{ authorizeUrl }`. */
export function startDataReauth({ provider, action, workspaceId = null }) {
  const body = { provider, action };
  if (workspaceId) body.workspaceId = workspaceId;
  return reauthRequest(
    "/api/me/reauth",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    "Could not start single sign-on.",
  );
}

/** Collect the completed check ONCE → `{ ssoProof }`; the server rejects a second call. */
export function consumeDataReauth({ action, workspaceId = null }) {
  const query = new URLSearchParams({ action });
  if (workspaceId) query.set("workspaceId", workspaceId);
  return reauthRequest(`/api/me/reauth?${query}`, {}, "No completed single sign-on check.");
}

/** Only http(s) provider URLs are followed (never javascript:, data:, …). */
export function safeAuthorizeUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const START_ERRORS = {
  sso_not_linked: "Your account is not linked to that provider.",
  sso_unavailable: "That provider is not available on this instance.",
  rate_limited: "Too many attempts. Wait a moment and try again.",
};

export const startErrorText = (err) =>
  START_ERRORS[err?.code] || err?.message || "Could not start single sign-on.";

/** Dialog copy for a failed export/import; `usedSso` picks the no-fallback wording. */
export function reauthErrorText(err, usedSso, fallback) {
  if (err?.status === 401 || err?.code === "reauth_required") {
    return usedSso
      ? "Your single sign-on check expired or was already used. Verify again."
      : err?.message || fallback;
  }
  if (err?.code === "reauth_unsupported") {
    return "Your account has no password. Verify with single sign-on instead.";
  }
  if (err?.code === "stale_session") return "Your session is out of date. Sign in again.";
  return err?.message || fallback;
}

const asList = (value) => (Array.isArray(value) ? value : []);

/** One user line from a diff entry (string or object, any of email/username/id). */
export function describeDiffEntry(entry) {
  if (typeof entry === "string") return { label: entry, detail: "" };
  if (!entry || typeof entry !== "object") return { label: String(entry ?? ""), detail: "" };
  const label =
    entry.email || entry.username || entry.displayName || entry.name || entry.id || "Unknown user";
  const from = entry.previousInstanceRole ?? entry.from ?? entry.instanceRole ?? entry.current;
  const to = entry.instanceRole ?? entry.to ?? entry.backupRole ?? entry.backup ?? entry.role;
  const detail = from && to && from !== to ? `${from} → ${to}` : entry.role || "";
  return { label: String(label), detail: String(detail) };
}

export function normalizeDiff(diff) {
  return {
    onlyInBackup: asList(diff?.onlyInBackup),
    onlyInInstance: asList(diff?.onlyInInstance),
    roleChanged: asList(diff?.roleChanged),
  };
}
