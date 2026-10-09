// YAN-375 (API/auth lane): auth-only helpers for the user-aware database and
// workspace transfer routes. No snapshot or crypto logic lives here — the
// core lane owns @/lib/db/index.js exportDb/importDb and
// @/lib/db/workspaceTransfer.js. This module proves the ACTING USER (never
// the instance owner's shared legacy password hash), binds the proof to
// their live sessionVersion, gates `force` to the instance owner, bounds the
// passphrase input, and lazy-binds the core workspace functions so this lane
// compiles before the core lane lands.
import { NextResponse } from "next/server";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";
import {
  accountKey,
  checkLoginLocks,
  clearAccount,
  getClientIp,
  recordLoginFail,
} from "@/lib/auth/loginLimiter.js";
import { verifyPassword } from "@/lib/auth/userPassword.js";
import { getUserPasswordHashUnscoped, getUserUnscoped } from "@/lib/db/repos/usersRepo.js";
import { listWorkspaces } from "@/lib/db/index.js";
import { TenancyError } from "./errors.js";
import { requireMultiUser } from "./featureSwitch.js";
import { can } from "./principal.js";
import { getPrincipal } from "./session.js";
import { audit } from "./audit.js";
import { isCrossSite, isJson } from "@/lib/auth/sameOrigin.js";
import { PayloadTooLarge, json, payloadTooLarge, readJsonBody } from "./userManagement.js";

// bcrypt silently truncates past 72 bytes; a real password could never be set
// longer (validateNewPassword rejects it), so over-cap proofs fail closed.
const MAX_PROOF_BYTES = 72;

// Bound the optional backup passphrase at the API trust boundary; the core
// lane enforces its own (possibly stricter) policy on top.
export const MAX_PASSPHRASE_BYTES = 1024;

const burn = async (pw) => {
  // Dummy-hash cover: unknown accounts cost the same as a wrong password.
  await verifyPassword(typeof pw === "string" ? pw : "", null);
};

/**
 * The caller's live sessionVersion claim (session principals only). CLI/local
 * principals are owner proofs by themselves and carry no sv to bind.
 * @param {{ headers: Headers, cookies?: { get(name: string): { value: string }|undefined } }} request
 * @param {import("./principal.js").Principal|null} principal
 * @returns {Promise<number|undefined>}
 */
export async function sessionVersionProof(request, principal) {
  if (principal?.via !== "session") return undefined;
  try {
    const claims = await getDashboardAuthSession(request?.cookies?.get?.("auth_token")?.value);
    return claims?.sub === principal.userId && typeof claims.sv === "number"
      ? claims.sv
      : undefined;
  } catch {
    return undefined; // no verified sv claim: the row check below fails closed
  }
}

/**
 * Verify the ACTING USER's current password against their own users row,
 * bound to their live sessionVersion — never the instance-wide legacy
 * password hash. SSO-only accounts fail closed (REAUTH_UNSUPPORTED; a fresh
 * SSO re-auth challenge is a follow-up issue).
 * @param {import("./principal.js").Principal} principal the acting principal
 * @param {unknown} password request-supplied password
 * @param {number|undefined} expectedSessionVersion live sv claim, when known
 * @param {{ instanceAdmin?: boolean }} [opts] instanceAdmin: the LIVE row must
 *   still be owner/admin (re-read after bcrypt, so a demotion during the hash
 *   window voids the proof)
 * @returns {Promise<object>} the live user row
 * @throws {TenancyError} REAUTH_REQUIRED | REAUTH_UNSUPPORTED | STALE | FORBIDDEN
 */
export async function verifyReauthPassword(
  principal,
  password,
  expectedSessionVersion,
  { instanceAdmin = false } = {},
) {
  const pw = typeof password === "string" ? password : "";
  const user = principal?.userId ? await getUserUnscoped(principal.userId) : null;
  if (user?.status !== "active" || user.instanceRole === "pending") {
    await burn(pw);
    throw new TenancyError("REAUTH_REQUIRED", "Invalid password");
  }
  // Live revalidation: a session principal MUST present a verified sv claim,
  // and it must match the live row. Role/status/membership changes bump sv,
  // so this is what re-checks the principal against the current DB state —
  // a missing claim fails closed, never open. CLI/local principals carry no
  // sv (they are direct owner proofs) and are validated by the live row only.
  if (principal?.via === "session" && !Number.isInteger(expectedSessionVersion)) {
    throw new TenancyError("STALE", "Session is out of date");
  }
  if (Number.isInteger(expectedSessionVersion) && user.sessionVersion !== expectedSessionVersion) {
    throw new TenancyError("STALE", "Session is out of date");
  }
  const hash = await getUserPasswordHashUnscoped(user.id);
  if (hash == null) {
    await burn(pw);
    throw new TenancyError(
      "REAUTH_UNSUPPORTED",
      "This account signs in with single sign-on and has no password",
    );
  }
  if (!pw || Buffer.byteLength(pw, "utf8") > MAX_PROOF_BYTES) {
    await burn(pw);
    throw new TenancyError("REAUTH_REQUIRED", "Invalid password");
  }
  if (!(await verifyPassword(pw, hash))) {
    throw new TenancyError("REAUTH_REQUIRED", "Invalid password");
  }
  // Re-read after the slow hash: sv/status/role changes during bcrypt void it.
  const fresh = await getUserUnscoped(user.id);
  if (fresh?.status !== "active" || fresh.sessionVersion !== user.sessionVersion) {
    throw new TenancyError("STALE", "Session is out of date");
  }
  if (instanceAdmin && fresh.instanceRole !== "owner" && fresh.instanceRole !== "admin") {
    throw new TenancyError("FORBIDDEN", "Only an instance owner or admin may do this");
  }
  return fresh;
}

/** Shared 429 shape for every loginLimiter lock. */
function tooManyAttempts(lock) {
  return NextResponse.json(
    {
      error: `Too many failed attempts. Try again in ${lock.retryAfter}s.`,
      code: "rate_limited",
      retryAfter: lock.retryAfter,
    },
    { status: 429, headers: { "Retry-After": String(lock.retryAfter) } },
  );
}

/**
 * Rate-limited password re-auth for a principal (same IP + account buckets as
 * login, checked before any bcrypt work). No CLI-token bypass: once the users
 * & teams switch is on, the acting principal re-proves their own password in
 * the same request regardless of how the request authenticated. Returns null
 * on success, else the error Response.
 * @param {Request} request
 * @param {import("./principal.js").Principal} principal
 * @param {unknown} password
 * @param {{ instanceAdmin?: boolean }} [opts] see verifyReauthPassword
 * @returns {Promise<Response|null>}
 */
export async function reauthPrincipal(request, principal, password, opts = {}) {
  const ip = getClientIp(request);
  const account = accountKey({ userId: principal.userId });
  const lock = checkLoginLocks({ ip, account });
  if (lock.locked) return tooManyAttempts(lock);
  try {
    await verifyReauthPassword(
      principal,
      password,
      await sessionVersionProof(request, principal),
      opts,
    );
  } catch (err) {
    if (err?.code === "REAUTH_REQUIRED") recordLoginFail({ ip, account });
    return reauthErrorResponse(err);
  }
  clearAccount(account);
  return null;
}

// Wrong-passphrase imports each cost a full scrypt unwrap in the core lane, so
// they back off on the existing per-IP loginLimiter bucket only (never the
// account's password bucket: a later good restore neither inherits nor clears
// a password lock). No passphrase material is ever logged.
const PASSPHRASE_FAIL_CODES = new Set(["PASSPHRASE_INVALID", "INSTANCE_PORTABLE_INVALID"]);

/** Is this core import error an expensive wrong-passphrase unwrap failure? */
export function isPassphraseFail(err) {
  return typeof err?.code === "string" && PASSPHRASE_FAIL_CODES.has(err.code);
}

/** 429 Response when the caller's IP is locked, else null. Run BEFORE the import. */
export function passphraseImportLock(request) {
  const lock = checkLoginLocks({ ip: getClientIp(request) });
  return lock.locked ? tooManyAttempts(lock) : null;
}

/** Record one expensive unwrap failure on the per-IP bucket. */
export function recordPassphraseFail(request) {
  recordLoginFail({ ip: getClientIp(request) });
}

/**
 * `force` is a request-only flag: explicit boolean true, and only the
 * instance owner may use it (replacing differing users on restore); the core
 * lane re-checks the actor. Every other shape is a plain non-forced restore.
 */
export function forceAllowed(principal, force) {
  return force === true && principal?.instanceRole === "owner";
}

/**
 * Bound the optional backup passphrase: absent (undefined/null/"") or a
 * non-empty string within the byte cap. Returns null when invalid.
 * @param {unknown} value
 * @returns {string|null|undefined}
 */
export function boundPassphrase(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return null;
  if (Buffer.byteLength(value, "utf8") > MAX_PASSPHRASE_BYTES) return null;
  return value;
}

/** Shared re-auth failure responses: structured, no secret material. */
export function reauthErrorResponse(err) {
  if (err?.code === "REAUTH_UNSUPPORTED") {
    return NextResponse.json(
      {
        error:
          "This account signs in with single sign-on and has no password, so password re-authentication is unavailable",
        code: "reauth_unsupported",
      },
      { status: 403 },
    );
  }
  if (err?.code === "FORBIDDEN") {
    return NextResponse.json({ error: "Forbidden", code: "forbidden" }, { status: 403 });
  }
  if (err?.code === "STALE") {
    return NextResponse.json(
      { error: "Session is out of date", code: "stale_session" },
      {
        status: 409,
      },
    );
  }
  return NextResponse.json({ error: "Invalid password", code: "reauth_required" }, { status: 401 });
}

// Lazy core binds (YAN-375 core lane): the workspace transfer module is
// loaded per request so this file stays import-valid before it lands.
const workspaceTransfer = () => import("@/lib/db/workspaceTransfer.js");

/** Export one workspace's snapshot; ciphertext passes through verbatim. */
export function exportWorkspaceSnapshot(ctx, workspaceId, opts) {
  return workspaceTransfer().then((m) => m.exportWorkspace(ctx, workspaceId, opts));
}

/** Import one workspace's snapshot. */
export function importWorkspaceSnapshot(ctx, workspaceId, payload, opts) {
  return workspaceTransfer().then((m) => m.importWorkspace(ctx, workspaceId, payload, opts));
}

const WS_CAP = "workspace.preferences.manage";
export const WORKSPACE_EXPORT_MAX_BODY = 4096;
// ponytail: fixed 64 MiB cap on the import body; stream to disk if snapshots outgrow it.
export const WORKSPACE_IMPORT_MAX_BODY = 64 * 1024 * 1024;

/**
 * Shared prelude for the workspace export/import routes. Order: hidden 404
 * (switch off) -> cross-site -> JSON -> full browser session -> live
 * membership + explicit workspace OWNERSHIP (never trusts a supplied
 * actor/role; the URL id is authoritative) -> bounded strict body -> password
 * re-auth against the acting user. Returns `{ res }` when denied, else
 * `{ principal, workspaceId, body }`.
 * @param {Request} request
 * @param {{ params: Promise<{ id: string }> }} ctx
 * @param {{ allowed: string[], maxBody: number, requireData?: boolean, action: string }} opts
 */
export async function workspaceTransferPrelude(request, { params }, opts) {
  const hidden = await requireMultiUser();
  if (hidden) return { res: hidden };
  if (isCrossSite(request))
    return { res: json({ error: "Forbidden", code: "forbidden_origin" }, 403) };
  if (!isJson(request)) {
    return { res: json({ error: "Unsupported media type", code: "invalid_request" }, 415) };
  }
  let principal;
  try {
    principal = await getPrincipal();
  } catch (err) {
    if (err?.code === "API_KEY_STATE_INVALID") {
      return { res: json({ error: "Service unavailable" }, 503) };
    }
    principal = null;
  }
  if (principal?.via !== "session") return { res: json({ error: "Unauthorized" }, 401) };
  const { id: workspaceId } = await params;
  const role = principal.workspaceRoles?.[workspaceId];
  // Non-member: same 404 as an unknown workspace (no existence leak).
  if (!role) return { res: json({ error: "Workspace not found", code: "not_found" }, 404) };
  if (role !== "owner" || !can(principal, WS_CAP, { workspaceId })) {
    audit(
      { principal, request, workspaceId },
      "auth.denied",
      { type: "capability", id: opts.action },
      { after: { capability: WS_CAP }, result: "denied" },
    );
    return { res: json({ error: "Forbidden" }, 403) };
  }

  let body;
  try {
    body = await readJsonBody(request, { max: opts.maxBody });
  } catch (err) {
    if (err instanceof PayloadTooLarge) return { res: payloadTooLarge() };
    return { res: json({ error: "Internal error" }, 500) };
  }
  const invalid = () => ({ res: json({ error: "Invalid request", code: "invalid_request" }, 400) });
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid();
  if (Object.keys(body).some((k) => !opts.allowed.includes(k))) return invalid();
  const passphrase = boundPassphrase(body.passphrase);
  if (typeof passphrase !== "string") return invalid(); // required, non-empty, bounded
  if (typeof body.password !== "string") return invalid();
  if (
    opts.requireData &&
    (!body.data || typeof body.data !== "object" || Array.isArray(body.data))
  ) {
    return invalid();
  }

  const denied = await reauthPrincipal(request, principal, body.password);
  if (denied) return { res: denied };
  // Re-check LIVE ownership after the slow hash: a demotion/removal during the
  // bcrypt window must not slip through on the pre-hash principal.
  const live = await listWorkspaces({ userId: principal.userId });
  if (live.find((w) => w.id === workspaceId)?.role !== "owner") {
    return { res: json({ error: "Workspace not found", code: "not_found" }, 404) };
  }
  return { principal, workspaceId, body: { ...body, passphrase } };
}

// Allowlisted core-lane codes -> HTTP status. Only these (plus the mismatch
// diff, metadata) reach the client; unknown coded errors never leak internal
// diagnostics.
const TRANSFER_CODES = {
  FORBIDDEN: 403,
  PASSPHRASE_REQUIRED: 400,
  PASSPHRASE_INVALID: 400,
  TRANSFER_FORMAT_INVALID: 400,
  INVALID: 400,
};

// Fixed, curated 400 texts: the core message is never echoed for these codes.
export const CURATED_TRANSFER_ERRORS = {
  INSTANCE_PORTABLE_INVALID: "Backup is not a valid instance snapshot",
  TRANSFER_PASSPHRASE_REQUIRED: "A passphrase is required for this snapshot",
  TRANSFER_ROOT_MISMATCH: "Snapshot does not match this instance",
  TRANSFER_PORTABLE_UNSUPPORTED: "Snapshot format is not supported",
};
const MAX_CONFLICTS = 16;
const MAX_CONFLICT_CHARS = 200;

/** Curated 400 for a core transfer code, else null. */
export function curatedTransferFailure(code) {
  return Object.hasOwn(CURATED_TRANSFER_ERRORS, code)
    ? json({ error: CURATED_TRANSFER_ERRORS[code], code }, 400)
    : null;
}

/** TRANSFER_CONFLICT -> 409: fixed message + at most 16 strings of <=200 chars. */
export function transferConflictFailure(err) {
  const conflicts = Array.isArray(err?.conflicts)
    ? err.conflicts
        .filter((c) => typeof c === "string")
        .slice(0, MAX_CONFLICTS)
        .map((c) => c.slice(0, MAX_CONFLICT_CHARS))
    : [];
  return json(
    { error: "Snapshot conflicts with existing data", code: "TRANSFER_CONFLICT", conflicts },
    409,
  );
}

/** Structured, secret-free failure for core transfer errors. */
export function transferFailure(err) {
  const code = typeof err?.code === "string" ? err.code : undefined;
  if (code === "NOT_FOUND") return json({ error: "Workspace not found", code: "not_found" }, 404);
  if (code === "TRANSFER_CONFLICT") return transferConflictFailure(err);
  const curated = curatedTransferFailure(code);
  if (curated) return curated;
  if (code === "IMPORT_USER_MISMATCH") {
    return json(
      {
        error: "Backup users differ from this instance",
        code,
        ...(err.diff ? { diff: err.diff } : {}),
      },
      409,
    );
  }
  if (code && Object.hasOwn(TRANSFER_CODES, code)) {
    return json({ error: safeText(err.message), code }, TRANSFER_CODES[code]);
  }
  if (code) return json({ error: "Transfer failed" }, 400);
  return json({ error: "Internal error" }, 500);
}

/** Curated plain-text only, length-capped; anything else becomes generic. */
function safeText(message) {
  return typeof message === "string" && message ? message.slice(0, 300) : "Transfer failed";
}

/** Safe `Content-Disposition` filename for a workspace snapshot. */
export function workspaceFilename(workspaceId, now = new Date()) {
  const id =
    String(workspaceId)
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 40) || "workspace";
  return `tokenhop-workspace-${id}-${now.toISOString().replace(/[.:]/g, "-")}.json`;
}
