import { ACTIVE } from "@/shared/brand";

export const PASSPHRASE_HEADER = "x-tokenhop-backup-passphrase";
export const WORKSPACE_EXPORT_TYPE = "tokenhop.workspaceExport";
export const WORKSPACE_EXPORT_VERSION = 1;
export const MISMATCH_CODE = "IMPORT_USER_MISMATCH";
export const FORCE_PHRASE = "REPLACE USERS";

/** Existing `tokenhop-backup-<stamp>.json` name; `infix` tags non-instance files. */
export function backupFileName(infix = "") {
  const stamp = new Date().toISOString().replace(/[.:]/g, "-");
  return `${ACTIVE.backupFilePrefix}${infix}${stamp}.json`;
}

export function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
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
