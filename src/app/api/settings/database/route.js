import { NextResponse } from "next/server";
import { exportDb, getSettings, importDb } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession";
import { hasValidCliToken } from "@/lib/auth/cliToken";
import { audit } from "@/lib/users/audit.js";
import { getClientIp } from "@/lib/auth/loginLimiter.js";
import { isCrossSite } from "@/lib/auth/sameOrigin.js";
import { isMultiUserEnabled } from "@/lib/users/featureSwitch.js";
import { can } from "@/lib/users/principal.js";
import { getPrincipal } from "@/lib/users/session";
import { PayloadTooLarge, payloadTooLarge, readJsonBody } from "@/lib/users/userManagement.js";
import {
  WORKSPACE_IMPORT_MAX_BODY,
  boundPassphrase,
  curatedTransferFailure,
  forceAllowed,
  isPassphraseFail,
  passphraseImportLock,
  recordPassphraseFail,
  reauthPrincipal,
  transferConflictFailure,
} from "@/lib/users/databaseTransfer.js";

const PASSWORD_HEADER = "x-9r-password";
const PASSPHRASE_HEADER = "x-tokenhop-backup-passphrase";
const NO_STORE = { "Cache-Control": "no-store" };
const json = (body, status = 200, headers = {}) =>
  NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });
// Instance snapshots land in the same 64 MiB envelope the workspace lane caps.
const INSTANCE_IMPORT_MAX_BODY = WORKSPACE_IMPORT_MAX_BODY;

// Snapshot errors the client may act on. Only allowlisted core-lane codes get
// a status; unknown coded errors answer a generic message (never raw internal
// diagnostics). `diff` (IMPORT_USER_MISMATCH) is metadata only, no secrets.
// Plain Errors without a code are the legacy core contract: curated messages.
const IMPORT_CODES = {
  FORBIDDEN: 403,
  PASSPHRASE_REQUIRED: 400,
  PASSPHRASE_INVALID: 400,
  TRANSFER_FORMAT_INVALID: 400,
  INVALID: 400,
};
function importFailure(err, legacy) {
  const code = typeof err?.code === "string" ? err.code : undefined;
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
  if (code === "TRANSFER_CONFLICT") return transferConflictFailure(err);
  const curated = curatedTransferFailure(code);
  if (curated) return curated;
  if (code && Object.hasOwn(IMPORT_CODES, code)) {
    const message =
      typeof err.message === "string" && err.message
        ? err.message.slice(0, 300)
        : "Failed to import database";
    return json({ error: message, code }, IMPORT_CODES[code]);
  }
  if (code) return json({ error: "Failed to import database" }, 400);
  // Legacy (switch off) keeps today's curated plain-Error messages; with
  // multi-user on, unknown messages are never echoed.
  const message =
    legacy && err instanceof Error && err.message
      ? err.message.slice(0, 300)
      : "Failed to import database";
  return json({ error: message }, 400);
}

/**
 * Who is asking. Switch off (no principal, not enforced): legacy auth, exactly
 * today's behavior. Switch on: an authenticated owner/admin principal; the
 * password re-auth below binds to THIS user, never the shared legacy hash.
 * @returns {Promise<{ legacy: true }|{ principal: object }|{ res: Response }>}
 */
async function authenticate(request) {
  let principal;
  try {
    principal = await getPrincipal();
  } catch (err) {
    if (err?.code === "API_KEY_STATE_INVALID") {
      return { res: json({ error: "Service unavailable" }, 503) };
    }
    principal = null;
  }
  if (!principal && !(await isMultiUserEnabled())) return { legacy: true };
  if (!principal) return { res: json({ error: "Unauthorized" }, 401) };
  if (isCrossSite(request))
    return { res: json({ error: "Forbidden", code: "forbidden_origin" }, 403) };
  // ADR-0002: owner/admin only (instance.hostOps); users and pending never.
  if (!can(principal, "instance.hostOps")) return { res: json({ error: "Forbidden" }, 403) };
  return { principal };
}

/** Password re-auth of the ACTING user (no CLI-token bypass once multi-user is on). */
async function reauth(request, principal, password) {
  return reauthPrincipal(request, principal, password, { instanceAdmin: true });
}

const actorOf = (principal) =>
  principal
    ? {
        userId: principal.userId,
        instanceRole: principal.instanceRole,
        owner: principal.instanceRole === "owner",
        via: principal.via,
      }
    : // Switch off: every authenticated caller is the single owner.
      { owner: true, via: "legacy" };

export async function GET(request) {
  let principal = null;
  try {
    const auth = await authenticate(request);
    if (auth.res) return auth.res;
    principal = auth.principal ?? null;
    if (auth.legacy) {
      if (
        !(await hasValidCliToken(request)) &&
        !(await verifyDashboardPassword(request.headers.get(PASSWORD_HEADER)))
      ) {
        return json({ error: "Invalid password" }, 401);
      }
    } else {
      const denied = await reauth(request, principal, request.headers.get(PASSWORD_HEADER));
      if (denied) return denied;
    }
    const passphrase = boundPassphrase(request.headers.get(PASSPHRASE_HEADER));
    if (passphrase === null) {
      return json({ error: "Invalid passphrase", code: "invalid_request" }, 400);
    }
    const payload = await exportDb(passphrase === undefined ? undefined : { passphrase });
    await audit(
      { principal, ip: getClientIp(request) },
      "db.export",
      { type: "database" },
      { after: { method: passphrase === undefined ? "plain" : "passphrase" } },
    );
    return json(payload);
  } catch (error) {
    console.log("Error exporting database:", error?.code || error?.message);
    await audit(
      { principal, ip: getClientIp(request) },
      "db.export",
      { type: "database" },
      { result: "failure", after: { reason: error?.code } },
    );
    return json({ error: "Failed to export database" }, 500);
  }
}

export async function POST(request) {
  let principal = null;
  let legacy = false;
  try {
    const auth = await authenticate(request);
    if (auth.res) return auth.res;
    principal = auth.principal ?? null;
    legacy = auth.legacy === true;
    let body;
    try {
      body = await readJsonBody(request, { max: INSTANCE_IMPORT_MAX_BODY });
    } catch (err) {
      if (err instanceof PayloadTooLarge) return payloadTooLarge();
      throw err;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      // A rejected body is still an import attempt: audit the failure event.
      await audit(
        { principal, ip: getClientIp(request) },
        "db.import",
        { type: "database" },
        { result: "failure", after: { reason: "invalid_request" } },
      );
      return json({ error: "Invalid request", code: "invalid_request" }, 400);
    }
    const { password, passphrase: rawPassphrase, force, ...payload } = body;
    const passphrase = boundPassphrase(rawPassphrase);
    if (passphrase === null || (force !== undefined && typeof force !== "boolean")) {
      return json({ error: "Invalid request", code: "invalid_request" }, 400);
    }
    if (auth.legacy) {
      if (!(await hasValidCliToken(request)) && !(await verifyDashboardPassword(password))) {
        return json({ error: "Invalid password" }, 401);
      }
    } else {
      const denied = await reauth(request, principal, password);
      if (denied) return denied;
    }
    // Only the instance owner may replace differing users (core re-checks).
    if (force === true && principal && !forceAllowed(principal, force)) {
      await audit(
        { principal, ip: getClientIp(request) },
        "db.import",
        { type: "database" },
        { result: "denied", after: { reason: "force_forbidden" } },
      );
      return json({ error: "Only the instance owner can force a restore", code: "FORBIDDEN" }, 403);
    }
    // Wrong passphrases cost a scrypt unwrap each: back off per IP first.
    const locked = passphraseImportLock(request);
    if (locked) return locked;
    // YAN-351: a restore must not flip the users & teams switch before its
    // release. Plain settings only: never rewrite an encrypted/sealed blob.
    const s = payload.settings;
    if (s && typeof s === "object" && !Array.isArray(s) && !("ct" in s) && !("iv" in s)) {
      delete s.multiUserEnabled;
    }
    await importDb(payload, {
      ...(passphrase === undefined ? {} : { passphrase }),
      ...(force === true ? { force: true } : {}),
      actor: actorOf(principal),
    });
    // A restore replaces custom models wholesale; reload their declared caps.
    await (await import("@/lib/customModelCaps")).refreshCustomModelCaps().catch(() => {});

    // Ensure proxy settings take effect immediately after a DB import.
    try {
      const settings = await getSettings();
      applyOutboundProxyEnv(settings);
    } catch (err) {
      console.warn("[Settings][DatabaseImport] Failed to re-apply outbound proxy env:", err);
    }
    // Imported combos/strategies decide quota polling (YAN-384).
    import("@/shared/services/quotaSnapshotPoller")
      .then(({ syncQuotaSnapshotPoller }) => syncQuotaSnapshotPoller())
      .catch((error) =>
        console.warn("[Settings][DatabaseImport] quota poller sync failed:", error?.message),
      );

    // YAN-367: audit the restore (actor = principal when multi-user, else null).
    await audit(
      { principal, ip: getClientIp(request) },
      "db.import",
      { type: "database" },
      { after: { method: passphrase === undefined ? "plain" : "passphrase" } },
    );

    return json({ success: true });
  } catch (error) {
    console.log("Error importing database:", error?.code || error?.message);
    await audit(
      { principal, ip: getClientIp(request) },
      "db.import",
      { type: "database" },
      { result: "failure", after: { reason: error?.code } },
    );
    if (isPassphraseFail(error)) recordPassphraseFail(request);
    return importFailure(error, legacy);
  }
}
